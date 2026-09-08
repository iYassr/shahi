/** App contracts and recovery are independent of herdr and transport versions. */
export const API_SUPPORT = { min: 5, max: 5, securityFloor: 5, generations: 2 } as const;
export const CONTROL_VERSION = 1;
export const CAPABILITIES = ["sessions", "prompt-receipts", "attachments", "device-revocation", "computer-updates"] as const;
export type Capability = typeof CAPABILITIES[number];
export type ReleaseChannel = "stable" | "beta";
export type BackendState =
  | { state: "connected"; version: string; protocol: number }
  | { state: "offline" | "update-required" | "service-update-required"; message: string; version?: string; protocol?: number };
export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "verifying" | "restarting" | "ready" | "rolled-back" | "failed";
export interface ComputerUpdate {
  managed: boolean;
  channel: ReleaseChannel;
  phase: UpdatePhase;
  current: string;
  available?: string;
  message?: string;
  checkedAt?: number;
}
/** Always authenticated; available even when the regular app API cannot run. */
export interface ControlHandshake {
  control: typeof CONTROL_VERSION;
  serverId: string;
  buildId?: string;
  api: { min: number; max: number };
  capabilities: Capability[];
  backend: BackendState;
  update: ComputerUpdate;
}
export const updateInProgress = (phase: UpdatePhase) => ["checking", "downloading", "verifying", "restarting"].includes(phase);

/** A missing additive capability disables its UI; it never forces re-pairing. */
export function supports(handshake: ControlHandshake | null, capability: Capability): boolean {
  // API 5 before control-v1 shipped these features, but no managed updater.
  return handshake ? handshake.capabilities.includes(capability) : capability !== "computer-updates";
}
