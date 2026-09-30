import type { ParsedPrompt, PromptOption } from "@shahi/shared";

const CURSOR_FEEDBACK = /^→ Tell the agent what to do instead \(Enter to send, empty to skip, Esc to cancel\)\s+ctrl\+c to stop$/;

/** Typing replaces Cursor's entire empty-field hint. Verify that exact change,
 * including the unchanged screen above it, before pressing Enter. Multiline or
 * wrapped inputs remain conservative: leave the text and ask for a fresh key. */
export function cursorFeedbackTyped(before: string, after: string, typed: string): boolean {
  const text = typed.trimEnd();
  if (!text || /[\r\n]/.test(text)) return false;
  const a = before.trimEnd().split("\n").map(line => line.trimEnd());
  const b = after.trimEnd().split("\n").map(line => line.trimEnd());
  if (!CURSOR_FEEDBACK.test(a.at(-1)?.trim() ?? "") || b.at(-1)?.trim() !== `→ ${text}`) return false;
  return a.slice(0, -1).join("\n").trimEnd() === b.slice(0, -1).join("\n").trimEnd();
}

/** Menus measured on current CLIs which herdr 0.9.1 does not always recognise. */
export function providerPrompt(lines: string[]): { agent: string; prompt: ParsedPrompt } | null {
  const plain = lines.map(line => line.trim());
  const options = (rows: string[], labels: string[], answer: "digit" | "cursor"): PromptOption[] | null => {
    const found = rows.map(row => row.match(answer === "digit" ? /^([›❯>»▶])?\s*(\d+)\.\s+(.+)$/u : /^([›❯>»▶])?\s*(.+)$/u));
    if (found.some((row, i) => !row || (answer === "digit" && Number(row[2]) !== i + 1))) return null;
    const result = found.map((row, i) => ({ index: i + 1, label: row![answer === "digit" ? 3 : 2]!, selected: !!row![1] }));
    return result.length === labels.length && result.every((row, i) => row.label === labels[i]) && result.filter(row => row.selected).length === 1 ? result : null;
  };

  // The new Codex folder picker is near the top, above an otherwise empty
  // terminal. The folder and footer distinguish it from quoted menu prose.
  // Embedded Codex 0.158 exits with Quit; daemon sessions return to the Agent
  // Command Center. Match each label to its measured footer, not either alone.
  const folder = plain.lastIndexOf("Folder access");
  const trust = plain.findIndex((line, i) => i > folder && line.startsWith("Trust this folder? Codex can read, edit, and run files here"));
  const codexRows = plain.filter(line => /^[›❯>»▶]?\s*[12]\.\s/.test(line));
  const codexExit = plain.at(-1) === "enter continue · esc back" ? "Back to Agent Command Center"
    : plain.at(-1) === "enter continue · esc quit" ? "Quit" : null;
  const codex = codexExit ? options(codexRows, ["Trust and continue", codexExit], "digit") : null;
  if (folder >= 0 && trust > folder && plain[folder + 1]?.startsWith("/") && codex) {
    const end = plain.findIndex((line, i) => i > trust && /^[›❯>»▶]?\s*1\./.test(line));
    return { agent: "codex", prompt: { question: plain.slice(trust, end).filter(Boolean).join(" "), answer: "digit", confirm: true, options: codex, context: [plain[folder + 1]!] } };
  }

  // Codex asks before starting whenever a newer release is out, and herdr
  // reports it idle meanwhile, so without this every message was refused
  // behind a menu the phone had no card for (measured on 0.157.1 → 0.158.0).
  // "Update now" names the installer command it runs, which changes with the
  // release, so only that label is matched by its start.
  const update = plain.findIndex(line => /^Update available · \S+ → \S+$/.test(line));
  if (update >= 0 && plain[update + 1]?.startsWith("Release notes: ") && plain.at(-1) === "enter continue · esc skip") {
    const rows = plain.slice(update + 2).flatMap(line => { const m = line.match(/^([›❯>»▶])?\s*(\d+)\.\s+(.+)$/u); return m ? [{ index: Number(m[2]), label: m[3]!, selected: !!m[1] }] : []; });
    const shaped = rows.length === 3 && rows.every((row, i) => row.index === i + 1) && rows.filter(row => row.selected).length === 1 &&
      /^Update now(?:$| \(runs )/.test(rows[0]!.label) && rows[1]!.label === "Skip" && rows[2]!.label === "Skip until next version";
    if (shaped) return { agent: "codex", prompt: { question: plain[update]!, answer: "digit", confirm: true, options: rows, context: [plain[update + 1]!] } };
  }

  const agyQuestion = plain.indexOf("Do you trust the contents of this project?");
  const agyRows = plain.filter(line => /^(?:[›❯>»▶]\s*)?(?:Yes, I trust this folder|No, exit)$/.test(line));
  const agy = options(agyRows, ["Yes, I trust this folder", "No, exit"], "cursor");
  if (agyQuestion >= 0 && plain.includes("Antigravity CLI requires permission to read, edit, and execute files here.") && plain.includes("↑/↓ Navigate · enter Confirm") && agy) {
    const path = plain.slice(0, agyQuestion).filter(line => line.startsWith("/")).at(-1);
    if (path) return { agent: "agy", prompt: { question: plain[agyQuestion]!, answer: "cursor", options: agy, context: [path, "Antigravity CLI requires permission to read, edit, and execute files here."] } };
  }

  // Cursor draws a boxed trust dialog with explicit a/q shortcuts, not a
  // numbered list. Require the dialog title, navigation hint and one cursor.
  const box = lines.map(line => line.replace(/^\s*│\s?/, "").replace(/\s*│\s*$/, "").trim());
  if (box.includes("⚠ Workspace Trust Required") && box.includes("Do you trust the contents of this directory?") && box.includes("Use arrow keys to navigate, Enter to select, or press the key shown")) {
    const rows = box.flatMap(line => { const m = line.match(/^(▶\s*)?\[([aq])\]\s+(Trust this workspace|Quit)$/u); return m ? [{ index: m[2] === "a" ? 1 : 2, key: m[2]!, label: m[3]!, selected: !!m[1] }] : []; });
    const path = box.find(line => line.startsWith("/"));
    if (path && box.includes("Cursor Agent can execute code and access files in this directory.") && rows.length === 2 && rows[0]?.key === "a" && rows[0]?.label === "Trust this workspace" && rows[1]?.key === "q" && rows[1]?.label === "Quit" && rows.filter(row => row.selected).length === 1) return { agent: "cursor", prompt: { question: "Do you trust the contents of this directory?", context: [path, "Cursor Agent can execute code and access files in this directory."], answer: "key", options: rows } };
  }

  const commandQuestion = plain.lastIndexOf("Run this command?");
  if (CURSOR_FEEDBACK.test(plain.filter(Boolean).at(-1) ?? "")) {
    return { agent: "cursor", prompt: { question: "Tell the agent what to do instead", answer: "cursor", options: [{ index: 1, label: "Tell the agent what to do instead", selected: true, textInput: true }] } };
  }
  if (commandQuestion >= 0) {
    const rows: PromptOption[] = [];
    for (const line of plain.slice(commandQuestion + 1)) {
      const m = line.match(/^(→\s*)?(Run \(once\) \(y\)|Add Shell\(.+\) to allowlist\? \(tab\)|Run Everything \(shift\+tab\)|Skip & tell the agent what to do instead \(esc or n\))$/u);
      if (m) rows.push({ index: rows.length + 1, label: m[2]!, selected: !!m[1], key: m[2]!.startsWith("Run (once)") ? "y" : m[2]!.startsWith("Add Shell") ? "Tab" : m[2]!.startsWith("Run Everything") ? "shift+tab" : "n" });
    }
    const rule = plain.findLastIndex((line, i) => i < commandQuestion && /^─{20,}$/.test(line));
    const command = plain.slice(rule + 1, commandQuestion).filter(Boolean);
    const batch = /^Approval \d+ of \d+$/.test(command[0] ?? "") ? command.shift() : undefined;
    if (rule >= 0 && command[0]?.startsWith("$") && rows.map(row => row.key).join(",") === "y,Tab,shift+tab,n" && rows.filter(row => row.selected).length === 1) return { agent: "cursor", prompt: { question: "Run this command?", context: [...(batch ? [batch] : []), command.join("\n"), ...plain.slice(commandQuestion + 1).filter(line => line.startsWith("Not in allowlist:"))], answer: "key", options: rows } };
  }
  return null;
}

/** A narrow adapter for measured provider menus, not a general status override. */
export function providerIsWaiting(kind: string | null | undefined, text: string, parsed: ParsedPrompt | null): boolean {
  if (!kind || !parsed) return false;
  const lines = text.trimEnd().split("\n");
  if (providerPrompt(lines)?.agent === kind) return true;
  if (kind === "agy" && parsed.question === "Run this command?" &&
    (parsed.options.length === 4 || parsed.options.length === 6) && parsed.options[0]?.label === "Yes, run command" && parsed.options[3]?.label === "No, cancel" &&
    /^\s*Requesting permission for:\s*$/m.test(text) && text.includes("↑/↓ Navigate · tab Amend · ctrl+g edit/expand command") && /^\s*esc to cancel\s+/m.test(text)) return true;
  return kind === "agy" && parsed.question === "Accept this file edit?" &&
    parsed.options.length === 2 && parsed.options[0]?.label === "Yes, accept this change" && parsed.options[1]?.label === "No, reject this change" &&
    /^\s*shift\+tab to auto-approve file edits\s*$/m.test(text) && /^\s*esc to cancel\s+/m.test(text);
}
