import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { validateCiRun } = require("./mobile-app-store.cjs") as { validateCiRun: (run: Record<string, string>, sha: string) => boolean };
const { prepareExpoSession, cleanupExpoSession } = require("./mobile-app-store.cjs") as { prepareExpoSession: (session: string, target: string, owner: string) => void; cleanupExpoSession: (target: string, owner: string) => void };
const run = { head_sha: "verified-source", path: ".github/workflows/ci.yml", event: "workflow_dispatch", head_branch: "master", status: "completed", conclusion: "success" };
describe("native upload's exact-source CI gate", () => {
  test("accepts the owner's successful manual CI run for the archive source", () => {
    expect(validateCiRun(run, "verified-source")).toBe(true);
  });
  for (const [field, value] of [["head_sha", "older-source"], ["path", ".github/workflows/release.yml"], ["event", "pull_request"], ["head_branch", "untrusted-branch"]]) {
    test(`rejects a mismatched ${field}`, () => expect(() => validateCiRun({ ...run, [field!]: value! }, "verified-source")).toThrow());
  }
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out"]) {
    test(`refuses completed CI with ${conclusion}`, () => expect(() => validateCiRun({ ...run, conclusion }, "verified-source")).toThrow());
  }
  test("allows the archive to start while CI runs but does not authorize upload", () => {
    expect(validateCiRun({ ...run, status: "in_progress", conclusion: "" }, "verified-source")).toBe(false);
    expect(validateCiRun({ ...run, status: "queued", conclusion: "" }, "verified-source")).toBe(false);
  });
});

describe("protected Expo runner session ownership", () => {
  test("uses existing authorized authentication privately and deletes only its own session", () => {
    const dir = mkdtempSync(join(tmpdir(), "shahi-session-test-")), target = join(dir, "state.json"), owner = join(dir, "owned");
    try {
      prepareExpoSession("synthetic-session", target, owner);
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ auth: { sessionSecret: "synthetic-session" } });
      expect(statSync(target).mode & 0o777).toBe(0o600);
      cleanupExpoSession(target, owner);
      expect(existsSync(target)).toBe(false); expect(existsSync(owner)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("refuses to overwrite and preserves a preexisting session on cleanup", () => {
    const dir = mkdtempSync(join(tmpdir(), "shahi-session-test-")), target = join(dir, "state.json"), owner = join(dir, "owned");
    try {
      writeFileSync(target, "existing-session");
      expect(() => prepareExpoSession("synthetic-session", target, owner)).toThrow();
      cleanupExpoSession(target, owner);
      expect(readFileSync(target, "utf8")).toBe("existing-session");
      expect(existsSync(owner)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
