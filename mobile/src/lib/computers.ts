import { sha256 } from "@noble/hashes/sha2.js";
import type { RelayIdentity } from "./relay";
import type { SshProfile } from "./ssh";

export type ComputerConnection = { kind: "ssh"; ssh: SshProfile } | ({ kind: "relay" } & RelayIdentity);
export interface SavedComputer {
  id: string;
  name: string;
  /** A name chosen on this phone must survive the computer reporting its hostname. */
  customName?: string;
  connection: ComputerConnection;
  pins: string[];
  /** Learned from an SSH computer once it is signed in; a relay code carries its own. */
  serverId?: string;
}
export type ComputerSummary = Pick<SavedComputer, "id" | "name"> & { address: string; serverId?: string; link?: "connecting" | "live" | "lost"; kind: ComputerConnection["kind"]; waiting?: number; available?: boolean; status?: string };
export const COMPUTERS_KEY = "shahi.computers";

export function computerId(connection: ComputerConnection): string {
  const identity = connection.kind === "relay" ? ["relay", connection.serverId] :
    ["ssh", connection.ssh.host.trim().toLowerCase(), connection.ssh.port, connection.ssh.username.trim(), connection.ssh.remotePort];
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(identity))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The saved computers from both keychain services, as one list (see
 * `lib/keychain.ts`): an earlier build that ran again after this one saved a
 * computer it paired only where this build no longer looked, and it went
 * missing on the return (pre-release bug hunt). This build's entry wins for
 * a computer in both.
 */
export function mergeSavedComputers(kept: string, earlier: string): string {
  const list = (raw: string): SavedComputer[] => {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((c): c is SavedComputer => typeof c?.id === "string" && typeof c?.connection === "object" && c.connection !== null) : [];
    } catch { return []; }
  };
  const ours = list(kept);
  const known = new Set(ours.map((c) => c.id));
  const theirs = list(earlier).filter((c) => !known.has(c.id));
  return theirs.length ? JSON.stringify([...ours, ...theirs]) : kept;
}

export function computerAddress(connection: ComputerConnection): string {
  return connection.kind === "relay" ? `${new URL(connection.relay).host} · ${connection.serverId.slice(0, 8)}` :
    `${connection.ssh.username}@${connection.ssh.host}:${connection.ssh.port}`;
}

/**
 * Saves a connection: in its own place if the computer is already saved, at
 * the end if it is new.
 *
 * Every launch restores the selected computer through here, and moving it to
 * the end reordered the list on each cold start: a, b, c with a selected came
 * back b, c, a, made permanent by the next save (pre-release bug hunt).
 */
export function rememberComputer(computers: SavedComputer[], connection: ComputerConnection, name?: string, pins?: string[]): SavedComputer[] {
  const id = computerId(connection);
  const previous = computers.find((computer) => computer.id === id);
  const saved: SavedComputer = { id, connection, name: previous?.customName || name || previous?.name || computerAddress(connection), pins: pins ?? previous?.pins ?? [], ...(previous?.customName && { customName: previous.customName }), ...(previous?.serverId && { serverId: previous.serverId }) };
  return previous ? computers.map((computer) => computer.id === id ? saved : computer) : [...computers, saved];
}

/** Same hostnames are common; saved order gives their labels a stable distinction. */
export function computerDisplayName(computer: Pick<SavedComputer, "id" | "name">, computers: Pick<SavedComputer, "id" | "name">[]): string {
  const same = computers.filter(c => c.name === computer.name);
  return same.length > 1 ? `${computer.name} (${same.findIndex(c => c.id === computer.id) + 1})` : computer.name;
}
