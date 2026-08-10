import ExpoModulesCore
import NMSSH

// SSH local port forwarding for Shahi.
//
// `ssh -L <localPort>:<remoteHost>:<remotePort> user@host`, driven from the
// app. NMSSH owns the session and both auth modes (it vendors libssh2 +
// OpenSSL and is App Store proven). The forward itself — a local TCP listener
// whose every connection is spliced to a libssh2 direct-tcpip channel over
// that session — lives in `SshForwarder` (Objective-C), because that side is C
// interop with libssh2 and BSD sockets and ObjC imports libssh2.h without the
// Swift module-map dance. The app then points its ordinary fetch and WebSocket
// at 127.0.0.1:<localPort> and never knows SSH is underneath.
//
// VERIFY ON DEVICE: this compiles and runs only in a native build. The one
// seam that leans on an NMSSH internal is `SshForwarder`'s use of the raw
// `LIBSSH2_SESSION` — NMSSH exposes it as `rawSession`, but the accessor has
// moved between releases; if the build fails there, that is why.

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
        case .success(let localPort):
          promise.resolve(["localPort": localPort])
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
  @Field var remoteHost: String = "127.0.0.1"
  @Field var remotePort: Int
}

struct TunnelError: Error { let message: String }

final class Tunnel {
  private var session: NMSSHSession?
  private var forwarder: SshForwarder?
  private let queue = DispatchQueue(label: "shahi.ssh-tunnel", qos: .userInitiated)

  func open(_ config: OpenConfig, completion: @escaping (Result<Int, TunnelError>) -> Void) {
    queue.async {
      // 1. Connect + authenticate. NMSSH is synchronous, hence the queue.
      let session = NMSSHSession(host: config.host, port: config.port, andUsername: config.username)
      session.connect()
      guard session.isConnected else {
        completion(.failure(TunnelError(message: "Could not reach \(config.host):\(config.port).")))
        return
      }

      if let key = config.privateKey, !key.isEmpty {
        // From memory, not a file on disk — the key lives in the Keychain and
        // is handed straight to libssh2.
        session.authenticate(byInMemoryPublicKey: nil, privateKey: key, andPassword: config.passphrase ?? "")
      } else {
        session.authenticate(byPassword: config.password ?? "")
      }
      guard session.isAuthorized else {
        session.disconnect()
        completion(.failure(TunnelError(message: "Authentication failed — check the username and credentials.")))
        return
      }
      self.session = session

      // 2. Hand the live session to the forwarder, which binds a local port
      // (0 → the OS picks a free one), accepts connections, and splices each to
      // its own direct-tcpip channel. Each connection is a separate channel, so
      // the sidecar's WebSocket and its HTTP polls multiplex over the one
      // session exactly as a real `-L` forward does.
      let forwarder = SshForwarder(session: session, remoteHost: config.remoteHost, remotePort: Int32(config.remotePort))
      self.forwarder = forwarder
      var localPort: UInt16 = 0
      do {
        localPort = try forwarder.start()
      } catch {
        session.disconnect()
        completion(.failure(TunnelError(message: (error as NSError).localizedDescription)))
        return
      }
      completion(.success(Int(localPort)))
    }
  }

  func close() {
    forwarder?.stop()
    forwarder = nil
    session?.disconnect()
    session = nil
  }
}
