/** Public website receipts: private build artifacts never enter the upload. */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 128 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const PRIVATE_EXTENSIONS = new Set([".map", ".env", ".key", ".pem", ".p12", ".pfx", ".keystore", ".jks", ".ts", ".tsx", ".jsx"]);
const PRIVATE_NAME = /(?:^|[._-])(?:secrets?|credentials?|tokens?)(?:[._-]|$)/i;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;
export interface SiteReceipt { schema: 1; commit: string; files: Record<string, string> }
export interface SiteArtifact { receipt: SiteReceipt; bytes: number }
export class SiteArtifactError extends Error {}
function refuse(reason: string): never { throw new SiteArtifactError(reason); }

function commitOf(value: string): string {
  if (!SHA.test(value)) refuse("Website commit must be a lowercase 40-character Git SHA.");
  return value;
}
function safePath(path: string): void {
  const parts = path.split("/");
  if (!path || parts.length > 8 || parts.some(part => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part))) refuse("Website artifact has an unsafe or hidden path.");
  if (PRIVATE_EXTENSIONS.has(extname(path).toLowerCase()) || PRIVATE_NAME.test(parts.at(-1)!)) refuse("Website artifact contains a private or source file.");
}
function separateReceipt(directory: string, receiptPath: string): void {
  const path = relative(resolve(directory), resolve(receiptPath));
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))) refuse("Keep the website receipt outside the served artifact.");
}
async function inventory(directory: string, credential?: string): Promise<{ files: Record<string, string>; bytes: number }> {
  const files: [string, string][] = [];
  let bytes = 0;
  async function visit(folder: string, prefix = ""): Promise<void> {
    const info = await lstat(folder).catch(() => refuse("Cannot inspect the website artifact directory."));
    if (!info.isDirectory() || info.isSymbolicLink()) refuse("Website artifact directories must be real directories.");
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => refuse("Cannot list the website artifact."));
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      safePath(path);
      const absolute = resolve(folder, entry.name);
      if (entry.isSymbolicLink()) refuse("Website artifacts must not contain symbolic links.");
      if (entry.isDirectory()) { await visit(absolute, path); continue; }
      if (!entry.isFile()) refuse("Website artifacts must contain only regular files.");
      const stat = await lstat(absolute).catch(() => refuse("Cannot inspect a website artifact file."));
      if (!stat.isFile() || stat.isSymbolicLink()) refuse("Website artifacts must contain only regular files.");
      if (files.length >= MAX_FILES || stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_TOTAL_BYTES) refuse("Website artifact exceeds its public asset budget.");
      const contents = await readFile(absolute).catch(() => refuse("Cannot read a website artifact file."));
      if (contents.length !== stat.size) refuse("A website file changed during inspection.");
      // Report only a fixed reason: never echo a credential, its match or a filename containing it.
      if (credential && (path.includes(credential) || contents.includes(Buffer.from(credential)))) refuse("Website artifact contains credential material.");
      if (PRIVATE_KEY.test(contents.toString("utf8"))) refuse("Website artifact contains private key material.");
      bytes += contents.length;
      files.push([path, createHash("sha256").update(contents).digest("hex")]);
    }
  }
  await visit(resolve(directory));
  if (files.length === 0) refuse("Website artifact is empty.");
  files.sort(([a], [b]) => a.localeCompare(b, "en"));
  return { files: Object.fromEntries(files), bytes };
}

/** Build on the approved commit; the receipt and source maps stay outside site/dist. */
export async function prepareSiteArtifact(directory: string, receiptPath: string, commit: string, credential?: string): Promise<SiteArtifact> {
  commitOf(commit); separateReceipt(directory, receiptPath);
  const previous = await lstat(receiptPath).catch(error => { if (error?.code === "ENOENT") return undefined; return refuse("Cannot inspect the website receipt path."); });
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) refuse("Website receipt must be a regular file.");
  const { files, bytes } = await inventory(directory, credential);
  const receipt: SiteReceipt = { schema: 1, commit, files };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n").catch(() => refuse("Cannot write the website receipt."));
  return { receipt, bytes };
}

function receiptOf(value: unknown): SiteReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("Website receipt is malformed.");
  const receipt = value as Partial<SiteReceipt>;
  if (Object.keys(receipt).sort().join(",") !== "commit,files,schema" || receipt.schema !== 1 || typeof receipt.commit !== "string") refuse("Website receipt is malformed.");
  commitOf(receipt.commit);
  if (!receipt.files || typeof receipt.files !== "object" || Array.isArray(receipt.files)) refuse("Website receipt inventory is malformed.");
  const entries = Object.entries(receipt.files);
  if (entries.length === 0 || entries.length > MAX_FILES) refuse("Website receipt inventory is malformed.");
  for (const [path, hash] of entries) { safePath(path); if (typeof hash !== "string" || !HASH.test(hash)) refuse("Website receipt has an invalid file digest."); }
  return receipt as SiteReceipt;
}

/** Verify downloaded bytes without rewriting either the artifact or its receipt. */
export async function verifySiteArtifact(directory: string, receiptPath: string, commit: string, credential?: string): Promise<SiteArtifact> {
  commitOf(commit); separateReceipt(directory, receiptPath);
  const stat = await lstat(receiptPath).catch(() => refuse("Cannot inspect the website receipt."));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) refuse("Website receipt is not a bounded regular file.");
  const text = await readFile(receiptPath, "utf8").catch(() => refuse("Cannot read the website receipt."));
  let value: unknown;
  try { value = JSON.parse(text); } catch { refuse("Website receipt is not valid JSON."); }
  const receipt = receiptOf(value);
  if (receipt.commit !== commit) refuse("Website artifact was built from a different commit.");
  const { files, bytes } = await inventory(directory, credential);
  const paths = Object.keys(files).sort(), recorded = Object.keys(receipt.files).sort();
  if (paths.length !== recorded.length || paths.some((path, index) => path !== recorded[index])) refuse("Website artifact file inventory does not match its receipt.");
  if (paths.some(path => files[path] !== receipt.files[path])) refuse("Website artifact content does not match its receipt.");
  return { receipt, bytes };
}

if (import.meta.main) {
  try {
    const [mode, directory, receiptPath, commit, ...extra] = process.argv.slice(2);
    if ((mode !== "prepare" && mode !== "verify") || !directory || !receiptPath || !commit || extra.length) refuse("Usage: site-artifact.ts prepare|verify <artifact-directory> <receipt-path> <commit-sha>");
    const result = await (mode === "prepare" ? prepareSiteArtifact : verifySiteArtifact)(directory, receiptPath, commit, process.env.SENTRY_AUTH_TOKEN);
    console.log(`${mode === "prepare" ? "Prepared" : "Verified"} website artifact: ${result.receipt.commit}, ${Object.keys(result.receipt.files).length} files, ${result.bytes} bytes.`);
  } catch (error) {
    console.error(error instanceof SiteArtifactError ? error.message : "Website artifact validation failed.");
    process.exitCode = 1;
  }
}
