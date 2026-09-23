import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { agentIdentity } from "./brand";
import { ARTWORK_NOTICES, OCTICONS_LICENSE, TABLER_LICENSE } from "./artwork-notices";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/*
 * Both clients draw Tabler's pi and GitHub's Copilot mark, whose MIT licenses
 * ask for their notice to travel with every copy; neither client carried it
 * before the September 2026 review (F27). The texts are pinned to the
 * upstream files so a retyped or trimmed notice fails here.
 */
test("the pi and Copilot marks carry Tabler's and Octicons' license files word for word", () => {
  // tabler/tabler-icons LICENSE at v3.48.0; primer/octicons LICENSE at @primer/octicons@19.38.0.
  expect(sha256(TABLER_LICENSE)).toBe("b740a1d46122672da62833e97f7e7c8a13fa85cbc7445b584b297cc00dde93db");
  expect(sha256(OCTICONS_LICENSE)).toBe("da259c8bd0de62713ccdcf88910aebca810644f98c2c912bad814fc79ea778df");
});

test("the notices cover the artwork brand.ts actually draws", () => {
  // Tabler's math-pi and Simple Icons' githubcopilot, as Iconify serves them.
  expect(agentIdentity("pi").d).toBe("M7 20V4m10 0v16m3-16H4");
  expect(agentIdentity("copilot").d.startsWith("M23.922 16.997C23.061 18.492")).toBe(true);
  expect(ARTWORK_NOTICES.map((notice) => notice.name)).toEqual(["Tabler Icons", "Primer Octicons", "Simple Icons"]);
});
