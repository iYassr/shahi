import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTranscript, readSessionImage, readWindow } from "./session-log";

const id = "11111111-2222-4333-8444-555555555555";

test("Claude custom configuration finds its exact conversation and images", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "shahi-claude-config-")));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = root;
    const project = join(root, "projects", "project");
    await mkdir(project, { recursive: true });
    const path = join(project, `${id}.jsonl`);
    await writeFile(path, JSON.stringify({ type: "user", uuid: "image-1", message: { content: [
      { type: "text", text: "Custom configuration conversation" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ] } }) + "\n");
    expect(await findTranscript(id)).toBe(path);
    expect(JSON.stringify(await readWindow((await findTranscript(id))!))).toContain("Custom configuration conversation");
    expect(await readSessionImage(id, "image-1:0")).toMatchObject({ mediaType: "image/png" });
    // An explicit test root still wins; the override is not searched alongside
    // the default, where another account could have the same UUID.
    expect(await findTranscript(id, join(root, "missing"))).toBeNull();
    process.env.CLAUDE_CONFIG_DIR = join(root, "missing");
    expect(await findTranscript(id)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude transcript discovery requires one canonical file under its projects root", async () => {
  const root = await mkdtemp(join(tmpdir(), "shahi-claude-ownership-"));
  try {
    const projects = join(root, "projects");
    const first = join(projects, "first", `${id}.jsonl`);
    const second = join(projects, "second", `${id}.jsonl`);
    await mkdir(join(projects, "first"), { recursive: true });
    await mkdir(join(projects, "second"), { recursive: true });
    await writeFile(first, "{}\n");
    expect(await findTranscript(id, projects)).toBe(await realpath(first));
    await writeFile(second, "{}\n");
    expect(await findTranscript(id, projects)).toBeNull();
    await rm(second); await symlink(first, second);
    expect(await findTranscript(id, projects)).toBe(await realpath(first));
    await rm(second); await rm(first); await mkdir(first);
    expect(await findTranscript(id, projects)).toBeNull();
    expect(await findTranscript("../another-session", projects)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude transcript discovery follows a symlinked root but rejects a transcript escaping it", async () => {
  const root = await mkdtemp(join(tmpdir(), "shahi-claude-links-"));
  try {
    const projects = join(root, "projects");
    const candidate = join(projects, "project", `${id}.jsonl`);
    const alias = join(root, "alias");
    const outside = join(root, "outside.jsonl");
    await mkdir(join(projects, "project"), { recursive: true });
    await symlink(projects, alias);
    await writeFile(candidate, "{}\n");
    expect(await findTranscript(id, alias)).toBe(await realpath(candidate));
    await rm(candidate); await writeFile(outside, "{}\n"); await symlink(outside, candidate);
    expect(await findTranscript(id, projects)).toBeNull();
    expect(await findTranscript(id, alias)).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Claude transcript discovery refuses an in-root symlink to another session", async () => {
  const root = await mkdtemp(join(tmpdir(), "shahi-claude-session-link-"));
  try {
    const projects = join(root, "projects");
    const project = join(projects, "project");
    const otherId = "99999999-8888-4777-8666-555555555555";
    const other = join(project, `${otherId}.jsonl`);
    await mkdir(project, { recursive: true });
    await writeFile(other, "{}\n");
    await symlink(other, join(project, `${id}.jsonl`));
    expect(await findTranscript(id, projects)).toBeNull();
    expect(await findTranscript(otherId, projects)).toBe(await realpath(other));
    await symlink(project, join(projects, "project-alias"));
    expect(await findTranscript(otherId, projects)).toBe(await realpath(other));
  } finally { await rm(root, { recursive: true, force: true }); }
});
