import ExpoModulesCore

// SSH local port forwarding for Shahi.
//
// `ssh -L <localPort>:<remoteHost>:<remotePort> user@host`, driven from the
// app. The whole thing — connect, handshake, auth, and the forward — lives in
// `SshForwarder` (Objective-C), which is libssh2 and BSD sockets end to end;
// ObjC imports libssh2.h without the Swift module-map dance. The app then
// points its ordinary fetch and WebSocket at 127.0.0.1:<localPort> and never
// knows SSH is underneath. This module just marshals the config across and
// keeps a single forwarder alive.

public class SshTunnelModule: Module {
  private var tunnel: Tunnel?

  public func definition() -> ModuleDefinition {
    Name("SshTunnel")

    AsyncFunction("open") { (config: OpenConfig, promise: Promise) in
      // One tunnel at a time: a new open replaces any old one, so a reconnect
      // never leaks a listener or a session.
      self.tunnel?.close()
      let tunnel = Tunnel()
      self.tunnel = tunnel
      tunnel.open(config) { result in
        switch result {
        case .success(let opened):
          // Hand back the host-key fingerprint so JS can store it (first use)
          // or confirm it matched — see lib/tunnel.ts.
          promise.resolve(["localPort": opened.localPort, "hostKey": opened.hostKey as Any])
        case .failure(let error):
          self.tunnel = nil
          promise.reject("ssh_tunnel", error.message)
        }
      }
    }

    AsyncFunction("close") { (promise: Promise) in
      self.tunnel?.close()
      self.tunnel = nil
      promise.resolve(nil)
    }

    OnDestroy {
      self.tunnel?.close()
      self.tunnel = nil
    }
  }
}

struct OpenConfig: Record {
  @Field var host: String
  @Field var port: Int = 22
  @Field var username: String
  @Field var password: String?
  @Field var privateKey: String?
  @Field var passphrase: String?
  /** The SHA-256 host-key fingerprint remembered from a previous connection. */
  @Field var expectedHostKey: String?
  @Field var remoteHost: String = "127.0.0.1"
  @Field var remotePort: Int
}

struct TunnelError: Error { let message: String }
struct Opened { let localPort: Int; let hostKey: String? }

final class Tunnel {
  private var forwarder: SshForwarder?
  private let queue = DispatchQueue(label: "shahi.ssh-tunnel", qos: .userInitiated)

  func open(_ config: OpenConfig, completion: @escaping (Result<Opened, TunnelError>) -> Void) {
    queue.async {
      // The forwarder does everything synchronously — connect, handshake, verify
      // the host key, auth, then bind a local port (0 → the OS picks a free one)
      // and splice each accepted connection to its own direct-tcpip channel.
      // Separate channels mean the sidecar's WebSocket and its HTTP polls
      // multiplex over the one session exactly as a real `-L` forward does.
      let forwarder = SshForwarder(
        host: config.host,
        port: Int32(config.port),
        username: config.username,
        password: config.password,
        privateKey: config.privateKey,
        passphrase: config.passphrase,
        expectedHostKey: config.expectedHostKey,
        remoteHost: config.remoteHost,
        remotePort: Int32(config.remotePort)
      )
      self.forwarder = forwarder
      do {
        let localPort = try forwarder.start()
        completion(.success(Opened(localPort: localPort.intValue, hostKey: forwarder.hostKeyFingerprint)))
      } catch {
        self.forwarder = nil
        completion(.failure(TunnelError(message: (error as NSError).localizedDescription)))
      }
    }
  }

  func close() {
    forwarder?.stop()
    forwarder = nil
  }
}
