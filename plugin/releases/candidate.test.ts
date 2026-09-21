import { expect, test } from "bun:test";
import { sha256, type Release } from "./catalog";
import { verifyCandidate } from "./candidate";
import definition from "./release.json";

const bytes = new TextEncoder().encode("tested archive");
const commit = "a".repeat(40);
const release = { ...definition, buildId: `${definition.version}-${commit.slice(0, 12)}`, commit,
  artifact: { url: `https://github.com/iYassr/shahi/releases/download/v${definition.version}/shahi-service.tar.gz`, bytes: bytes.length, sha256: sha256(bytes) } } as Release;

test("only the tested commit, version and exact archive may be signed", () => {
  expect(() => verifyCandidate(release, bytes, commit, definition.version)).not.toThrow();
  expect(() => verifyCandidate(release, bytes, "b".repeat(40), definition.version)).toThrow("source");
  expect(() => verifyCandidate(release, bytes, commit, "99.0.0")).toThrow("source");
  expect(() => verifyCandidate(release, new TextEncoder().encode("changed archive"), commit, definition.version)).toThrow("integrity");
  const corrupted = bytes.slice(); corrupted[0] = corrupted[0]! ^ 1;
  expect(() => verifyCandidate(release, corrupted, commit, definition.version)).toThrow("integrity");
});
