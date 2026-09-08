import { sha256 } from "@noble/hashes/sha2.js";
import type { RelayIdentity } from "./relay";
import type { SshProfile } from "./ssh";

export type ComputerConnection = { kind: "ssh"; ssh: SshProfile } | ({ kind: "relay" } & RelayIdentity);
export interface SavedComputer {
  id: string;
  name: string;
  connection: ComputerConnection;
  pins: string[];
}
export type ComputerSummary = Pick<SavedComputer, "id" | "name"> & { address: string; kind: ComputerConnection["kind"] };
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

export function rememberComputer(computers: SavedComputer[], connection: ComputerConnection, name?: string, pins?: string[]): SavedComputer[] {
  const id = computerId(connection);
  const previous = computers.find((computer) => computer.id === id);
  const saved: SavedComputer = { id, connection, name: name || previous?.name || computerAddress(connection), pins: pins ?? previous?.pins ?? [] };
  return [...computers.filter((computer) => computer.id !== id), saved];
}
