import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continuedTranscript, findTranscript } from "./session-log";

/**
 * Sending a Claude Code conversation to the background starts a new session
 * and ends the old transcript with a `continued-in` row. The pane's Claude
 * process keeps the old session id, which herdr reported, so Reader showed the
 * old file's last reply, hours stale, while Screen showed the live
 * conversation (Claude Code 2.1.286 on the owner's phone, October 2026).
 */
const root = mkdtempSync(join(tmpdir(), "shahi-continuation-"));
const projects = join(root, "projects");
mkdirSync(join(projects, "-work-app"), { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const NEWER = "33333333-3333-4333-8333-333333333333";
const say = (session: string, text: string) => JSON.stringify({ type: "assistant", sessionId: session, uuid: crypto.randomUUID(), message: { role: "assistant", content: [{ type: "text", text }] } });
const moved = (session: string, to: string) => JSON.stringify({ type: "continued-in", timestamp: "2026-09-30T22:05:42.285Z", sessionId: session, continuedInSessionId: to });
const file = (session: string, rows: string[]) => writeFileSync(join(projects, "-work-app", `${session}.jsonl`), rows.join("\n") + "\n");
const path = (session: string) => join(projects, "-work-app", `${session}.jsonl`);
/** As findTranscript names it: resolved, so /var and /private/var agree. */
const real = (session: string) => realpathSync(path(session));

test("a conversation sent to the background is read from the session it continued in", async () => {
  file(OLD, [say(OLD, "Still open: the old summary."), JSON.stringify({ type: "cost-state" }), moved(OLD, NEW)]);
  file(NEW, [say(NEW, "The live reply.")]);
  const old = await findTranscript(OLD, projects);
  expect(await continuedTranscript(old!, projects)).toBe(await findTranscript(NEW, projects));
});

test("a conversation that went on after the marker stays where it is", async () => {
  file(OLD, [moved(OLD, NEW), say(OLD, "Resumed here after all.")]);
  file(NEW, [say(NEW, "Elsewhere.")]);
  const old = await findTranscript(OLD, projects);
  expect(await continuedTranscript(old!, projects)).toBe(old!);
});

test("a continuation whose transcript cannot be found keeps the original", async () => {
  file(OLD, [say(OLD, "Before."), moved(OLD, NEWER)]);
  rmSync(path(NEWER), { force: true });
  const old = await findTranscript(OLD, projects);
  expect(await continuedTranscript(old!, projects)).toBe(old!);
});

test("continuations are followed to the end, and a loop stops rather than spins", async () => {
  file(OLD, [moved(OLD, NEW)]);
  file(NEW, [moved(NEW, NEWER)]);
  file(NEWER, [say(NEWER, "Today.")]);
  expect(await continuedTranscript(real(OLD), projects)).toBe(real(NEWER));
  file(NEWER, [moved(NEWER, OLD)]);
  // Back at a file already visited: it stops on the last new one.
  expect(await continuedTranscript(real(OLD), projects)).toBe(real(NEWER));
});

test("a marker naming something that is not a session id is ignored", async () => {
  file(OLD, [JSON.stringify({ type: "continued-in", continuedInSessionId: "../../etc/passwd" })]);
  expect(await continuedTranscript(real(OLD), projects)).toBe(real(OLD));
});
