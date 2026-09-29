/** Prepare a reviewed policy; deployment remains the ordinary website release. */
import { parseUpdatePolicy, type ClientUpdatePolicy, type UpdatePlatform } from "../shared/src/client-update";
import { readFile, writeFile } from "node:fs/promises";

export function editClientUpdate(policy: ClientUpdatePolicy, platform: UpdatePlatform, build: number | null, hours = 24, message = "Update Shahi to restore your connection.", now = Date.now()): ClientUpdatePolicy {
  if (!["ios", "web"].includes(platform)) throw new Error("Choose ios or web.");
  if (build !== null && (!Number.isFinite(hours) || hours <= 0 || hours > 336)) throw new Error("Expiry must be between 0 and 336 hours.");
  const next = { ...policy, [platform]: build === null ? null : { minimumBuild: build, expiresAt: new Date(now + hours * 3_600_000).toISOString(), message } };
  if (!parseUpdatePolicy(next, now)) throw new Error("Invalid policy: use a positive integer build and a message of 1–400 characters.");
  return next;
}
if (import.meta.main) {
  const [platform, build, hours, ...words] = process.argv.slice(2);
  if (!platform || !build) throw new Error('Usage: bun scripts/client-update.ts ios|web BUILD|clear [HOURS] [message]');
  const path = new URL("../site/client-update.json", import.meta.url);
  const previous = JSON.parse(await readFile(path, "utf8"));
  const next = editClientUpdate(previous, platform as UpdatePlatform, build === "clear" ? null : Number(build), hours === undefined ? 24 : Number(hours), words.join(" ") || undefined);
  await writeFile(path, JSON.stringify(next, null, 2) + "\n");
  console.log(`Prepared ${platform} policy in site/client-update.json. Review the diff, verify the required build is available to everyone affected, then deploy the website. Nothing has been published.`);
}
