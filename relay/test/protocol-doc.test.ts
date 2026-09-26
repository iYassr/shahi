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
