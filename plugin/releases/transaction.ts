import { join } from "node:path";
import { rmSync } from "node:fs";
import type { Release } from "./catalog";
import { atomicJson, installation, readJson, type Transaction } from "./storage";

export interface Runner {
  activate(release: Release): Promise<void>;
  ready(release: Release, serverId?: string): Promise<boolean>;
  phase(phase: "restarting" | "ready" | "rolled-back" | "failed", message?: string): void;
}
/** The manager outlives the service. Pending activation is resumed after reboot. */
export async function finishTransaction(root: string, runner: Runner): Promise<void> {
  const tx = readJson<Transaction>(join(root, "transaction.json"));
  if (!tx) return;
  const record = installation(root)!;
  if (tx.previous.dataSchema !== tx.target.dataSchema) throw new Error("No tested rollback path for this data format.");
  runner.phase("restarting");
  atomicJson(join(root, "installation.json"), { ...record, active: tx.target, previous: tx.previous });
  let healthy = false;
  try { await runner.activate(tx.target); healthy = await runner.ready(tx.target, tx.serverId); } catch { /* Restore below. */ }
  if (healthy) {
    rmSync(join(root, "transaction.json"));
    runner.phase("ready");
    return;
  }
  atomicJson(join(root, "installation.json"), { ...record, active: tx.previous });
  try {
    await runner.activate(tx.previous);
    if (!await runner.ready(tx.previous, tx.serverId)) throw new Error("Previous release did not become ready.");
    rmSync(join(root, "transaction.json"));
    runner.phase("rolled-back", "The update did not start correctly. Your previous release and pairing have been restored.");
  } catch {
    // Leave the transaction so a restart retries recovery; never declare success.
    runner.phase("failed", "Shahi could not restart. The previous release is retained; check the computer's service log.");
    throw new Error("Update and recovery readiness checks failed.");
  }
}
export async function beginTransaction(root: string, target: Release, runner: Runner, serverId?: string) {
  const record = installation(root);
  if (!record) throw new Error("No managed installation.");
  if (record.active.dataSchema !== target.dataSchema) throw new Error("This data upgrade has no approved rollback path.");
  if (readJson(join(root, "transaction.json"))) throw new Error("An update is already pending recovery.");
  atomicJson(join(root, "transaction.json"), { previous: record.active, target, serverId });
  await finishTransaction(root, runner);
}
