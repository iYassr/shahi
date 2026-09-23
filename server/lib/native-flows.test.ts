/**
 * The native flows drive the app that exists.
 *
 * Nothing in CI boots a simulator, so the Maestro flows (`.maestro/`,
 * `e2e/native/`) and the XCUITests (`mobile/uitests/`) only run by hand — and
 * by September 2026 every Maestro flow still signed in through a typed-address
 * screen deleted weeks earlier: they waited for "Connect your server", typed
 * into `server-address`, and ran helpers from a folder that no longer matched
 * the fixture. Each failed at its first step, yet the docs counted them as the
 * native coverage. This reads the flows the way Maestro would and checks every
 * element id, every piece of text they wait for and every file they run
 * against what the app and its fixture can actually show. It lives here
 * because this is where CI's unit suite looks.
 */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");

const files = (...patterns: string[]) =>
  patterns.flatMap((pattern) => [...new Glob(pattern).scanSync({ cwd: ROOT, dot: true })]).sort();
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

const FLOWS = files(".maestro/**/*.yaml", "e2e/native/*.yaml");
const FLOW_SCRIPTS = files("e2e/native/*.ts");
const XCUITESTS = files("mobile/uitests/ShahiUITests/*.swift");
const APP = files("mobile/src/**/*.{ts,tsx}").filter((file) => !/\.(test|pentest)\.tsx?$/.test(file));

/** Every testID the app sets: exact ones, and the fixed start of each built one (`row-${paneId}` gives `row-`). */
const testIds = (() => {
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const file of APP) {
    for (const [, literal, template] of read(file).matchAll(/testID=(?:"([^"]+)"|\{`([^`$]*)\$\{)/g)) {
      if (literal) exact.add(literal);
      if (template) prefixes.add(template);
    }
  }
  return { exact, prefixes };
})();

/** Whether the app sets this id, or one starting with `prefix` when the reference is itself built. */
function appHas(id: string, built = false): boolean {
  if (testIds.exact.has(id)) return true;
  for (const prefix of testIds.prefixes) if (prefix && id.startsWith(prefix) && (built || id.length > prefix.length)) return true;
  return built && [...testIds.exact].some((exact) => exact.startsWith(id));
}

/** Everything the app, the shared contract and the fixture's stub can put on screen. */
const CAN_SHOW = files("mobile/src/**/*.{ts,tsx}", "shared/src/**/*.ts", "e2e/stub/*.ts")
  .filter((file) => !/\.(test|pentest)\.tsx?$/.test(file))
  .map(read)
  .join("\n")
  .toLowerCase();

/**
 * The words a text matcher needs from the source. Maestro matches the whole
 * accessibility label as a regular expression, and labels are often built
 * (`${name}, Connected`, `Waiting ${count}`): so drop a `.*` at either end and
 * split where interpolated names, numbers and punctuation go.
 */
function wordsOf(matcher: string): string[] {
  return matcher
    .replace(/^\.\*/, "")
    .replace(/\.\*$/, "")
    .replace(/\\(.)/g, "$1")
    .split(/[^\p{L}\s'’-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.replace(/[^\p{L}]/gu, "").length >= 3);
}

/** Commands whose string value, or whose listed keys, is something that must be on screen. */
const SHOWN = new Set(["tapOn", "longPressOn", "doubleTapOn", "assertVisible", "extendedWaitUntil", "scrollUntilVisible", "swipe"]);
const SHOWN_KEYS = new Set(["visible", "element", "from", "text"]);

interface FlowRefs { ids: string[]; texts: string[]; typed: string[]; runs: string[] }

function refsOf(file: string): FlowRefs {
  const refs: FlowRefs = { ids: [], texts: [], typed: [], runs: [] };
  const visit = (node: unknown, shown: boolean): void => {
    if (Array.isArray(node)) return node.forEach((child) => visit(child, shown));
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      // A matcher for what must *not* be there may name anything at all.
      if (key === "assertNotVisible" || key === "notVisible") continue;
      if (key === "id" && typeof value === "string") refs.ids.push(value);
      else if (key === "inputText" && typeof value === "string") refs.typed.push(value);
      else if ((key === "runScript" || key === "runFlow") && typeof value === "string") refs.runs.push(value);
      else if (key === "file" && typeof value === "string") refs.runs.push(value);
      else if (typeof value === "string" && shown && (SHOWN.has(key) || SHOWN_KEYS.has(key))) refs.texts.push(value);
      else visit(value, SHOWN.has(key) || (shown && SHOWN_KEYS.has(key)));
    }
  };
  visit(Bun.YAML.parse(read(file)), false);
  return refs;
}

describe("the native flows drive the app that exists", () => {
  test("there are flows to check", () => {
    expect(FLOWS.length).toBeGreaterThan(0);
    expect(XCUITESTS.length).toBeGreaterThan(0);
  });

  test("every element id a flow uses is one the app sets", () => {
    const missing: string[] = [];
    for (const file of FLOWS) {
      for (const id of refsOf(file).ids) {
        // `${VAR}` is filled in when the flow runs; only its fixed start is known.
        const built = id.includes("${");
        const known = built ? id.slice(0, id.indexOf("${")) : id;
        if (!appHas(known, built)) missing.push(`${file}: ${id}`);
      }
    }
    for (const file of FLOW_SCRIPTS) {
      for (const [, literal, template] of read(file).matchAll(/\b(?:tap|scroll)\((?:"([^"]+)"|`([^`$]*)\$\{)/g)) {
        if (literal && !appHas(literal)) missing.push(`${file}: ${literal}`);
        if (template && !appHas(template, true)) missing.push(`${file}: ${template}…`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every word a flow waits for is one the app or its fixture can show", () => {
    const missing: string[] = [];
    for (const file of FLOWS) {
      const refs = refsOf(file);
      const typed = refs.typed.join("\n").toLowerCase();
      for (const text of refs.texts) {
        for (const words of wordsOf(text)) {
          const needle = words.toLowerCase();
          if (!CAN_SHOW.includes(needle) && !typed.includes(needle)) missing.push(`${file}: "${words}" (from ${text})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test("every script and subflow a flow runs is still there", () => {
    const missing: string[] = [];
    for (const file of FLOWS) {
      for (const run of refsOf(file).runs) {
        if (!existsSync(resolve(ROOT, dirname(file), run))) missing.push(`${file}: ${run}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the XCUITests find the app's elements by ids it still sets", () => {
    const missing: string[] = [];
    const kebab = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
    for (const file of XCUITESTS) {
      const source = read(file);
      const exact = [
        ...source.matchAll(/\b(?:buttons|otherElements)\["([^"]+)"\]/g),
        ...source.matchAll(/descendants\(matching: \.any\)\["([^"]+)"\]/g),
        ...source.matchAll(/\bbyId\("([^"]+)"\)/g),
        ...source.matchAll(/identifier == '([^']+)'/g),
      ].map((match) => match[1]!);
      // Lower-case kebab is how this app names its ids; the other strings
      // these queries take are labels ("Settings") or iOS's own ("BackButton").
      for (const id of exact.filter((value) => kebab.test(value) && value.includes("-"))) {
        if (!appHas(id)) missing.push(`${file}: ${id}`);
      }
      for (const [, prefix] of source.matchAll(/identifier BEGINSWITH '([^']+)'/g)) {
        if (!appHas(prefix!, true)) missing.push(`${file}: ${prefix}…`);
      }
    }
    expect(missing).toEqual([]);
  });
});
