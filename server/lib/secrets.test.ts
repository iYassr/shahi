import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";
import { ensureSecrets, envFilePath, randomPasscode, readEnvFile, renderEnvFile, writeEnvFile } from "./secrets";

const scratch = () => mkdtempSync(join(tmpdir(), "shahi-secrets-"));

describe("envFilePath", () => {
  test("is the repo root .env unless SHAHI_ENV_FILE says otherwise", () => {
    expect(envFilePath({} as NodeJS.ProcessEnv)).toMatch(/\/\.env$/);
    expect(envFilePath({} as NodeJS.ProcessEnv)).not.toContain("/server/");
    expect(envFilePath({ SHAHI_ENV_FILE: "/x/plugin/.env" } as NodeJS.ProcessEnv)).toBe("/x/plugin/.env");
  });
});

describe("readEnvFile", () => {
  test("keeps `$` intact rather than expanding it", () => {
    // Bun's own loader would expand `$2b` away to nothing. This parser is the
    // reason pair.ts and the plugin can read what init-secrets wrote.
    const dir = scratch();
    const path = join(dir, ".env");
    writeEnvFile(path, new Map([["A", "$2b$12$abc"], ["B", "with=equals"]]));
    const env = readEnvFile(path);
    expect(env.get("A")).toBe("$2b$12$abc");
    expect(env.get("B")).toBe("with=equals");
  });

  test("a missing file is an empty map, not an error", () => {
    expect(readEnvFile(join(scratch(), "absent")).size).toBe(0);
  });
});

describe("ensureSecrets", () => {
  test("first run creates everything and hashes the passcode base64-wrapped", async () => {
    const { env, created, kept } = await ensureSecrets(new Map(), { passcode: "4821" });
    expect(kept).toEqual([]);
    expect(created).toContain("SESSION_SECRET");
    expect(created).toContain("PASSCODE_HASH_B64");
    expect(created).toContain("VAPID_PUBLIC_KEY");
    expect(env.get("PASSCODE_HASH_B64")).not.toContain("$");
    expect(Buffer.from(env.get("PASSCODE_HASH_B64")!, "base64").toString("utf8")).toMatch(/^\$2[aby]\$/);
  });

  test("a second run keeps every existing value", async () => {
    // Regenerating SESSION_SECRET signs every phone out and a new VAPID pair
    // drops every push subscription — a re-run must never do either.
    const first = await ensureSecrets(new Map(), { passcode: "4821" });
    const snapshot = new Map(first.env);
    const second = await ensureSecrets(first.env, {});
    expect(second.created).toEqual([]);
    expect([...second.env]).toEqual([...snapshot]);
  });

  test("no passcode and none before means a visibly empty gate, not an absent key", async () => {
    const { env, created } = await ensureSecrets(new Map(), {});
    expect(env.get("PASSCODE_HASH_B64")).toBe("");
    expect(created.join()).toContain("gate disabled");
  });

  test("keeps keys it does not know about, such as PORT", async () => {
    const { env } = await ensureSecrets(new Map([["PORT", "7275"]]), {});
    expect(env.get("PORT")).toBe("7275");
    expect(renderEnvFile(env)).toContain("PORT=7275");
  });

  test("--force regenerates", async () => {
    const first = await ensureSecrets(new Map(), {});
    const secret = first.env.get("SESSION_SECRET");
    const second = await ensureSecrets(first.env, { force: true });
    expect(second.env.get("SESSION_SECRET")).not.toBe(secret);
  });
});

describe("writeEnvFile", () => {
  test("is created mode 0600 and round-trips through loadConfig", async () => {
    const path = join(scratch(), ".env");
    const { env } = await ensureSecrets(new Map([["PORT", "7275"]]), { passcode: "4821" });
    writeEnvFile(path, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("SESSION_SECRET=");

    // The server side of the same contract: named by SHAHI_ENV_FILE, and the
    // process environment still wins over the file.
    const config = loadConfig({ SHAHI_ENV_FILE: path } as NodeJS.ProcessEnv);
    expect(config.port).toBe(7275);
    expect(config.sessionSecret).toBe(env.get("SESSION_SECRET")!);
    expect(config.passcodeHash).toMatch(/^\$2[aby]\$/);
    expect(loadConfig({ SHAHI_ENV_FILE: path, PORT: "9000" } as NodeJS.ProcessEnv).port).toBe(9000);
  });
});

describe("writeEnvFile on a file someone made by hand", () => {
  test("tightens a 0644 file to 0600 before putting the session key in it", async () => {
    // The plugin's documented way to choose a port is to create the .env with
    // just `PORT=` in it — at whatever mode the shell gives a new file.
    const path = join(scratch(), ".env");
    writeFileSync(path, "PORT=7275\n", { mode: 0o644 });
    const { env } = await ensureSecrets(readEnvFile(path), {});
    writeEnvFile(path, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readEnvFile(path).get("PORT")).toBe("7275");
  });
});

describe("randomPasscode", () => {
  test("is four digits", () => {
    for (let i = 0; i < 50; i++) expect(randomPasscode()).toMatch(/^[1-9]\d{3}$/);
  });
});
