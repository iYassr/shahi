/**
 * The SSH tunnel native module.
 *
 * The app talks to this through `src/lib/tunnel.ts`, which resolves it by name
 * with `requireOptionalNativeModule("SshTunnel")` so the JS bundle still runs
 * where the native side is absent. This file only exists so the module has a
 * JS entry point; the contract lives in `tunnel.ts`.
 */
import { requireOptionalNativeModule } from "expo";

export default requireOptionalNativeModule("SshTunnel");
