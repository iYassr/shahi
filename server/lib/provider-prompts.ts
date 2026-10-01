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
  // Codex 0.130 draws the same offer as "✨ Update available! 0.130.0 ->
  // 9.0.0" over "Press enter to continue" (captured on an npm install,
  // October 2026); its card was titled by the release-notes link.
  const update = plain.findIndex(line => /^(?:✨\s*)?Update available(?: ·|!) \S+ (?:→|->) \S+$/u.test(line));
  // 0.130 leaves a blank line under the title.
  const notes = update >= 0 ? plain.findIndex((line, i) => i > update && line !== "") : -1;
  if (update >= 0 && plain[notes]?.startsWith("Release notes: ") && (plain.at(-1) === "enter continue · esc skip" || plain.at(-1) === "Press enter to continue")) {
    const rows = plain.slice(notes + 1).flatMap(line => { const m = line.match(/^([›❯>»▶])?\s*(\d+)\.\s+(.+)$/u); return m ? [{ index: Number(m[2]), label: m[3]!, selected: !!m[1] }] : []; });
    const shaped = rows.length === 3 && rows.every((row, i) => row.index === i + 1) && rows.filter(row => row.selected).length === 1 &&
      /^Update now(?:$| \(runs )/.test(rows[0]!.label) && rows[1]!.label === "Skip" && rows[2]!.label === "Skip until next version";
    if (shaped) return { agent: "codex", prompt: { question: plain[update]!, answer: "digit", confirm: true, options: rows, context: [plain[notes]!] } };
  }

  // Codex asks whenever a hook in its configuration is new or changed, before
  // the composer: among them the SessionStart hook `herdr integration install
  // codex` writes, which Shahi installs. herdr reports it idle (captured on
  // 0.157.1, October 2026). "2" only lights "Trust all and continue" and Enter
  // confirms it; "1" and "3" act on the digit (codex source, 0.158), so the
  // answer presses Enter only when the row is still lit.
  const hooks = plain.indexOf("Hooks need review");
  // 0.150's footer is "Press enter to confirm or esc to go back" (captured on
  // an npm install, October 2026).
  if (hooks >= 0 && /^\d+ hooks? (?:is|are) new or changed\.$/.test(plain[hooks + 1] ?? "") &&
    (plain.at(-1) === "enter confirm · esc skip" || plain.at(-1) === "Press enter to confirm or esc to go back")) {
    const rows = options(plain.filter(line => /^[›❯>»▶]?\s*\d\.\s/.test(line)), ["Review hooks", "Trust all and continue", "Continue without trusting (hooks won't run)"], "digit");
    const top = plain.findIndex(line => /^[›❯>»▶]?\s*1\.\s/.test(line));
    if (rows) return { agent: "codex", prompt: { question: plain[hooks]!, context: plain.slice(hooks + 1, top).filter(Boolean), answer: "digit", confirm: true, options: rows } };
  }

  // Codex's model migration, at the top of an otherwise empty terminal before
  // the composer, and idle to herdr (captured on 0.157.1). Its title is its
  // first line, "GPT-5.4 is no longer available"; the question the generic
  // parser found was the sentence under it. The digits act at once, and Esc
  // accepts the new model (codex source, 0.158), so the Enter that follows a
  // digit is never pressed there.
  // Codex 0.150 draws it over "Use ↑/↓ to move, press enter to confirm"
  // (captured on an npm install, October 2026), where a digit may only move
  // the cursor; Enter follows only if the row is still lit (`answer.ts`).
  if (plain.at(-1) === "enter/esc confirm · ctrl+c quit" || plain.at(-1) === "Use ↑/↓ to move, press enter to confirm") {
    const rows = options(plain.filter(line => /^[›❯>»▶]?\s*\d\.\s/.test(line)), ["Try new model", "Use existing model"], "digit");
    const first = plain.findIndex(Boolean);
    const top = plain.findIndex(line => /^[›❯>»▶]?\s*1\.\s/.test(line));
    if (rows && first < top) return { agent: "codex", prompt: { question: plain[first]!, context: plain.slice(first + 1, top).filter(Boolean), answer: "digit", confirm: true, options: rows } };
  }

  // Claude Code's first-run theme picker: unnumbered rows with no confirm
  // hint beneath, the current theme ticked, and idle to herdr (captured on
  // 2.1.286). With no card, a message was typed into it, where its letters
  // move the cursor and Enter picks the lit theme.
  const theme = plain.indexOf("Choose the text style that looks best with your terminal");
  if (theme >= 0 && plain[theme + 1] === "To change this later, run /theme") {
    const rows: PromptOption[] = [];
    for (const line of plain.slice(theme + 2)) {
      if (!line && rows.length === 0) continue;
      if (!line || /^╌+$/.test(line)) break;
      const m = line.match(/^(❯\s+)?(?:✔\s+)?(\S.*)$/u);
      if (!m) break;
      rows.push({ index: rows.length + 1, label: m[2]!, selected: !!m[1] });
    }
    if (rows.length >= 2 && rows[0]!.label === "Auto (match terminal)" && rows.filter(row => row.selected).length === 1) {
      return { agent: "claude", prompt: { question: plain[theme]!, context: [plain[theme + 1]!], answer: "cursor", options: rows } };
    }
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

/**
 * Screens an agent waits on with no choice Shahi could make for the person,
 * measured where herdr reports the pane idle rather than blocked. A message
 * is refused there as it is behind an unrecognised wait, and the phone shows
 * the screen and its keys (`PaneFrame.unrecognised`).
 *
 * - Claude Code's multi-server project MCP approval: every server ticked and
 *   an "Enable selected" button, which Enter can press (2.1.286), or in
 *   2.1.200 just the ticked boxes, confirmed by Enter.
 * - "Press Enter to continue…": Claude Code's security notes and sign-in,
 *   codex's sign-in success. A message's Enter would dismiss them unread.
 * - Codex's model notice with nothing left to choose, which Enter or Esc
 *   accepts (codex source, 0.158).
 */
export function providerWaitingScreen(text: string): boolean {
  const last = text.trimEnd().split("\n").map(line => line.trim()).filter(Boolean).at(-1) ?? "";
  return /^Space to select · (?:Enter to confirm · )?Esc to reject all$/.test(last) ||
    /^Press Enter to (?:continue|start your trial)(?:…|\.\.\.)?$/i.test(last) ||
    last === "enter/esc continue · ctrl+c quit";
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
