/**
 * The custom commands offered in the composer's picker, read from scratch
 * configuration and project folders: a test must never read or change the
 * person's own ~/.claude or ~/.codex.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { builtinCommands, type SlashCommand } from "@shahi/shared";
import { clean, frontmatter, MAX_COMMANDS, paneCommands, type CommandRoots } from "./slash-commands";

const scratch = mkdtempSync(join(tmpdir(), "shahi-commands-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
/** A fresh home with Claude Code's configuration folder inside it. */
function setup(): { roots: CommandRoots; home: string } {
  const home = join(scratch, `home${n++}`);
  mkdirSync(home, { recursive: true });
  return { home, roots: { home, claudeDir: join(home, ".claude") } };
}
function file(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const custom = (list: SlashCommand[]) => list.filter((c) => c.source !== "builtin");

describe("Claude Code's own commands and skills", () => {
  test("a command is named by its file, a subfolder joins on with a colon, and its description is the frontmatter's", async () => {
    const { roots } = setup();
    file(join(roots.claudeDir, "commands", "hello.md"), "---\ndescription: Say hello\n---\nSay hello to $ARGUMENTS.\n");
    file(join(roots.claudeDir, "commands", "frontend", "component.md"), "---\ndescription: \"Make a \\\"component\\\"\"\nargument-hint: [name]\n---\nBody.\n");
    const list = await paneCommands("claude", null, roots);
    expect(custom(list)).toEqual([
      { name: "frontend:component", description: 'Make a "component"', source: "user" },
      { name: "hello", description: "Say hello", source: "user" },
    ]);
  });

  test("with no description, the first line written stands in, as in Claude's menu", async () => {
    const { roots } = setup();
    file(join(roots.claudeDir, "commands", "plain.md"), "\n\nReview the open pull request carefully.\nThen more.\n");
    expect(custom(await paneCommands("claude", null, roots))).toEqual([{ name: "plain", description: "Review the open pull request carefully.", source: "user" }]);
  });

  test("a skill is named by its folder or its frontmatter name, and one only Claude may invoke is not offered", async () => {
    const { roots } = setup();
    file(join(roots.claudeDir, "skills", "deploy-staging", "SKILL.md"), "---\nname: deploy\ndescription: >\n  Deploy the branch\n  to staging\n---\n# Deploy\n");
    file(join(roots.claudeDir, "skills", "audit", "SKILL.md"), "---\ndescription: Audit dependencies # weekly\n---\n");
    file(join(roots.claudeDir, "skills", "background", "SKILL.md"), "---\ndescription: Context only Claude loads\nuser-invocable: false\n---\n");
    file(join(roots.claudeDir, "skills", "empty", "README.md"), "no SKILL.md here");
    expect(custom(await paneCommands("claude", null, roots))).toEqual([
      { name: "audit", description: "Audit dependencies", source: "user" },
      { name: "deploy", description: "Deploy the branch to staging", source: "user" },
    ]);
  });

  test("the project's commands come from the folder Claude started in and each parent up to the repository root", async () => {
    const { roots, home } = setup();
    const repo = join(home, "work", "repo");
    const app = join(repo, "packages", "app");
    mkdirSync(join(repo, ".git"), { recursive: true });
    file(join(repo, ".claude", "commands", "ship.md"), "---\ndescription: Ship it\n---\n");
    file(join(app, ".claude", "skills", "lint", "SKILL.md"), "---\ndescription: Lint the app\n---\n");
    // Above the repository: not this project's.
    file(join(home, "work", ".claude", "commands", "stranger.md"), "---\ndescription: Not ours\n---\n");
    const list = custom(await paneCommands("claude", app, roots));
    expect(list).toEqual([
      { name: "lint", description: "Lint the app", source: "project" },
      { name: "ship", description: "Ship it", source: "project" },
    ]);
  });

  test("outside a repository only the starting folder is the project, and the home folder never is", async () => {
    const { roots, home } = setup();
    const loose = join(home, "notes", "today");
    file(join(loose, ".claude", "commands", "here.md"), "---\ndescription: Here\n---\n");
    file(join(home, "notes", ".claude", "commands", "parent.md"), "---\ndescription: Parent\n---\n");
    expect(custom(await paneCommands("claude", loose, roots)).map((c) => c.name)).toEqual(["here"]);
    // The home folder's .claude is the person's own configuration, read as
    // such, and not a second time as a project.
    file(join(roots.claudeDir, "commands", "mine.md"), "---\ndescription: Mine\n---\n");
    expect(custom(await paneCommands("claude", home, roots))).toEqual([{ name: "mine", description: "Mine", source: "user" }]);
  });

  test("a personal command wins over a project one of the same name, and a skill over a command", async () => {
    const { roots, home } = setup();
    const project = join(home, "p");
    file(join(roots.claudeDir, "commands", "deploy.md"), "---\ndescription: Personal deploy\n---\n");
    file(join(project, ".claude", "commands", "deploy.md"), "---\ndescription: Project deploy\n---\n");
    file(join(project, ".claude", "commands", "test.md"), "---\ndescription: Command test\n---\n");
    file(join(project, ".claude", "skills", "test", "SKILL.md"), "---\ndescription: Skill test\n---\n");
    expect(custom(await paneCommands("claude", project, roots))).toEqual([
      { name: "deploy", description: "Personal deploy", source: "user" },
      { name: "test", description: "Skill test", source: "project" },
    ]);
  });

  // "Your skill replaces the bundled command" (Claude Code's skills docs);
  // /security-review is one of the bundled ones.
  test("the built-ins come after, and the person's own of the same name is the one described", async () => {
    const { roots } = setup();
    file(join(roots.claudeDir, "skills", "security-review", "SKILL.md"), "---\ndescription: Our security checklist\n---\n");
    const list = await paneCommands("claude", null, roots);
    expect(list.find((c) => c.name === "security-review")).toEqual({ name: "security-review", description: "Our security checklist", source: "user" });
    expect(list.filter((c) => c.source === "builtin").map((c) => c.name)).toEqual(builtinCommands("claude").map((c) => c.name).filter((name) => name !== "security-review"));
  });
});

// Codex 0.160.0 dropped its custom prompts (see slash-commands.ts), and the
// other agents' menus were not read for custom commands.
test("other agents are offered their built-ins, never Claude Code's own commands", async () => {
  const { roots, home } = setup();
  const project = join(home, "p");
  file(join(roots.claudeDir, "commands", "claude-only.md"), "x");
  file(join(project, ".claude", "commands", "claude-project.md"), "x");
  for (const agent of ["codex", "cursor", "opencode", "agy"]) expect(await paneCommands(agent, project, roots)).toEqual(builtinCommands(agent));
});

test("an agent with no known commands gets none, built-in or custom", async () => {
  const { roots } = setup();
  file(join(roots.claudeDir, "commands", "hello.md"), "x");
  expect(await paneCommands("gemini", null, roots)).toEqual([]);
  expect(await paneCommands(null, null, roots)).toEqual([]);
});

describe("what a command file cannot do", () => {
  test("a body never leaves the computer: nothing past the frontmatter and first line is read or sent", async () => {
    const { roots } = setup();
    file(join(roots.claudeDir, "commands", "secret.md"), `---\ndescription: Harmless\n---\nToken: hunter2\n${"x".repeat(10_000)}\nTAIL-MARKER\n`);
    const sent = JSON.stringify(await paneCommands("claude", null, roots));
    expect(sent).not.toContain("hunter2");
    expect(sent).not.toContain("TAIL-MARKER");
  });

  test("hostile names are skipped, not cleaned into something else", async () => {
    const { roots } = setup();
    const dir = join(roots.claudeDir, "commands");
    for (const name of ["with space.md", "new\nline.md", "esc\u001b[31mred.md", "bidi\u202Eevil.md", "-dash-first.md", "..md"]) file(join(dir, name), "---\ndescription: x\n---\n");
    file(join(dir, ".hidden.md"), "---\ndescription: x\n---\n");
    file(join(dir, "notes.txt"), "not markdown");
    file(join(dir, "fine_name-2.md"), "---\ndescription: Fine\n---\n");
    file(join(dir, "日本語.md"), "---\ndescription: Any script's letters\n---\n");
    expect(custom(await paneCommands("claude", null, roots)).map((c) => c.name)).toEqual(["fine_name-2", "日本語"]);
  });

  test("descriptions lose terminal escapes, control and direction characters, and are cut between graphemes", async () => {
    expect(clean("\u001b[31mRed\u001b[0m and\tbell\u0007 \u202Egnirts\u202C")).toBe("Red and bell gnirts");
    expect(clean("\u001b]0;title\u0007Shown")).toBe("Shown");
    // A family emoji is eight UTF-16 units: kept whole where it fits, dropped whole where it does not.
    const family = "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}";
    expect(clean(`${"a".repeat(150)}${family} tail ${"b".repeat(20)}`)).toBe(`${"a".repeat(150)}${family}\u2026`);
    expect(clean(`${"a".repeat(155)}${family} tail`)).toBe(`${"a".repeat(155)}\u2026`);
  });

  test("a link out of the commands folder is not followed", async () => {
    const { roots, home } = setup();
    file(join(home, "elsewhere", "outside.md"), "---\ndescription: Outside\n---\n");
    file(join(home, "elsewhere", "dir", "inner.md"), "---\ndescription: Inner\n---\n");
    mkdirSync(join(roots.claudeDir, "commands"), { recursive: true });
    symlinkSync(join(home, "elsewhere", "outside.md"), join(roots.claudeDir, "commands", "linked.md"));
    symlinkSync(join(home, "elsewhere", "dir"), join(roots.claudeDir, "commands", "linkeddir"));
    // A folder linked back into the tree is walked once.
    symlinkSync(join(roots.claudeDir, "commands"), join(roots.claudeDir, "commands", "loop"));
    file(join(roots.claudeDir, "commands", "real.md"), "---\ndescription: Real\n---\n");
    expect(custom(await paneCommands("claude", null, roots)).map((c) => c.name)).toEqual(["real"]);
  });

  test("a commands folder that is itself a link is read where it points", async () => {
    const { roots, home } = setup();
    file(join(home, "dotfiles", "commands", "fromdots.md"), "---\ndescription: From dotfiles\n---\n");
    mkdirSync(roots.claudeDir, { recursive: true });
    symlinkSync(join(home, "dotfiles", "commands"), join(roots.claudeDir, "commands"));
    expect(custom(await paneCommands("claude", null, roots)).map((c) => c.name)).toEqual(["fromdots"]);
  });

  test("a named pipe called x.md is refused at once rather than waited on", async () => {
    const { roots } = setup();
    mkdirSync(join(roots.claudeDir, "commands"), { recursive: true });
    expect(Bun.spawnSync(["mkfifo", join(roots.claudeDir, "commands", "pipe.md")]).exitCode).toBe(0);
    file(join(roots.claudeDir, "commands", "after.md"), "---\ndescription: After the pipe\n---\n");
    const started = Date.now();
    expect(custom(await paneCommands("claude", null, roots)).map((c) => c.name)).toEqual(["after"]);
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 5_000);

  test("a folder of thousands of prompts yields a bounded list", async () => {
    const { roots } = setup();
    for (let i = 0; i < MAX_COMMANDS + 50; i++) file(join(roots.claudeDir, "commands", `c${String(i).padStart(4, "0")}.md`), "---\ndescription: d\n---\n");
    const list = await paneCommands("claude", null, roots);
    expect(custom(list)).toHaveLength(MAX_COMMANDS);
  });

  test("namespaces nest only so deep", async () => {
    const { roots } = setup();
    file(join(roots.claudeDir, "commands", "a", "b", "c", "three.md"), "x");
    file(join(roots.claudeDir, "commands", "a", "b", "c", "d", "four.md"), "x");
    expect(custom(await paneCommands("claude", null, roots)).map((c) => c.name)).toEqual(["a:b:c:three"]);
  });

  test("missing folders and a relative or missing working folder are no commands, not an error", async () => {
    const { roots } = setup();
    expect(custom(await paneCommands("claude", "relative/path", roots))).toEqual([]);
    expect(custom(await paneCommands("claude", join(scratch, "does-not-exist"), roots))).toEqual([]);
  });
});

describe("frontmatter", () => {
  test("reads plain, quoted, block and continued values, and ignores nested keys", () => {
    const { fields, firstLine } = frontmatter([
      "---",
      "description: 'It''s plain'",
      "argument-hint: [pr-number]",
      "allowed-tools:",
      "  - Bash(git add:*)",
      "name: |",
      "  multi",
      "  line",
      "---",
      "",
      "First body line",
    ].join("\n"));
    expect(fields.get("description")).toBe("It's plain");
    expect(fields.get("name")).toBe("multi line");
    expect(firstLine).toBe("First body line");
  });

  test("frontmatter never closed, or closed past the bytes read, describes nothing rather than showing its fence", async () => {
    expect(frontmatter("---\ndescription: never closed\n")).toEqual({ fields: new Map(), firstLine: "" });
    const { roots } = setup();
    file(join(roots.claudeDir, "commands", "long.md"), `---\nallowed-tools: ${"Bash(x:*), ".repeat(500)}\ndescription: Too far down\n---\nBody\n`);
    file(join(roots.claudeDir, "commands", "blank.md"), "---\ndescription:\n---\n\nThe body's first line\n");
    expect(custom(await paneCommands("claude", null, roots))).toEqual([
      { name: "blank", description: "The body's first line", source: "user" },
      { name: "long", description: "", source: "user" },
    ]);
  });

  test("Windows line endings and a byte-order mark are read like any other", () => {
    expect(frontmatter("\uFEFF---\r\ndescription: CRLF\r\n---\r\nBody\r\n").fields.get("description")).toBe("CRLF");
  });
});
