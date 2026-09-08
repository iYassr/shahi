import { mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { updateInProgress, type ComputerUpdate, type ReleaseChannel } from "@shahi/shared";
import type { Release } from "./catalog";

export interface Installation { active: Release; previous?: Release; channel: ReleaseChannel; sequence: Partial<Record<ReleaseChannel, number>> }
export interface Transaction { previous: Release; target: Release; serverId?: string }
export type UpdateRequest = { action: "check" | "install"; channel?: ReleaseChannel };
export function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
/** Rename plus fsync: a power loss leaves the old record or the complete new one. */
export function atomicJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export const releaseDirectory = (root: string, r: Release) => join(root, "releases", r.buildId);
export const installation = (root: string) => readJson<Installation>(join(root, "installation.json"));
export function updateStatus(root: string): ComputerUpdate | null {
  const status = readJson<ComputerUpdate>(join(root, "status.json"));
  if (status && existsSync(join(root, "request.json")) && !updateInProgress(status.phase)) return { ...status, phase: "checking" };
  return status;
}

/** Only fixed actions. The service cannot supply a download URL or a command. */
export function requestUpdate(root: string, request: UpdateRequest) {
  const path = join(root, `request-${crypto.randomUUID()}.tmp`);
  atomicJson(path, request);
  // Atomic publication without overwriting a pending request. The reader
  // never sees an empty or partially written request from another process.
  try { linkSync(path, join(root, "request.json")); } finally { unlinkSync(path); }
}
