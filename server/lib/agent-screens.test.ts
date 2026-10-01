import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keysFor } from "./answer";
import type { HerdrClient } from "./herdr-client";
import { Poller } from "./poller";
import { PromptOpen, PromptUnrecognised, submitPrompt } from "./prompt";
import { parsePrompt } from "./prompt-parser";
import type { SessionStore } from "./state";
import { TranscriptStore } from "./transcript";

/**
 * Every screen an agent was seen to draw before or outside its conversation,
 * captured from Claude Code 2.1.286 and codex 0.157.1 under herdr 0.9.1, and
 * from older releases of both under herdr 0.9.3 in a disposable Linux machine,
 * in a scratch named session with scratch agent configuration (October 2026;
 * see fixtures/README.md). herdr's settled status is recorded beside each: it
 * called most of them idle, which is why the cards cannot wait for `blocked`.
 *
 * Each is held to what the phone must do with it: offer its choices as a card,
 * show the screen itself where there is nothing Shahi could choose, or, at a
 * ready composer, take the message.
 */
type Expect =
  | { card: { question: string; labels: string[]; answer: "digit" | "cursor"; confirm?: true } }
  | { waits: true }
  | { ready: true };

const SCREENS: Record<string, { herdr: string; agent: string; expect: Expect }> = {
  "claude-theme": { herdr: "idle", agent: "claude", expect: { card: { question: "Choose the text style that looks best with your terminal", answer: "cursor",
    labels: ["Auto (match terminal)", "Dark mode", "Light mode", "Dark mode (colorblind-friendly)", "Light mode (colorblind-friendly)", "Dark mode (ANSI colors only)", "Light mode (ANSI colors only)"] } } },
  "claude-login": { herdr: "idle", agent: "claude", expect: { card: { question: "Select login method:", answer: "digit",
    labels: ["Claude account with subscription · Pro, Max, Team, or Enterprise", "Anthropic Console account · API usage billing", "3rd-party platform · Amazon Bedrock, Microsoft Foundry, Google Vertex AI"] } } },
  "claude-api-key": { herdr: "blocked", agent: "claude", expect: { card: { question: "Do you want to use this API key?", answer: "cursor", labels: ["Yes", "No (recommended)"] } } },
  "claude-trust": { herdr: "blocked", agent: "claude", expect: { card: { question: "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.", answer: "cursor", labels: ["No, exit", "Yes, I trust this folder"] } } },
  "claude-bypass": { herdr: "blocked", agent: "claude", expect: { card: { question: "WARNING: Claude Code running in Bypass Permissions mode", answer: "cursor", labels: ["No, exit", "Yes, I accept"] } } },
  "claude-mcp-one": { herdr: "blocked", agent: "claude", expect: { card: { question: "New MCP server found in this project: scratch-one", answer: "cursor",
    labels: ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"] } } },
  "claude-mcp-two": { herdr: "idle", agent: "claude", expect: { waits: true } },
  "claude-imports": { herdr: "blocked", agent: "claude", expect: { card: { question: "Allow external CLAUDE.md file imports?", answer: "cursor", labels: ["No, disable external imports", "Yes, allow external imports"] } } },
  "claude-settings-error": { herdr: "blocked", agent: "claude", expect: { card: { question: "Settings Error", answer: "digit", labels: ["Fix with Claude", "Exit and fix manually", "Continue without these settings"] } } },
  "claude-ready": { herdr: "idle", agent: "claude", expect: { ready: true } },
  "codex-sign-in": { herdr: "idle", agent: "codex", expect: { card: { question: "Sign in with ChatGPT to use Codex as part of your paid plan or connect an API key for usage-based billing", answer: "digit", confirm: true,
    labels: ["Sign in with ChatGPT", "Sign in with Device Code", "Provide your own API key"] } } },
  "codex-trust": { herdr: "idle", agent: "codex", expect: { card: { question: "Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.", answer: "digit", confirm: true, labels: ["Trust and continue", "Quit"] } } },
  "codex-update": { herdr: "idle", agent: "codex", expect: { card: { question: "Update available · 0.157.1 → 0.159.3", answer: "digit", confirm: true,
    labels: ["Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)", "Skip", "Skip until next version"] } } },
  "codex-migration": { herdr: "idle", agent: "codex", expect: { card: { question: "GPT-5.4 is no longer available", answer: "digit", labels: ["Try new model", "Use existing model"] } } },
  "codex-hooks": { herdr: "idle", agent: "codex", expect: { card: { question: "Hooks need review", answer: "digit", confirm: true,
    labels: ["Review hooks", "Trust all and continue", "Continue without trusting (hooks won't run)"] } } },
  "codex-ready": { herdr: "idle", agent: "codex", expect: { ready: true } },
  // Older agents, installed with npm in a disposable OrbStack machine. Codex
  // 0.130 puts a hair space (U+200A) after its sparkle.
  "codex-0.130-update": { herdr: "blocked", agent: "codex", expect: { card: { question: "✨\u200aUpdate available! 0.130.0 -> 9.0.0", answer: "digit", confirm: true,
    labels: ["Update now (runs `bun install -g @openai/codex`)", "Skip", "Skip until next version"] } } },
  "codex-0.130-trust": { herdr: "unknown", agent: "codex", expect: { card: { question: "Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection. Trusting the directory allows project-local config, hooks, and exec policies to load.", answer: "digit", confirm: true,
    labels: ["Yes, continue", "No, quit"] } } },
};

const screen = (name: string) => readFileSync(join(import.meta.dir, "..", "fixtures", "startup", `${name}.ansi`), "utf8");

/** What the phone is shown for a screen, with herdr saying `status`. */
async function shown(name: string, agent: string, status: string) {
  const client = {
    rpc: async (method: string) => method === "pane.get" ? { pane: { agent, agent_status: status } } : { read: { text: screen(name) } },
  } as unknown as HerdrClient;
  const store = { pane: () => ({ agent, agent_status: status }), instance: () => undefined } as unknown as SessionStore;
  return new Poller(client, store, new TranscriptStore(":memory:")).refresh("w1:p1");
}

/** What a message sent now does: refused, or typed (and how). */
async function message(name: string, status: string): Promise<string> {
  const rpc = async (method: string) => (method === "pane.read" ? { read: { text: screen(name) } } : {});
  try {
    return await submitPrompt(rpc, { paneId: "w1:p1", isAgent: true, status, shellAlone: false }, "please fix the tests", async () => {});
  } catch (err) {
    if (err instanceof PromptOpen || err instanceof PromptUnrecognised) return err.code;
    throw err;
  }
}

describe("each captured screen", () => {
  for (const [name, { herdr, agent, expect: wanted }] of Object.entries(SCREENS)) {
    test(`${name}: ${"card" in wanted ? "its choices are a card" : "waits" in wanted ? "its screen is shown, with keys" : "a message is typed"}`, async () => {
      const parsed = parsePrompt(screen(name));
      const frame = await shown(name, agent, herdr);
      if ("card" in wanted) {
        expect(parsed?.question).toBe(wanted.card.question);
        expect(parsed?.options.map((o) => o.label)).toEqual(wanted.card.labels);
        expect(parsed?.answer).toBe(wanted.card.answer);
        expect(parsed?.confirm).toBe(wanted.card.confirm);
        expect(frame?.prompt?.question).toBe(wanted.card.question);
      } else {
        expect(parsed).toBeNull();
        expect(frame?.prompt).toBeNull();
        expect(frame?.unrecognised).toBe("waits" in wanted ? true : undefined);
      }
    });
  }
});

/**
 * The rule the whole feature rests on: a message the phone refuses is never
 * refused without something to answer with, and a ready agent is never
 * refused. herdr's status is not trusted for either: each screen is tried as
 * idle, unknown and blocked, since the captures saw all three over one screen.
 */
describe("a refused message always has something to answer with", () => {
  for (const [name, { agent, expect: wanted }] of Object.entries(SCREENS)) {
    for (const status of ["idle", "unknown", "blocked"]) {
      test(`${name}, herdr saying ${status}`, async () => {
        const outcome = await message(name, status);
        const frame = await shown(name, agent, status);
        if ("ready" in wanted && status !== "blocked") {
          expect(outcome).toBe("agent");
          return;
        }
        expect(["prompt_open", "prompt_unrecognised"]).toContain(outcome);
        expect(frame?.prompt !== null || frame?.unrecognised === true).toBe(true);
      });
    }
  }
});

describe("answering what was captured", () => {
  // Claude Code's trust, bypass and API-key menus start on the refusing row.
  test("the bypass warning is accepted by moving off its lit No, exit", () => {
    const prompt = parsePrompt(screen("claude-bypass"))!;
    expect(keysFor(prompt, prompt.options[1]!)).toEqual(["Down", "Enter"]);
  });

  test("codex's Trust all and continue is a digit and then Enter, which lights the row before confirming it", () => {
    const prompt = parsePrompt(screen("codex-hooks"))!;
    expect(keysFor(prompt, prompt.options[1]!)).toEqual(["2", "Enter"]);
    // After the digit, as captured: the row is lit and the question still open.
    const after = parsePrompt(screen("codex-hooks-after-2"))!;
    expect(after.question).toBe("Hooks need review");
    expect(after.options.find((option) => option.selected)?.label).toBe("Trust all and continue");
  });

  test("the theme picker is walked from its lit theme", () => {
    const prompt = parsePrompt(screen("claude-theme"))!;
    expect(keysFor(prompt, prompt.options[2]!)).toEqual(["Down", "Enter"]);
  });
});
