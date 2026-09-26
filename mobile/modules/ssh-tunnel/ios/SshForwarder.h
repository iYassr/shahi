#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * The `SshForwarder` error code for a refusal to authenticate because the
 * server did not present the trusted host key, or none was given. A caller
 * tells the refusals apart from the rest (code 1) so a person is sent to
 * check the computer's identity, or their login, rather than told to retry —
 * and so an app that reconnects by itself does not repeat a refused login.
 */
static const NSInteger SshForwarderHostKeyRefused = 2;
/** The server refused the username, password or key. */
static const NSInteger SshForwarderLoginRefused = 3;
/** Signed in, but the server will not forward a port (`AllowTcpForwarding`). */
static const NSInteger SshForwarderForwardingRefused = 4;

/**
 * The whole tunnel: connect, handshake, authenticate, and forward — all
 * libssh2, no NMSSH. It connects a socket to host:port, does the SSH
 * handshake, authenticates (password or in-memory key), then binds a local
 * loopback port and splices every accepted connection to its own libssh2
 * direct-tcpip channel to remoteHost:remotePort. Objective-C because it is C
 * interop with libssh2 and BSD sockets, which imports cleanly here.
 *
 * The header stays free of libssh2 types so Swift can use it without a module
 * map; everything C lives in the .m.
 */
@interface SshForwarder : NSObject

/**
 * Connects and completes the SSH handshake only, then disconnects: no user
 * name and no credential is sent. Returns the server's host key as
 * `hostKey` (the base64 SHA-256 of its key blob, the form `expectedHostKey`
 * takes and `ssh-keygen -lf` prints unpadded) and `keyType` (`ED25519`,
 * `ECDSA`, `RSA`, `DSA`), or nil with a human-readable error.
 *
 * This is what a person checks before trusting a server. The first key used
 * to be accepted inside -start:, in the same call that sent the password, so
 * nobody ever saw it (pre-release review).
 */
+ (nullable NSDictionary<NSString *, NSString *> *)hostKeyForHost:(NSString *)host
                                                             port:(int32_t)port
                                                            error:(NSError **)error
    NS_SWIFT_NAME(hostKey(forHost:port:));

- (instancetype)initWithHost:(NSString *)host
                        port:(int32_t)port
                    username:(NSString *)username
                    password:(nullable NSString *)password
                  privateKey:(nullable NSString *)privateKey
                  passphrase:(nullable NSString *)passphrase
             expectedHostKey:(nullable NSString *)expectedHostKey
                  remoteHost:(NSString *)remoteHost
                  remotePort:(int32_t)remotePort;

/**
 * Connects, verifies the host key, authenticates, proves the forward by
 * opening one channel to remoteHost:remotePort, and starts listening,
 * returning the local port. Returns nil with a human-readable error on any
 * failure — an NSNumber (not a scalar) so Swift imports it as a throwing
 * call. The server must present exactly `expectedHostKey`, a key the person
 * has trusted (see +hostKeyForHost:port:error:); without one, or on a
 * mismatch, it refuses before authenticating with code
 * SshForwarderHostKeyRefused.
 *
 * When the SSH session later ends, the forward stops listening, so a local
 * connection is refused rather than accepted and dropped.
 */
- (nullable NSNumber *)start:(NSError **)error;

/** Stops accepting and closes every channel, the session, and both sockets. */
- (void)stop;

@end

NS_ASSUME_NONNULL_END
