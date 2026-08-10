#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

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

- (instancetype)initWithHost:(NSString *)host
                        port:(int32_t)port
                    username:(NSString *)username
                    password:(nullable NSString *)password
                  privateKey:(nullable NSString *)privateKey
                  passphrase:(nullable NSString *)passphrase
                  remoteHost:(NSString *)remoteHost
                  remotePort:(int32_t)remotePort;

/**
 * Connects, authenticates, and starts the forward, returning the local port it
 * listens on. Returns nil with a human-readable error on any failure — an
 * NSNumber (not a scalar) so Swift imports it as a throwing call.
 */
- (nullable NSNumber *)start:(NSError **)error;

/** Stops accepting and closes every channel, the session, and both sockets. */
- (void)stop;

@end

NS_ASSUME_NONNULL_END
