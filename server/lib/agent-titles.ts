/**
 * An agent's terminal title without the status an agent writes into it.
 *
 * Codex 0.163 titles a thread "<thread name> | <folder>", and while it waits
 * on the person it blinks "[ ! ] Action Required | " and "[ . ] Action
 * Required | " in front, once a second, with "● " ahead of that while its
 * microphone listens; a braille spinner frame leads while it works (codex-rs
 * tui status_surfaces.rs and action_required_title.rs at rust-v0.163.0).
 * herdr strips Claude Code's "✳ " but passes these through (herdr 0.9.5), so
 * every approval changed the row's name, flipped it every second, and hid a
 * hand-started Codex's conversation, which Reader finds by that name, for as
 * long as the question was open (simulator run, 20 October 2026). The status
 * itself is herdr's to report and the card's to show.
 */
export function withoutAgentStatus(title: string, agent: string | null | undefined): string {
  if (agent !== "codex") return title;
  return title
    .replace(/^●\s+/, "")
    .replace(/^\[ [!.] \] Action Required(?:\s\|\s|$)/, "")
    .replace(/^[⠁-⣿]\s+/, "")
    .trim();
}
