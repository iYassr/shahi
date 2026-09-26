/**
 * What a conversation is called everywhere a client shows one: its terminal
 * title, or its pane id when there is none worth reading.
 *
 * A title can be only spaces. herdr omits a stripped title that strips to
 * nothing, and an older sidecar then passed the raw one on, so a row had no
 * name and was read aloud as "   , Claude, idle" (pre-release bug hunt). And
 * one helper for both clients and every screen, because the waiting card had
 * its own fallback, "untitled", for a pane its row called by its id.
 */
export function paneTitle(pane: { title: string | null; paneId: string }): string {
  return pane.title?.trim() || pane.paneId;
}
