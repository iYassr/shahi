#import "SshForwarder.h"
#import "libssh2.h"

#import <sys/socket.h>
#import <netinet/in.h>
#import <arpa/inet.h>
#import <netdb.h>
#import <unistd.h>
#import <fcntl.h>

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
  volatile BOOL _running;
  Conn *_conns;
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
  }
  return self;
}

- (nullable NSNumber *)start:(NSError **)error {
  // 1. Resolve and connect a socket to the SSH host.
  _sessionFd = [self connectSocketTo:_host port:_port];
  if (_sessionFd < 0) {
    if (error) *error = [self errorWithMessage:[NSString stringWithFormat:@"Could not reach %@:%d.", _host, _port]];
    return nil;
  }

  // 2. libssh2 handshake over that socket. Blocking is simplest and happens once.
  static dispatch_once_t once;
  dispatch_once(&once, ^{ libssh2_init(0); });
  _ssh = libssh2_session_init();
  if (_ssh == NULL || libssh2_session_handshake(_ssh, _sessionFd) != 0) {
    if (error) *error = [self errorWithMessage:@"The SSH handshake failed."];
    [self stop];
    return nil;
  }

  // 2a. Verify the host key BEFORE authenticating — otherwise a man in the
  // middle collects the password/key you are about to send. Trust on first use:
  // the app has no stored fingerprint the first time, accepts, and remembers it;
  // every connection after passes that fingerprint back as expectedHostKey, and
  // a mismatch (a different server, or an interception) is refused here, before
  // any credential leaves the device.
  const char *hash = libssh2_hostkey_hash(_ssh, LIBSSH2_HOSTKEY_HASH_SHA256);
  if (hash == NULL) {
    if (error) *error = [self errorWithMessage:@"Could not read the server's host key."];
    [self stop];
    return nil;
  }
  _hostKeyFingerprint = [[NSData dataWithBytes:hash length:32] base64EncodedStringWithOptions:0];
  if (_expectedHostKey.length > 0 && ![_expectedHostKey isEqualToString:_hostKeyFingerprint]) {
    if (error)
      *error = [self errorWithMessage:@"The server's host key has changed since you last connected. "
                                       "This can mean a man-in-the-middle — connection refused."];
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
    if (error) *error = [self errorWithMessage:@"Authentication failed — check the username and credentials."];
    return nil;
  }

  // Non-blocking so channel reads/writes return EAGAIN instead of stalling.
  libssh2_session_set_blocking(_ssh, 0);

  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    if (error) *error = [self errorWithMessage:@"Could not create a local socket."];
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
    if (error) *error = [self errorWithMessage:@"Could not bind a local port."];
    return nil;
  }
  socklen_t len = sizeof(addr);
  getsockname(fd, (struct sockaddr *)&addr, &len);
  uint16_t port = ntohs(addr.sin_port);

  fcntl(fd, F_SETFL, O_NONBLOCK);
  _listenFd = fd;
  _running = YES;

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [self loop];
  });
  return @(port);
}

- (void)loop {
  uint8_t *buf = malloc(kBufSize);
  while (_running) {
    fd_set readable;
    FD_ZERO(&readable);
    FD_SET(_listenFd, &readable);
    FD_SET(_sessionFd, &readable);
    int maxFd = _listenFd > _sessionFd ? _listenFd : _sessionFd;
    for (Conn *c = _conns; c; c = c->next) {
      FD_SET(c->localFd, &readable);
      if (c->localFd > maxFd) maxFd = c->localFd;
    }
    struct timeval tv = { .tv_sec = 1, .tv_usec = 0 };
    if (select(maxFd + 1, &readable, NULL, NULL, &tv) < 0) break;

    // A new local connection → a new direct-tcpip channel.
    if (FD_ISSET(_listenFd, &readable)) {
      int local = accept(_listenFd, NULL, NULL);
      if (local >= 0) {
        LIBSSH2_CHANNEL *ch = [self openChannel];
        if (ch) {
          fcntl(local, F_SETFL, O_NONBLOCK);
          Conn *c = calloc(1, sizeof(Conn));
          c->localFd = local; c->channel = ch; c->next = _conns; _conns = c;
        } else {
          close(local);
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
          while (off < n && !dead) {
            ssize_t w = libssh2_channel_write(c->channel, (char *)buf + off, n - off);
            if (w == LIBSSH2_ERROR_EAGAIN) continue;
            if (w < 0) dead = YES; else off += w;
          }
        } else if (n == 0) {
          dead = YES; // local closed
        }
      }

      // Channel → local. Always drain, since the session socket being readable
      // does not say which channel has data.
      if (!dead) {
        for (;;) {
          ssize_t n = libssh2_channel_read(c->channel, (char *)buf, kBufSize);
          if (n == LIBSSH2_ERROR_EAGAIN) break;
          if (n < 0) { dead = YES; break; }
          if (n == 0) { if (libssh2_channel_eof(c->channel)) dead = YES; break; }
          ssize_t off = 0;
          while (off < n) {
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
}

- (LIBSSH2_CHANNEL *)openChannel {
  // Channel open is itself non-blocking; loop over EAGAIN, waiting on the
  // session socket, rather than spinning.
  for (;;) {
    LIBSSH2_CHANNEL *ch = libssh2_channel_direct_tcpip_ex(
        _ssh, _remoteHost.UTF8String, _remotePort, "127.0.0.1", 0);
    if (ch) return ch;
    if (libssh2_session_last_errno(_ssh) != LIBSSH2_ERROR_EAGAIN) return NULL;
    [self waitSocket];
  }
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
  _running = NO;
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

// A blocking TCP connect, resolving the host. Returns the fd or -1.
- (int)connectSocketTo:(NSString *)host port:(int32_t)port {
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
    if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) break;
    close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  return fd;
}

- (NSError *)errorWithMessage:(NSString *)message {
  return [NSError errorWithDomain:@"SshForwarder" code:1 userInfo:@{NSLocalizedDescriptionKey: message}];
}

@end
