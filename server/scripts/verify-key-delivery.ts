/**
 * Verifies what `pane.send_keys` actually delivers to a process.
 *
 * The whole one-tap-approval feature rests on an assumption the plan flagged as
 * unproven: that answering a Claude Code prompt is a matter of pressing its
 * digit. Before trusting that, it is worth establishing the mechanical layer —
 * given `keys: ["2"]`, does the byte `2` reach the foreground process, and what
 * do the named keys (`Enter`, `Escape`, `C-c`, `S-Tab`, arrows) turn into?
 *
 * This runs against a **disposable workspace it creates and then closes**. It
 * must never be pointed at a real agent: sending a stray keystroke into a live
 * session is exactly the failure mode the strict prompt parser exists to avoid.
 *
 *   bun run server/scripts/verify-key-delivery.ts
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrClient } from "../lib/herdr-client";
import { stripAnsi } from "../lib/prompt-parser";

const WORKSPACE_LABEL = "shahi-keytest";

/**
 * Reads one character at a time in raw mode and echoes its repr.
 *
 * Raw mode matters: without it the terminal would intercept Ctrl-C and the
 * script would die instead of reporting what it received.
 */
const READER = `
import sys, termios, tty
fd = sys.stdin.fileno()
old = termios.tcgetattr(fd)
try:
    tty.setraw(fd)
    sys.stdout.write("READER READY\\r\\n"); sys.stdout.flush()
    while True:
        ch = sys.stdin.read(1)
        sys.stdout.write("GOT " + repr(ch) + "\\r\\n"); sys.stdout.flush()
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, old)
`;

const readerPath = join(tmpdir(), "shahi-keyreader.py");
writeFileSync(readerPath, READER);

const client = new HerdrClient();
await client.connect();

const created = await client.rpc("workspace.create", {
  label: WORKSPACE_LABEL,
  // Never steal focus: the user is probably attached to this session right now.
  focus: false,
  cwd: tmpdir(),
});

const paneId = created.root_pane.pane_id;
const workspaceId = created.workspace.workspace_id;
console.log(`scratch workspace ${workspaceId}, pane ${paneId}\n`);

let failures = 0;

try {
  await client.rpc("pane.send_text", { pane_id: paneId, text: `python3 ${readerPath}` });
  await client.rpc("pane.send_keys", { pane_id: paneId, keys: ["Enter"] });

  // Wait for the reader rather than guessing at a fixed delay.
  let ready = false;
  for (let attempt = 0; attempt < 40 && !ready; attempt++) {
    await Bun.sleep(250);
    const { read } = await client.rpc("pane.read", {
      pane_id: paneId,
      source: "visible",
      format: "text",
      strip_ansi: true,
    });
    ready = read.text.includes("READER READY");
  }
  if (!ready) throw new Error("the reader never started in the scratch pane");

  const cases: Array<{ keys: string[]; expect: string; why: string }> = [
    { keys: ["1"], expect: "'1'", why: "digit — how a prompt option is answered" },
    { keys: ["2"], expect: "'2'", why: "digit" },
    { keys: ["4"], expect: "'4'", why: "digit" },
    { keys: ["Enter"], expect: "'\\r'", why: "submitting a typed reply" },
    { keys: ["Escape"], expect: "'\\x1b'", why: "key bar" },
    { keys: ["C-c"], expect: "'\\x03'", why: "key bar" },
    { keys: ["Up"], expect: "'\\x1b'", why: "arrow fallback for menu selection" },
    { keys: ["Down"], expect: "'\\x1b'", why: "arrow fallback for menu selection" },
    { keys: ["Tab"], expect: "'\\t'", why: "key bar" },
  ];

  for (const testCase of cases) {
    await client.rpc("pane.send_keys", { pane_id: paneId, keys: testCase.keys });
    await Bun.sleep(400);

    const { read } = await client.rpc("pane.read", {
      pane_id: paneId,
      source: "visible",
      format: "text",
      strip_ansi: true,
    });
    const received = stripAnsi(read.text)
      .split("\n")
      .filter((l) => l.trim().startsWith("GOT "))
      .map((l) => l.trim().slice(4));

    const last = received.at(-1) ?? "(nothing)";
    // Arrows arrive as multi-byte escape sequences; the first byte is the tell.
    const ok = received.some((r) => r === testCase.expect) || last === testCase.expect;

    console.log(
      `  ${ok ? "ok  " : "FAIL"} send_keys ${JSON.stringify(testCase.keys).padEnd(12)} -> ` +
        `${last.padEnd(10)} (expected ${testCase.expect}) — ${testCase.why}`,
    );
    if (!ok) failures++;
  }

  // Multiple keys in one call, which is how an arrow-based fallback would work.
  await client.rpc("pane.send_keys", { pane_id: paneId, keys: ["Down", "Down", "Enter"] });
  await Bun.sleep(600);
  const { read } = await client.rpc("pane.read", {
    pane_id: paneId,
    source: "visible",
    format: "text",
    strip_ansi: true,
  });
  const tail = stripAnsi(read.text)
    .split("\n")
    .filter((l) => l.trim().startsWith("GOT "))
    .slice(-8)
    .map((l) => l.trim().slice(4));
  const batched = tail.includes("'\\r'");
  console.log(`  ${batched ? "ok  " : "FAIL"} a batched key sequence arrives in order — ${tail.join(" ")}`);
  if (!batched) failures++;
} finally {
  // Always clean up, even on failure: leaving a stray workspace in someone's
  // live session is not an acceptable side effect of a test.
  await client.rpc("workspace.close", { workspace_id: workspaceId }).catch((err) => {
    console.error(`\n  could not close scratch workspace ${workspaceId}: ${err.message}`);
    console.error("  close it by hand before it clutters the session.");
  });
  console.log(`\ncleaned up scratch workspace ${workspaceId}`);
}

console.log(failures === 0 ? "\nall key deliveries confirmed" : `\n${failures} key delivery check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
