import { sha256 } from "@noble/hashes/sha2.js";
import type { RelayIdentity } from "./relay";
import type { SshProfile } from "./ssh";

export type ComputerConnection = { kind: "ssh"; ssh: SshProfile } | ({ kind: "relay" } & RelayIdentity);
export interface SavedComputer {
  id: string;
  name: string;
  connection: ComputerConnection;
  pins: string[];
  /** Learned from an SSH computer once it is signed in; a relay code carries its own. */
  serverId?: string;
}
export type ComputerSummary = Pick<SavedComputer, "id" | "name"> & { address: string; serverId?: string; link?: "connecting" | "live" | "lost"; kind: ComputerConnection["kind"] };
export const COMPUTERS_KEY = "shahi.computers";

export function computerId(connection: ComputerConnection): string {
  const identity = connection.kind === "relay" ? ["relay", connection.serverId] :
    ["ssh", connection.ssh.host.trim().toLowerCase(), connection.ssh.port, connection.ssh.username.trim(), connection.ssh.remotePort];
  return Array.from(sha256(new TextEncoder().encode(JSON.stringify(identity))), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const saved: SavedComputer = { id, connection, name: name || previous?.name || computerAddress(connection), pins: pins ?? previous?.pins ?? [], ...(previous?.serverId && { serverId: previous.serverId }) };
  return previous ? computers.map((computer) => computer.id === id ? saved : computer) : [...computers, saved];
}
