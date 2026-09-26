/**
 * docs/relay.md is the protocol, and people build peers from it. These hold
 * the parts of it a peer copies byte for byte to the code that checks them.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RELAY_PROTOCOL } from "@shahi/shared";

const doc = readFileSync(new URL("../../docs/relay.md", import.meta.url), "utf8");

test("a hello built from the protocol document is not refused for its version", () => {
  // RELAY_PROTOCOL went to 2 and the document's heading with it, but its three
  // hello examples still said "v":1: a hello copied from them was closed by
  // the box as a protocol mismatch (pre-release bug hunt, B103).
  const hellos = [...doc.matchAll(/\{"t":"hello"[^`]*?\}\}?/g)].map((match) => match[0]);
  expect(hellos.length).toBeGreaterThanOrEqual(3);
  for (const hello of hellos) {
    const version = /"v":(\d+)/.exec(hello)?.[1];
    expect(Number(version), hello).toBe(RELAY_PROTOCOL);
  }
  expect(doc).toContain(`This file is the protocol, version ${RELAY_PROTOCOL}.`);
});

test("the close-code table closes only the side the relay's code closes", () => {
  // The table said a box data frame over 1 MiB closed the box. Since 80c2a8b
  // it closes only the phone the frame was addressed to, and the box and its
  // other phones stay connected (pre-release bug hunt, B108). Each row's
  // reason must be passed, on one line of box.ts, to a call that closes that
  // side: closeBox for the box; closePhone, refuse or phone.close for a phone.
  const source = readFileSync(new URL("../src/box.ts", import.meta.url), "utf8").split("\n");
  const table = doc.slice(doc.indexOf("**Close codes, as sent by this relay:**"));
  const rows = [...table.matchAll(/^\| `(\d{4})` \| `([^`]+)` *\| (box|phone|either) *\|/gm)].map(([, code, reason, to]) => ({ code: code!, reason: reason!, to: to! }));
  expect(rows.length).toBeGreaterThanOrEqual(10);
  const closes = (reason: string, calls: RegExp) => source.some((line) => line.includes(`"${reason}"`) && calls.test(line));
  for (const { code, reason, to } of rows) {
    if (to !== "phone") expect(closes(reason, /\bcloseBox\(/), `${code} ${reason} closes the box`).toBe(true);
    if (to !== "box") expect(closes(reason, /\b(closePhone|refuse|phone\.close)\(/), `${code} ${reason} closes a phone`).toBe(true);
  }
});
