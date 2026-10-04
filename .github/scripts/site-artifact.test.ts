import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSiteArtifact, verifySiteArtifact } from "./site-artifact";

const COMMIT = "a".repeat(40);
const CREDENTIAL = "synthetic-publish-credential-4cfab882";
let scratch: string, directory: string, receipt: string;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "shahi-site-artifact-"));
  directory = join(scratch, "dist"); receipt = join(scratch, "release.json");
  await mkdir(join(directory, "pwa", "assets"), { recursive: true });
  await writeFile(join(directory, "index.html"), "<h1>Shahi</h1>");
  await writeFile(join(directory, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n");
  await writeFile(join(directory, "pwa", "index.html"), "<title>Shahi</title>");
  await writeFile(join(directory, "pwa", "assets", "icon.png"), Buffer.from([137, 80, 78, 71, 0, 1, 2, 255]));
});
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });
const prepare = () => prepareSiteArtifact(directory, receipt, COMMIT, CREDENTIAL);
const verify = (commit = COMMIT) => verifySiteArtifact(directory, receipt, commit, CREDENTIAL);

test("public text and binary assets get a bounded complete receipt; verification is read-only", async () => {
  const result = await prepare();
  expect(result.receipt.commit).toBe(COMMIT);
  expect(Object.keys(result.receipt.files)).toEqual(["_headers", "index.html", "pwa/assets/icon.png", "pwa/index.html"]);
  expect(result.receipt.files["index.html"]).toBe("b2137dce0bac266c6ad426e4b5e08cbf7dad30d846d16438fad4cb1635cc2b52");
  const before = await readFile(receipt);
  expect(await verify()).toEqual(result);
  expect(await readFile(receipt)).toEqual(before);
});
test("a modified public file cannot be deployed using the old receipt", async () => {
  await prepare();
  await writeFile(join(directory, "index.html"), "<h1>Modified after CI</h1>");
  await expect(verify()).rejects.toThrow("content does not match");
});
test("missing and additional files fail even when every surviving digest matches", async () => {
  await prepare();
  await rm(join(directory, "index.html"));
  await expect(verify()).rejects.toThrow("inventory does not match");
  await writeFile(join(directory, "index.html"), "<h1>Shahi</h1>");
  await writeFile(join(directory, "unexpected.html"), "New file outside the receipt");
  await expect(verify()).rejects.toThrow("inventory does not match");
});
test("the receipt must name the intended full commit SHA", async () => {
  await expect(prepareSiteArtifact(directory, receipt, "master")).rejects.toThrow("40-character Git SHA");
  await prepare();
  await expect(verify("b".repeat(40))).rejects.toThrow("different commit");
});
for (const path of ["pwa/assets/index.js.map", ".env", "pwa/.git/config", "private.pem", "signing.key", "credentials.json", "pwa/source.tsx"]) {
  test(`private artifact entry is refused: ${path}`, async () => {
    const parent = join(directory, ...path.split("/").slice(0, -1));
    await mkdir(parent, { recursive: true });
    await writeFile(join(directory, path), "private build material");
    await expect(prepare()).rejects.toThrow(/private|unsafe|hidden/);
  });
}
test("symbolic files and directories cannot redirect verification outside the artifact", async () => {
  await writeFile(join(scratch, "outside.txt"), "outside artifact");
  const link = join(directory, "outside.txt");
  await symlink(join(scratch, "outside.txt"), link);
  await expect(prepare()).rejects.toThrow("symbolic links");
  await rm(link);
  await symlink(scratch, join(directory, "outside-folder"));
  await expect(prepare()).rejects.toThrow("symbolic links");
});
test("embedded credentials and private keys fail without appearing in the error", async () => {
  const publicFile = join(directory, "pwa", "assets", "app.js");
  await writeFile(publicFile, `const leakedCredential = "${CREDENTIAL}";`);
  const error = await prepare().then(() => null, error => error as Error);
  expect(error?.message).toBe("Website artifact contains credential material.");
  expect(error?.message).not.toContain(CREDENTIAL);
  await writeFile(publicFile, "-----BEGIN RSA PRIVATE KEY-----\nsynthetic-key\n-----END RSA PRIVATE KEY-----");
  await expect(prepare()).rejects.toThrow("private key material");
});
test("unsafe manifest paths and malformed digests are refused before trusting downloaded files", async () => {
  await prepare();
  const original = JSON.parse(await readFile(receipt, "utf8"));
  for (const path of ["../outside.txt", "/absolute.txt", "pwa\\outside.txt", "pwa/.hidden", "pwa//index.html"]) {
    await writeFile(receipt, JSON.stringify({ ...original, files: { [path]: "1".repeat(64) } }));
    await expect(verify()).rejects.toThrow(/unsafe|hidden/);
  }
  await writeFile(receipt, JSON.stringify({ ...original, files: { "index.html": "not-a-digest" } }));
  await expect(verify()).rejects.toThrow("invalid file digest");
});
test("malformed, oversized and symbolic receipts cannot become deployment instructions", async () => {
  await writeFile(receipt, "not JSON");
  await expect(verify()).rejects.toThrow("valid JSON");
  await truncate(receipt, 128 * 1024 + 1);
  await expect(verify()).rejects.toThrow("bounded regular file");
  await rm(receipt);
  await symlink(join(directory, "index.html"), receipt);
  await expect(verify()).rejects.toThrow("bounded regular file");
});
test("a receipt cannot be served alongside assets and oversized files fail before being read", async () => {
  await expect(prepareSiteArtifact(directory, join(directory, "release.json"), COMMIT)).rejects.toThrow("outside the served artifact");
  const huge = join(directory, "too-large.mp4");
  await writeFile(huge, "");
  await truncate(huge, 8 * 1024 * 1024 + 1);
  await expect(prepare()).rejects.toThrow("asset budget");
});
