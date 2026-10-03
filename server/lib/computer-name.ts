/**
 * What the person calls this computer, for the phone to show.
 *
 * On a Mac, `os.hostname()` is whatever the network hands out: the same
 * MacBook showed as "Mac" on one network and "FA-F5-F2-84-C0-7E" on the next
 * (simulator run, October 2026), while the name the person chose in System
 * Settings, "Yasser's MacBook Pro", is the Computer Name `scutil` reports. It
 * is read once at startup and again at most every ten minutes, because the
 * snapshot that carries it is built on every change. Linux and any failure keep
 * `hostname()`, which there is the name the person set.
 */
import { hostname } from "node:os";

const REFRESH_MS = 10 * 60_000;
type Run = () => Promise<string | null>;

let cached: { name: string; at: number } | null = null;
let pending: Promise<void> | null = null;

/** A name fit to show: no control characters, trimmed, at most 63 characters. */
export function cleanName(value: string | null | undefined): string | null {
  const name = (value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  return name ? [...name].slice(0, 63).join("").trim() : null;
}

const scutil: Run = async () => {
  const proc = Bun.spawn(["/usr/sbin/scutil", "--get", "ComputerName"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? text : null;
};

/** Reads the name now; startup awaits it so the first snapshot is right. */
export async function loadComputerName(run: Run = scutil, platform: string = process.platform): Promise<void> {
  if (platform !== "darwin") { cached = { name: hostname(), at: Date.now() }; return; }
  let name: string | null = null;
  try { name = cleanName(await run()); } catch { /* Kept as hostname() below. */ }
  cached = { name: name ?? hostname(), at: Date.now() };
}

/** The current name, refreshed in the background when it is old. */
export function computerName(now = Date.now()): string {
  if (!cached) return hostname();
  if (now - cached.at > REFRESH_MS && !pending) {
    pending = loadComputerName().finally(() => { pending = null; });
  }
  return cached.name;
}
