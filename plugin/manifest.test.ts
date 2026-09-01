/**
 * The manifest is what herdr validates on install, and a bad one is found by
 * the first person to run `herdr plugin install` rather than by CI — unless
 * CI checks it. These assert what plugins.mdx says a manifest must be, plus
 * what this plugin promises: that every command it names exists, and that the
 * herdr it asks for is the one CI proves against.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VERBS } from "./shahi";

const ROOT = join(import.meta.dir, "..");

interface Entry {
  id?: string;
  title?: string;
  contexts?: string[];
  placement?: string;
  command: string[];
  platforms?: string[];
}
interface Manifest {
  id: string;
  name: string;
  version: string;
  min_herdr_version: string;
  description?: string;
  platforms?: string[];
  build?: Entry[];
  startup?: Entry[];
  actions?: Entry[];
  panes?: Entry[];
  events?: Entry[];
}

const manifest = Bun.TOML.parse(readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8")) as Manifest;
const commands = [
  ...(manifest.build ?? []),
  ...(manifest.startup ?? []),
  ...(manifest.actions ?? []),
  ...(manifest.panes ?? []),
  ...(manifest.events ?? []),
];

describe("herdr-plugin.toml", () => {
  test("has the four required fields, as strings", () => {
    for (const key of ["id", "name", "version", "min_herdr_version"] as const) {
      expect(typeof manifest[key]).toBe("string");
      expect(manifest[key]).not.toBe("");
    }
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.min_herdr_version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("the plugin id is `shahi`, so the actions are shahi.pair and friends", () => {
    // The docs and every printed hint say `herdr plugin action invoke shahi.<x>`.
    expect(manifest.id).toBe("shahi");
    expect(manifest.id).toMatch(/^[A-Za-z0-9.:_-]+$/);
  });

  test("declares the platforms it supervises a service on, and no other", () => {
    // A user service is launchd or systemd; there is no Windows path here, and
    // an undeclared platform would install and then fail in the startup hook.
    expect(manifest.platforms).toEqual(["linux", "macos"]);
  });

  test("asks for the herdr CI proves against, not a newer one", () => {
    // The minimum supported release is pinned in ci.yml (`herdr: [v0.8.2, stable]`).
    // A manifest asking for less claims support nobody tests; one asking for
    // more refuses to install on a box CI says works.
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const pinned = ci.match(/herdr: \[v(\d+\.\d+\.\d+), stable\]/)?.[1];
    expect(pinned).toBeDefined();
    expect(manifest.min_herdr_version).toBe(pinned!);
  });

  test("action and pane ids are local ids: no dots, unique within their kind", () => {
    for (const list of [manifest.actions ?? [], manifest.panes ?? []]) {
      const ids = list.map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9:_-]+$/);
    }
  });

  test("every command is an argv array that goes through the bun shim", () => {
    // herdr runs argv without a shell, and the shim is where a missing bun is
    // turned into an instruction rather than a spawn error.
    expect(commands.length).toBeGreaterThan(0);
    for (const entry of commands) {
      expect(Array.isArray(entry.command)).toBe(true);
      expect(entry.command.slice(0, 2)).toEqual(["sh", "plugin/bun.sh"]);
      expect(existsSync(join(ROOT, entry.command[1]!))).toBe(true);
    }
  });

  test("every shahi.ts verb the manifest names is one shahi.ts knows", () => {
    const named = commands.filter((e) => e.command[3] === "plugin/shahi.ts").map((e) => e.command[4]!);
    expect(named.length).toBeGreaterThan(0);
    for (const verb of named) expect(VERBS as readonly string[]).toContain(verb);
    expect(existsSync(join(ROOT, "plugin", "shahi.ts"))).toBe(true);
  });

  test("builds the way install.sh does: dependencies, then the web client", () => {
    expect(manifest.build?.map((b) => b.command.slice(2))).toEqual([
      ["install", "--frozen-lockfile"],
      ["run", "build:web"],
    ]);
  });

  test("the startup hook is setup, and nothing else", () => {
    // Startup hooks are one-shot by contract; the sidecar itself must never
    // be one, or herdr would be its supervisor and it would die with herdr.
    expect(manifest.startup?.map((s) => s.command.at(-1))).toEqual(["setup"]);
  });

  test("offers the actions the docs promise", () => {
    const ids = (manifest.actions ?? []).map((a) => a.id).sort();
    expect(ids).toEqual(["logs", "pair", "restart", "status", "stop"]);
    for (const action of manifest.actions ?? []) {
      expect(action.title).toBeTruthy();
      expect(action.contexts?.length).toBeGreaterThan(0);
    }
  });

  test("the pair pane is a popup that runs the pair verb, and the pair action opens it", () => {
    const pane = manifest.panes?.find((p) => p.id === "pair");
    expect(pane?.placement).toBe("popup");
    expect(pane?.command.at(-1)).toBe("pair");
    expect(manifest.actions?.find((a) => a.id === "pair")?.command.at(-1)).toBe("open-pair");
  });
});
