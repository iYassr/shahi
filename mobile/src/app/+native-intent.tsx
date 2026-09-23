import { receivePairingLink } from "@/lib/incoming-pairing";

/**
 * Every link the system hands the app passes through here before routing,
 * on a cold launch and while running.
 *
 * A pairing link is held for Connect's confirm card and routed to Connect,
 * whatever computers are saved or on screen; before, only a mounted Connect
 * could see one, and with a computer saved it never was (pre-release review).
 * Anything else routes as it always did.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return receivePairingLink(path) ? "/connect" : path;
  } catch {
    // expo-router warns that throwing here can crash the app at launch.
    return path;
  }
}
