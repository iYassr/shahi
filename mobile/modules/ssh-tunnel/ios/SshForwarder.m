#import "SshForwarder.h"
#import "libssh2.h"

#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>
#import <netdb.h>
#import <unistd.h>
#import <fcntl.h>
#import <stdatomic.h>

// The whole tunnel in libssh2 — connect, handshake, auth, forward. One
// session, one socket, many channels: libssh2 multiplexes every channel over
// the session's single TCP socket, so this cannot block on one channel without
// stalling the rest. It runs one non-blocking select() loop over the listen
// socket, every live local socket, and the session socket, shuttling bytes
// between each local connection and its own direct-tcpip channel. That is the
// shape a correct `ssh -L` takes; a blocking thread per channel would deadlock
// the moment two channels are busy, which the sidecar's WebSocket-plus-polling
// guarantees.

static const size_t kBufSize = 32768;

typedef struct Conn {
  int localFd;
  LIBSSH2_CHANNEL *channel;
  struct Conn *next;
} Conn;

static NSError *Failure(NSString *message) {
  return [NSError errorWithDomain:@"SshForwarder" code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSError *HostKeyRefused(NSString *message) {
  return [NSError errorWithDomain:@"SshForwarder" code:SshForwarderHostKeyRefused userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSError *Refused(NSInteger code, NSString *message) {
  return [NSError errorWithDomain:@"SshForwarder" code:code userInfo:@{NSLocalizedDescriptionKey: message}];
}

// Whether a libssh2 error means the session's socket is finished: the server
// disconnected, or a read or write on it failed or timed out.
static BOOL SessionErrorIsFatal(int rc) {
  return rc == LIBSSH2_ERROR_SOCKET_DISCONNECT || rc == LIBSSH2_ERROR_SOCKET_RECV ||
         rc == LIBSSH2_ERROR_SOCKET_SEND || rc == LIBSSH2_ERROR_SOCKET_TIMEOUT ||
         rc == LIBSSH2_ERROR_TIMEOUT;
}

typedef enum { SessionQuiet, SessionPending, SessionEnded } SessionState;

// What is waiting on the session socket, without consuming it: nothing, bytes
// for libssh2, or the end of the connection (EOF or an error such as a reset).
static SessionState PeekSession(int fd) {
  char byte;
  ssize_t n = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT);
  if (n > 0) return SessionPending;
  if (n == 0) return SessionEnded;
  return (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) ? SessionQuiet : SessionEnded;
}

// A blocking TCP connect, resolving the host. Returns the fd or -1.
static int ConnectSocket(NSString *host, int32_t port) {
  struct addrinfo hints = {0};
  hints.ai_family = AF_UNSPEC;      // v4 or v6, whichever resolves
  hints.ai_socktype = SOCK_STREAM;
  struct addrinfo *res = NULL;
  const char *service = [NSString stringWithFormat:@"%d", port].UTF8String;
  if (getaddrinfo(host.UTF8String, service, &hints, &res) != 0 || res == NULL) return -1;

  int fd = -1;
  for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
    fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) continue;
    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
    fcntl(fd, F_SETFL, O_NONBLOCK);
    int result = connect(fd, ai->ai_addr, ai->ai_addrlen);
    if (result < 0 && errno == EINPROGRESS) {
      fd_set writable;
      FD_ZERO(&writable);
      FD_SET(fd, &writable);
      struct timeval timeout = { .tv_sec = 15, .tv_usec = 0 };
      if (select(fd + 1, NULL, &writable, NULL, &timeout) > 0) {
        int status = 0;
        socklen_t size = sizeof(status);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &status, &size) == 0 && status == 0) result = 0;
      }
    }
    if (result == 0) {
      fcntl(fd, F_SETFL, 0);
      break;
    }
    close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  return fd;
}

// A handshaken session over `fd`, or NULL. Blocking is simplest and happens once.
static LIBSSH2_SESSION *Handshake(int fd) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{ libssh2_init(0); });
  LIBSSH2_SESSION *ssh = libssh2_session_init();
  if (ssh == NULL) return NULL;
  libssh2_session_set_timeout(ssh, 15000);
  if (libssh2_session_handshake(ssh, fd) != 0) {
    libssh2_session_free(ssh);
    return NULL;
  }
  return ssh;
}

// The SHA-256 of the host key blob, base64: the hash OpenSSH shows as
// `SHA256:<this, unpadded>`.
static NSString *HostKeyHash(LIBSSH2_SESSION *ssh) {
  const char *hash = libssh2_hostkey_hash(ssh, LIBSSH2_HOSTKEY_HASH_SHA256);
  return hash ? [[NSData dataWithBytes:hash length:32] base64EncodedStringWithOptions:0] : nil;
}

// Which of the server's host keys it presented, named as ssh-keygen names
// them, so the app can say which key file on the server to compare against.
static NSString *HostKeyType(LIBSSH2_SESSION *ssh) {
  size_t length = 0;
  int type = LIBSSH2_HOSTKEY_TYPE_UNKNOWN;
  if (libssh2_session_hostkey(ssh, &length, &type) == NULL) return @"UNKNOWN";
  switch (type) {
    case LIBSSH2_HOSTKEY_TYPE_ED25519: return @"ED25519";
    case LIBSSH2_HOSTKEY_TYPE_ECDSA_256:
    case LIBSSH2_HOSTKEY_TYPE_ECDSA_384:
    case LIBSSH2_HOSTKEY_TYPE_ECDSA_521: return @"ECDSA";
    case LIBSSH2_HOSTKEY_TYPE_RSA: return @"RSA";
    case LIBSSH2_HOSTKEY_TYPE_DSS: return @"DSA";
    default: return @"UNKNOWN";
  }
}

@implementation SshForwarder {
  NSString *_host;
  int32_t _port;
  NSString *_username;
  NSString *_password;
  NSString *_privateKey;
  NSString *_passphrase;
  NSString *_expectedHostKey;
  NSString *_remoteHost;
  int32_t _remotePort;
  int _listenFd;
  int _sessionFd;
  LIBSSH2_SESSION *_ssh;
  atomic_bool _running;
  volatile BOOL _loopStarted;
  BOOL _stopped;
  dispatch_semaphore_t _loopDone;
  Conn *_conns;
}

+ (nullable NSDictionary<NSString *, NSString *> *)hostKeyForHost:(NSString *)host
                                                             port:(int32_t)port
                                                            error:(NSError **)error {
  int fd = ConnectSocket(host, port);
  if (fd < 0) {
    if (error) *error = Failure([NSString stringWithFormat:@"Could not reach %@:%d.", host, port]);
    return nil;
  }
  LIBSSH2_SESSION *ssh = Handshake(fd);
  if (ssh == NULL) {
    close(fd);
    if (error) *error = Failure(@"The SSH handshake failed.");
    return nil;
  }
  NSString *hostKey = HostKeyHash(ssh);
  NSString *keyType = HostKeyType(ssh);
  // Nothing past the key exchange: no user name, no authentication request.
  libssh2_session_disconnect(ssh, "bye");
  libssh2_session_free(ssh);
  close(fd);
  if (hostKey == nil) {
    if (error) *error = Failure(@"Could not read the server's host key.");
    return nil;
  }
  return @{@"hostKey": hostKey, @"keyType": keyType};
}

- (instancetype)initWithHost:(NSString *)host
                        port:(int32_t)port
                    username:(NSString *)username
                    password:(NSString *)password
                  privateKey:(NSString *)privateKey
                  passphrase:(NSString *)passphrase
             expectedHostKey:(NSString *)expectedHostKey
                  remoteHost:(NSString *)remoteHost
                  remotePort:(int32_t)remotePort {
  if ((self = [super init])) {
    _host = [host copy];
    _port = port;
    _username = [username copy];
    _password = [password copy];
    _privateKey = [privateKey copy];
    _passphrase = [passphrase copy];
    _expectedHostKey = [expectedHostKey copy];
    _remoteHost = [remoteHost copy];
    _remotePort = remotePort;
    _listenFd = -1;
    _sessionFd = -1;
    // Signalled by the select loop as it exits, so stop can wait for the loop
    // to let go of the session before freeing it. See -stop.
    _loopDone = dispatch_semaphore_create(0);
  }
  return self;
}

- (nullable NSNumber *)start:(NSError **)error {
  // 1. Resolve and connect a socket to the SSH host.
  _sessionFd = ConnectSocket(_host, _port);
  if (_sessionFd < 0) {
    if (error) *error = Failure([NSString stringWithFormat:@"Could not reach %@:%d.", _host, _port]);
    return nil;
  }

  // 2. libssh2 handshake over that socket.
  _ssh = Handshake(_sessionFd);
  if (_ssh == NULL) {
    if (error) *error = Failure(@"The SSH handshake failed.");
    [self stop];
    return nil;
  }

  // 2a. Verify the host key BEFORE authenticating — otherwise a man in the
  // middle collects the password/key you are about to send. Only a key the
  // person has seen and trusted is accepted: the app fetches it first with
  // +hostKeyForHost:port:error:, shows its fingerprint, and passes the trusted
  // one here. With no expected key there is nothing to verify against, so
  // nothing is sent. This used to trust whatever key answered first, silently
  // and in the same call as the password (pre-release review).
  NSString *presented = HostKeyHash(_ssh);
  if (presented == nil) {
    if (error) *error = Failure(@"Could not read the server's host key.");
    [self stop];
    return nil;
  }
  if (_expectedHostKey.length == 0) {
    if (error) *error = HostKeyRefused(@"This phone has not trusted this computer's host key, so your login was not sent.");
    [self stop];
    return nil;
  }
  if (![_expectedHostKey isEqualToString:presented]) {
    if (error)
      *error = HostKeyRefused(@"This computer's host key has changed since you trusted it, so your login was not sent. "
                        "It can mean someone is intercepting the connection. If the computer was reinstalled, "
                        "add it again from Computers to compare and trust its new key.");
    [self stop];
    return nil;
  }

  // 3. Authenticate. A nil public key lets libssh2 derive it from the private one.
  const char *user = _username.UTF8String;
  int rc;
  if (_privateKey.length > 0) {
    const char *key = _privateKey.UTF8String;
    const char *pass = _passphrase.length > 0 ? _passphrase.UTF8String : NULL;
    rc = libssh2_userauth_publickey_frommemory(_ssh, user, strlen(user), NULL, 0, key, strlen(key), pass);
  } else {
    rc = libssh2_userauth_password(_ssh, user, _password ? _password.UTF8String : "");
  }
  if (rc != 0 || libssh2_userauth_authenticated(_ssh) == 0) {
    // A dropped connection is worth retrying; a refused login is not, and
    // repeating one is how a phone's address ends up banned (fail2ban).
    if (error) *error = SessionErrorIsFatal(rc)
        ? Failure([NSString stringWithFormat:@"The connection to %@:%d dropped while signing in. Try again.", _host, _port])
        : Refused(SshForwarderLoginRefused, @"Authentication failed — check the username and credentials.");
    return nil;
  }

  // Non-blocking so channel reads/writes return EAGAIN instead of stalling.
  libssh2_session_set_blocking(_ssh, 0);

  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    if (error) *error = Failure(@"Could not create a local socket.");
    return nil;
  }
  int yes = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

  struct sockaddr_in addr = {0};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK); // loopback only — never exposed off-device
  addr.sin_port = 0;                             // OS picks a free port
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0 || listen(fd, 8) < 0) {
    close(fd);
    if (error) *error = Failure(@"Could not bind a local port.");
    return nil;
  }
  socklen_t len = sizeof(addr);
  getsockname(fd, (struct sockaddr *)&addr, &len);
  uint16_t port = ntohs(addr.sin_port);

  fcntl(fd, F_SETFL, O_NONBLOCK);
  _listenFd = fd;
  _running = YES;
  // Set before the dispatch so a stop racing this sees a loop is coming and
  // waits for it, rather than freeing the session out from under it.
  _loopStarted = YES;

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [self loop];
  });
  return @(port);
}

- (void)loop {
  uint8_t *buf = malloc(kBufSize);
  while (_running) {
    // The session can end under the forward: sshd restarted, the computer
    // rebooted, a NAT forgot the connection. Its socket then reads as ended
    // for good, and this loop, which selected on it every time round, woke at
    // once forever — 60–86% of a core — while accepting local connections
    // only to drop them; nothing told the app (pre-release bug hunt).
    SessionState session = PeekSession(_sessionFd);
    if (session == SessionEnded) break;

    fd_set readable;
    FD_ZERO(&readable);
    FD_SET(_listenFd, &readable);
    int maxFd = _listenFd;
    // Only channel reads consume the session socket, so with no channel open,
    // bytes waiting there (a server keepalive, a disconnect) would wake the
    // loop at once, forever. Then the timeout paces the checks above instead;
    // the next channel opened reads them.
    if (_conns || session == SessionQuiet) {
      FD_SET(_sessionFd, &readable);
      if (_sessionFd > maxFd) maxFd = _sessionFd;
    }
    for (Conn *c = _conns; c; c = c->next) {
      FD_SET(c->localFd, &readable);
      if (c->localFd > maxFd) maxFd = c->localFd;
    }
    struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };
    if (select(maxFd + 1, &readable, NULL, NULL, &tv) < 0) {
      if (errno == EINTR) continue;
      break;
    }

    // A new local connection → a new direct-tcpip channel.
    if (FD_ISSET(_listenFd, &readable)) {
      int local = accept(_listenFd, NULL, NULL);
      if (local >= 0) {
        int yes = 1;
        setsockopt(local, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
        LIBSSH2_CHANNEL *ch = [self openChannel];
        if (ch) {
          fcntl(local, F_SETFL, O_NONBLOCK);
          Conn *c = calloc(1, sizeof(Conn));
          c->localFd = local; c->channel = ch; c->next = _conns; _conns = c;
        } else {
          close(local);
          if (SessionErrorIsFatal(libssh2_session_last_errno(_ssh))) break;
        }
      }
    }

    // Pump every connection both ways; drop the ones that hit EOF or error.
    Conn **link = &_conns;
    while (*link) {
      Conn *c = *link;
      BOOL dead = NO;

      if (FD_ISSET(c->localFd, &readable)) {
        ssize_t n = recv(c->localFd, buf, kBufSize, 0);
        if (n > 0) {
          ssize_t off = 0;
          CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 15;
          while (_running && off < n && !dead) {
            ssize_t w = libssh2_channel_write(c->channel, (char *)buf + off, n - off);
            // On a congested uplink the write returns EAGAIN; block on the
            // session socket until it drains rather than re-calling in a tight
            // loop, which pinned a core (native-module audit).
            if (w == LIBSSH2_ERROR_EAGAIN || w == 0) {
              if (CFAbsoluteTimeGetCurrent() >= deadline) { dead = YES; break; }
              [self waitSocket];
              continue;
            }
            if (w < 0) dead = YES; else off += w;
          }
        } else if (n == 0) {
          dead = YES; // local closed
        }
      }

      // Channel → local. Always drain, since the session socket being readable
      // does not say which channel has data.
      if (!dead) {
        while (_running) {
          ssize_t n = libssh2_channel_read(c->channel, (char *)buf, kBufSize);
          if (n == LIBSSH2_ERROR_EAGAIN) break;
          if (n < 0) { dead = YES; break; }
          if (n == 0) { if (libssh2_channel_eof(c->channel)) dead = YES; break; }
          ssize_t off = 0;
          while (_running && off < n) {
            ssize_t w = send(c->localFd, buf + off, n - off, 0);
            if (w <= 0) { dead = YES; break; }
            off += w;
          }
        }
      }

      if (dead) {
        *link = c->next;
        libssh2_channel_free(c->channel);
        close(c->localFd);
        free(c);
      } else {
        link = &c->next;
      }
    }
  }
  free(buf);
  // Ended with the session rather than by stop: stop listening now, so the
  // app's next request is refused at once and it opens a new tunnel. The
  // rest waits for stop, which frees the session.
  if (_running && _listenFd >= 0) {
    close(_listenFd);
    _listenFd = -1;
  }
  // Tell stop the loop has let go of the session; it is now safe to free it.
  dispatch_semaphore_signal(_loopDone);
}

- (LIBSSH2_CHANNEL *)openChannel {
  // Channel open is itself non-blocking; loop over EAGAIN, waiting on the
  // session socket, rather than spinning.
  CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + 15;
  while (_running && CFAbsoluteTimeGetCurrent() < deadline) {
    LIBSSH2_CHANNEL *ch = libssh2_channel_direct_tcpip_ex(
        _ssh, _remoteHost.UTF8String, _remotePort, "127.0.0.1", 0);
    if (ch) return ch;
    if (libssh2_session_last_errno(_ssh) != LIBSSH2_ERROR_EAGAIN) return NULL;
    [self waitSocket];
  }
  return NULL;
}

// Block until the session socket is ready in whichever direction libssh2 wants.
- (void)waitSocket {
  fd_set fds;
  FD_ZERO(&fds);
  FD_SET(_sessionFd, &fds);
  int dir = libssh2_session_block_directions(_ssh);
  fd_set *rd = (dir & LIBSSH2_SESSION_BLOCK_INBOUND) ? &fds : NULL;
  fd_set *wr = (dir & LIBSSH2_SESSION_BLOCK_OUTBOUND) ? &fds : NULL;
  struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };
  select(_sessionFd + 1, rd, wr, NULL, &tv);
}

- (void)stop {
  // Idempotent: a second stop must not wait on a semaphore the loop already
  // signalled (it would block for the full timeout) or double-free anything.
  @synchronized (self) {
  if (_stopped) return;
  _stopped = YES;
  _running = NO;
  // Wake pending select/I/O without closing or freeing anything the loop owns.
  // Every retry checks cancellation. Never free on a timed-out join: that
  // turns a slow transfer into a use-after-free on sign-out.
  if (_sessionFd >= 0) shutdown(_sessionFd, SHUT_RDWR);
  if (_loopStarted) dispatch_semaphore_wait(_loopDone, DISPATCH_TIME_FOREVER);
  Conn *c = _conns;
  while (c) {
    Conn *next = c->next;
    if (c->channel) libssh2_channel_free(c->channel);
    if (c->localFd >= 0) close(c->localFd);
    free(c);
    c = next;
  }
  _conns = NULL;
  if (_listenFd >= 0) { close(_listenFd); _listenFd = -1; }
  if (_ssh) {
    libssh2_session_disconnect(_ssh, "bye");
    libssh2_session_free(_ssh);
    _ssh = NULL;
  }
  if (_sessionFd >= 0) { close(_sessionFd); _sessionFd = -1; }
  }
}

@end
