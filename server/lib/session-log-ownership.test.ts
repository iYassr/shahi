import { expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findTranscript } from "./session-log";

const id = "11111111-2222-4333-8444-555555555555";

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
