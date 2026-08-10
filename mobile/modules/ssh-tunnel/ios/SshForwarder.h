#import <Foundation/Foundation.h>

@class NMSSHSession;

NS_ASSUME_NONNULL_BEGIN

/**
 * The `-L` half of the tunnel: a local TCP listener that splices every accepted
 * connection to a libssh2 direct-tcpip channel over an already-authenticated
 * NMSSH session. Objective-C rather than Swift because this is C interop with
 * libssh2 and BSD sockets, which imports cleanly here.
 *
 * The header stays free of libssh2 types so Swift can use it without a module
 * map; everything C lives in the .m.
 */
@interface SshForwarder : NSObject

- (instancetype)initWithSession:(NMSSHSession *)session
                     remoteHost:(NSString *)remoteHost
                     remotePort:(int32_t)remotePort;

/** Binds a loopback port (OS-chosen), starts accepting, returns the port. */
- (uint16_t)start:(NSError **)error;

/** Stops accepting and closes every channel and the session's local socket. */
- (void)stop;

@end

NS_ASSUME_NONNULL_END
