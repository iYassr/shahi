import ExpoModulesCore

// SSH local port forwarding for Shahi.
//
// `ssh -L <localPort>:<remoteHost>:<remotePort> user@host`, driven from the
// app. The whole thing — connect, handshake, auth, and the forward — lives in
// `SshForwarder` (Objective-C), which is libssh2 and BSD sockets end to end;
// ObjC imports libssh2.h without the Swift module-map dance. The app then
// points its ordinary fetch and WebSocket at 127.0.0.1:<localPort> and never
// knows SSH is underneath. This module just marshals the config across and
// keeps each forward alive under the id the app gave it.

public class SshTunnelModule: Module {
  private var tunnels: [String: Tunnel] = [:]
  private let queue = DispatchQueue(label: "shahi.ssh-tunnel", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("SshTunnel")

    // The server's host key, from a handshake that sends no user name and no
    // credential, so the app can show its fingerprint before a login goes
    // anywhere (see lib/tunnel.ts). Off the tunnels' queue: a slow or silent
    // host must not hold up opening or closing another computer's forward.
    AsyncFunction("hostKey") { (config: HostKeyConfig, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try SshForwarder.hostKey(forHost: config.host, port: Int32(config.port)))
        } catch {
          promise.reject(TunnelException(TunnelError(message: (error as NSError).localizedDescription)))
        }
      }
    }

    AsyncFunction("open") { (config: OpenConfig, promise: Promise) in
      self.queue.async {
        // Reconnecting one computer must not interrupt the other forwards.
        self.tunnels[config.id]?.close()
        let tunnel = Tunnel()
        self.tunnels[config.id] = tunnel
        tunnel.open(config) { result in
          switch result {
          case .success(let localPort):
            promise.resolve(["localPort": localPort])
          case .failure(let error):
            self.tunnels.removeValue(forKey: config.id)
            promise.reject(TunnelException(error))
          }
        }
      }
    }

    AsyncFunction("close") { (id: String?, promise: Promise) in
      self.queue.async {
        if let id = id { self.tunnels.removeValue(forKey: id)?.close() }
        else { self.tunnels.values.forEach { $0.close() }; self.tunnels.removeAll() }
        promise.resolve(nil)
      }
    }

    OnDestroy {
      self.queue.async {
        self.tunnels.values.forEach { $0.close() }
        self.tunnels.removeAll()
      }
    }
  }
}

struct HostKeyConfig: Record {
  @Field var host: String
  @Field var port: Int = 22
}

struct OpenConfig: Record {
  @Field var id: String
  @Field var host: String
  @Field var port: Int = 22
  @Field var username: String
  @Field var password: String?
  @Field var privateKey: String?
  @Field var passphrase: String?
  /**
   * The SHA-256 host key the person trusted, as `hostKey` returned it.
   * SshForwarder refuses to authenticate without it or on any other key.
   */
  @Field var expectedHostKey: String?
  @Field var remoteHost: String = "127.0.0.1"
  @Field var remotePort: Int
}

struct TunnelError: Error { let message: String; var code = "ssh_tunnel" }

/**
 * A failure in SshForwarder's own words, as JavaScript receives it.
 *
 * `promise.reject(code, description)` reached JavaScript as "ssh_tunnel:
 * undefined reason": Expo builds the message from `reason`, which only a
 * subclass sets, so every native explanation ("Authentication failed…", "host
 * key has changed…") was replaced by the app's generic fallback. Seen on a
 * simulator in the pre-release review. Each refusal no retry fixes has its own
 * code — a host key (`ssh_host_key`), a login (`ssh_login`) — so the app says
 * what to check rather than "reconnecting", and a saved computer does not
 * repeat it on a timer.
 */
final class TunnelException: Exception, @unchecked Sendable {
  private let message: String
  private let failure: String
  init(_ error: TunnelError) {
    message = error.message
    failure = error.code
    super.init()
    name = code
  }
  override var reason: String { message }
  override var code: String { failure }
}

final class Tunnel {
  private var forwarder: SshForwarder?

  func open(_ config: OpenConfig, completion: @escaping (Result<Int, TunnelError>) -> Void) {
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
      completion(.success(localPort.intValue))
    } catch {
      forwarder.stop()
      self.forwarder = nil
      let failure = error as NSError
      var code = "ssh_tunnel"
      if failure.domain == "SshForwarder" {
        switch failure.code {
        case SshForwarderHostKeyRefused: code = "ssh_host_key"
        case SshForwarderLoginRefused: code = "ssh_login"
        default: break
        }
      }
      completion(.failure(TunnelError(message: failure.localizedDescription, code: code)))
    }
  }

  func close() {
    forwarder?.stop()
    forwarder = nil
  }
}
