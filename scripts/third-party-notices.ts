/**
 * Third-party notices, read from what a build actually ships.
 *
 * MIT, ISC, BSD and Apache all ask that their notice travel with every copy,
 * and the app and the web client are copies of a few hundred packages. Neither
 * carried those notices before the September 2026 pre-release review (F27).
 * A hand-kept list would be wrong by the next dependency update, so the
 * clients hand this module the files their bundler actually used — Metro's
 * source map and Expo's autolinking for the app, Vite's module graph for the
 * web client — and it reads each package's own licence file.
 *
 * Plain Node APIs only: the web build imports it from its Vite config, and
 * `scripts/app-notices.ts` runs it under Bun.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export interface PackageNotice {
  name: string;
  version: string;
  /** The package.json licence expression, "UNKNOWN" when it declares none. */
  license: string;
  /** Index into `texts`; null when the package ships no licence file. */
  text: number | null;
  /** Where the licence is, for a package that ships no file of its own. */
  note?: string;
}

export interface Notices {
  packages: PackageNotice[];
  /** Each distinct licence text once: most packages share a handful. */
  texts: string[];
}

/** A notice that no package.json describes: vendored binaries and artwork. */
export interface ExtraNotice {
  name: string;
  license: string;
  text: string;
}

const NODE_MODULES = `${sep}node_modules${sep}`;

/**
 * The installed package a file belongs to — the innermost
 * `node_modules/<name>` or `node_modules/@scope/<name>` on its path — or
 * undefined for Shahi's own files, which are not third-party.
 */
export function packageDirOf(file: string): string | undefined {
  const at = file.lastIndexOf(NODE_MODULES);
  if (at < 0) return undefined;
  const rest = file.slice(at + NODE_MODULES.length).split(sep);
  const name = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  if (name.length === 0 || name.some((part) => !part)) return undefined;
  return file.slice(0, at + NODE_MODULES.length) + name.join(sep);
}

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  licenses?: { type?: string }[];
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function manifest(dir: string): PackageJson {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;
}

function licenseId(pkg: PackageJson): string {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  const legacy = (pkg.licenses ?? []).map((entry) => entry.type).filter(Boolean);
  return legacy.length ? legacy.join(" OR ") : "UNKNOWN";
}

// LICENSE, LICENCE, LICENSE.md, LICENSE-MIT, COPYING… and Apache's NOTICE,
// which section 4(d) asks to be passed on as well. Not code that happens to
// be called license.js.
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([._-].*)?$/i;
const CODE_FILE = /\.(c|m)?[jt]sx?$|\.json$|\.map$/i;

/** Line endings and surrounding blank lines only; the words stay as shipped. */
function normalise(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/^\s*\n/, "").trimEnd();
}

function licenseFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name) && !CODE_FILE.test(entry.name))
    .map((entry) => entry.name)
    // NOTICE after the licence it belongs to; otherwise a stable order.
    .sort((a, b) => Number(/^notice/i.test(a)) - Number(/^notice/i.test(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

function readLicense(dir: string, files: string[]): string | null {
  return files.map((file) => normalise(readFileSync(join(dir, file), "utf8"))).filter(Boolean).join("\n\n") || null;
}

/** `git+https://…/x.git`, `git@github.com:o/r`, `github:o/r` and `o/r` as a link. */
function repositoryUrl(pkg: PackageJson): string | undefined {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (!raw) return undefined;
  const url = raw.replace(/^git\+/, "").replace(/\.git$/, "")
    .replace(/^(ssh:\/\/)?git@github\.com[:/]/, "https://github.com/")
    .replace(/^git:\/\//, "https://");
  if (/^github:/.test(url)) return url.replace(/^github:/, "https://github.com/");
  return /^[\w.-]+\/[\w.-]+$/.test(url) ? `https://github.com/${url}` : url;
}

/** One package's licence, read from the files it ships. */
export function readPackage(dir: string): Omit<PackageNotice, "text"> & { text: string | null } {
  const pkg = manifest(dir);
  const text = readLicense(dir, licenseFiles(dir));
  const license = licenseId(pkg);
  const repository = repositoryUrl(pkg);
  return {
    name: pkg.name ?? dir.slice(dir.lastIndexOf(NODE_MODULES) + NODE_MODULES.length),
    version: pkg.version ?? "0.0.0",
    license,
    text,
    // Said plainly rather than filled in: an MIT text with no copyright line
    // would be a notice nobody wrote.
    ...(text ? {} : {
      note: `The published package includes no licence file. Its package.json declares ${license}${repository ? `, and its source and licence are at ${repository}` : ""}.`,
    }),
  };
}

/**
 * Licence files below a package's root: code another project wrote, copied
 * in (`vendor/bspatch/LICENSE`), or files for another platform
 * (`android/LICENSE`). Paths are relative to the package, `/`-separated.
 */
export function nestedLicenseFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules") walk(join(at, entry.name), `${prefix}${entry.name}/`);
    }
    if (prefix) for (const file of licenseFiles(at)) found.push(`${prefix}${file}`);
  };
  walk(dir, "");
  return found.sort();
}

/**
 * Whether the build ships the code a nested licence file covers: its licence
 * expression if so, null if not. `pkg` is the package's name, `file` the
 * licence file's path inside it and `dir` the package's directory.
 */
export type NestedPolicy = (pkg: string, file: string, dir: string) => string | null;

const byNameThenVersion = (a: { name: string; version: string }, b: { name: string; version: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0;

/**
 * The notices for a set of package directories, each distinct text once. A
 * nested licence the policy says ships is listed as its own entry, named by
 * its directory inside the package: `expo-updates/vendor/bspatch`.
 */
export function collectNotices(dirs: Iterable<string>, nested: NestedPolicy = () => null): Notices {
  const seen = new Map<string, ReturnType<typeof readPackage>>();
  for (const dir of dirs) {
    const found = readPackage(dir);
    seen.set(`${found.name}@${found.version}`, found);
    for (const file of nestedLicenseFiles(dir)) {
      const license = nested(found.name, file, dir);
      if (license === null) continue;
      const at = file.slice(0, file.lastIndexOf("/"));
      const name = `${found.name}/${at}`;
      const previous = seen.get(`${name}@${found.version}`)?.text;
      const text = readLicense(join(dir, at), [file.slice(at.length + 1)]);
      seen.set(`${name}@${found.version}`, { name, version: found.version, license, text: [previous, text].filter(Boolean).join("\n\n") || null });
    }
  }
  const texts: string[] = [];
  const index = new Map<string, number>();
  const packages = [...seen.values()].sort(byNameThenVersion).map(({ text, ...rest }): PackageNotice => {
    if (text === null) return { ...rest, text: null };
    if (!index.has(text)) { index.set(text, texts.length); texts.push(text); }
    return { ...rest, text: index.get(text)! };
  });
  return { packages, texts };
}

/** Packages that share one text, in the order the texts were first used. */
export function groupByText(notices: Notices): { packages: PackageNotice[]; text: string | null }[] {
  const groups = notices.texts.map((text) => ({ packages: [] as PackageNotice[], text: text as string | null }));
  const without: { packages: PackageNotice[]; text: string | null }[] = [];
  for (const pkg of notices.packages) {
    if (pkg.text === null) without.push({ packages: [pkg], text: null });
    else groups[pkg.text]!.packages.push(pkg);
  }
  return [...groups, ...without];
}

function resolvePackage(name: string, from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Every installed package the project's production dependencies reach, as
 * directory → `name@version`: dependencies and installed peers, never dev or
 * optional ones. Optional dependencies are skipped because they are the
 * platform-specific binaries of build tools, installed on one OS and not
 * another, and this list must come out the same on a Mac and in CI.
 *
 * It is wider than any bundle — Expo's CLI and Metro are in it — which is the
 * point: no package can enter a build without first entering this list, so a
 * change to it is exactly when the notices must be generated again.
 */
export function dependencyClosure(project: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (dir: string) => {
    const pkg = manifest(dir);
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })) {
      const resolved = resolvePackage(name, dir);
      if (!resolved || found.has(resolved)) continue;
      const dependency = manifest(resolved);
      found.set(resolved, `${dependency.name}@${dependency.version}`);
      visit(resolved);
    }
  };
  visit(realpathSync(project));
  return found;
}

/** A short fingerprint of that closure: which versions, not where they sit. */
export function closureDigest(closure: Map<string, string>): string {
  return createHash("sha256").update([...new Set(closure.values())].sort().join("\n")).digest("hex");
}

/** A plain-text notices file, as the web build publishes beside the app. */
export function formatNotices(title: string, extras: ExtraNotice[], notices: Notices): string {
  const rule = "-".repeat(72);
  const blocks = [
    `${title}\n${"=".repeat(title.length)}`,
    ...extras.map((extra) => `${rule}\n${extra.name} (${extra.license})\n\n${extra.text.trim()}`),
    ...groupByText(notices).map(({ packages, text }) => {
      const names = packages.map((pkg) => `${pkg.name} ${pkg.version} (${pkg.license})`).join("\n");
      return `${rule}\n${names}\n\n${text ?? packages[0]!.note}`;
    }),
  ];
  return `${blocks.join("\n\n")}\n`;
}
