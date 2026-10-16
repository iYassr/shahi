// The phone cut's voice-over: the script and where each line starts. Spoken
// and cached exactly as the launch cut's (voiceover.ts), into a folder of its
// own, because speakLines deletes every take its lines do not use.

import { join } from "node:path";
import { T } from "../src/phone/timeline";
import { speakLines, type Line } from "./voiceover";

export const PHONE_VO_DIR = join(import.meta.dirname, "vo-phone");

/**
 * Three seeds a line rather than eight: the script is about 760 characters
 * with its tails, and three tries of every line stays inside a small monthly
 * allowance. Raise it once the plan allows.
 */
export const PHONE_ATTEMPTS = 3;

export const PHONE_LINES: Line[] = [
  { id: "problem", at: T.problem + 6, by: T.reader, text: "Checking on your agents from your phone? Pinch, scroll, squint.", say: "[sighs] Checking on your agents from your phone? Pinch, scroll, squint." },
  { id: "reader", at: T.reader + 4, by: T.answer, text: "With Shahi, it's a conversation you can read.", say: "[happy] With Shahi, it's a conversation you can read." },
  { id: "answer", at: T.answer + 4, by: T.agents, text: "When an agent asks, tap to answer. Shahi checks the live screen first." },
  { id: "agents", at: T.agents + 4, by: T.herdr, text: "Claude Code, Codex, Cursor, OpenCode and Antigravity." },
  // "herder", so herdr is said the way its author says it.
  { id: "herdr", at: T.herdr + 4, by: T.setup, text: "It's the same herdr workspace as your laptop. Every space, live.", say: "It's the same herder workspace as your laptop. Every space, live." },
  {
    id: "setup",
    at: T.setup + 6,
    by: T.reach,
    text: "One command, one scan. End-to-end encrypted, no VPN, no account. Or use SSH.",
    say: "[excited] One command, one scan. End-to-end encrypted, no VPN, no account. Or use SSH.",
  },
  { id: "reach", at: T.reach + 4, by: T.more, text: "Get notified when an agent needs you, and say your reply instead of typing it." },
  { id: "more", at: T.more + 4, by: T.end, text: "Review diffs, run slash commands, check your plan limits." },
  { id: "end", at: T.end + 12, by: T.total - 12, text: "Shahi. Your agents, on your phone.", say: "[warmly] Shahi. Your agents, on your phone." },
];

export const speakPhone = () => speakLines(PHONE_LINES, PHONE_VO_DIR, PHONE_ATTEMPTS);
