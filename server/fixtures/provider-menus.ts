// Synthetic reproductions of the installed CLIs' September 27 menus.
export const CODEX_TRUST = `  Folder access
  /home/test/project

  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings
  can run code automatically, even without a model request. Continue only if you trust these files. Your trust
  decision will be saved.

› 1. Trust and continue
  2. Back to Agent Command Center

  enter continue · esc back` + "\n ".repeat(30);
// Codex 0.158.0's embedded server, measured on clean Ubuntu ARM64 without
// integrations. The daemon variant above returns to its command center.
export const CODEX_TRUST_EMBEDDED = CODEX_TRUST
  .replace("2. Back to Agent Command Center", "2. Quit")
  .replace("enter continue · esc back", "enter continue · esc quit");
// Codex 0.157.1 on its own server, as Shahi starts it (captured 2026-09-29).
export const CODEX_TRUST_OWN_SERVER = `
  Folder access
  /home/test/project

  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings
  can run code automatically, even without a model request. Continue only if you trust these files. Your trust
  decision will be saved.

› 1. Trust and continue
  2. Quit

  enter continue · esc quit`;

// Codex 0.157.1 while 0.158.0 is out, before any other screen (captured 2026-09-29).
export const CODEX_UPDATE = `
  Update available · 0.157.1 → 0.158.0
  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'\`)
  2. Skip
  3. Skip until next version

  enter continue · esc skip`;

export const CURSOR_TRUST = `│ ⚠ Workspace Trust Required │
│ Cursor Agent can execute code and access files in this directory. │
│ Do you trust the contents of this directory? │
│ /home/test/project │
│ ▶ [a] Trust this workspace │
│   [q] Quit │
│ Use arrow keys to navigate, Enter to select, or press the key shown │`;
export const AGY_TRUST = `/home/test/project
Do you trust the contents of this project?
Antigravity CLI requires permission to read, edit, and execute files here.
> Yes, I trust this folder
  No, exit
↑/↓ Navigate · enter Confirm
Gemini 3.8 Flash · high`;
export const CURSOR_COMMAND = `────────────────────────────────────────
Approval 1 of 3

 $ python3 -c "print('probe')" in .

 Run this command?
 Not in allowlist: python3
  → Run (once) (y)
    Add Shell(python3) to allowlist? (tab)
    Run Everything (shift+tab)
    Skip & tell the agent what to do instead (esc or n)

 ←/→ to switch approval
 ctrl+r to review changed files`;
export const AGY_EDIT = `────────────────────────────────────────
result.txt
- before
+ EDIT_OK

shift+tab to auto-approve file edits
Accept this file edit?
> 1. Yes, accept this change
  2. No, reject this change
esc to cancel                 Gemini 3.8 Flash · high`;


export const AGY_COMMAND = `Requesting permission for:
   node probe.mjs

Run this command?
> 1. Yes, run command
  2. Yes, and always allow in this conversation for commands that start with 'node probe.mjs'
  3. Yes, and always allow for commands that start with 'node probe.mjs' (Persist to settings.json)
  4. No, cancel

  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command
esc to cancel                 Gemini 3.8 Flash · high`;

export function openCodeMenu(selected = 0, background = "48;2;245;167;66"): string {
  const labels = ["Allow once", "Allow always", "Reject"];
  return `  ┃  △ Permission required
  ┃    → Edit denied.txt
  ┃
  ┃  1 + DENIED_WRITE
  ┃
  ┃   ${labels.map((label, i) => `\x1b[0m\x1b[${i === selected ? background : "48;2;30;30;30"}m${label}`).join("   ")}\x1b[0m     ctrl+f fullscreen  ⇆ select  enter confirm
  ┃`;
}

export const CURSOR_FEEDBACK = `→ Tell the agent what to do instead (Enter to send, empty to skip, Esc to cancel)        ctrl+c to stop
`;
