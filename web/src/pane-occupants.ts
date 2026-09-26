/**
 * Forgetting what the page kept for a conversation that has ended.
 *
 * Drafts, uncertain sends and remembered conversations live in memory, keyed
 * by pane id, and herdr reuses pane ids (see `@shahi/shared`'s
 * `pane-instance.ts`). Every session the page receives passes through here
 * before it is rendered, so a pane that closed or changed hands never shows
 * its previous occupant's draft or conversation, not even for one frame.
 */
import { endedPanes, type Session } from "@shahi/shared";
import { browserConnection } from "./connection";
import { draftOwner, forgetWebDraft } from "./drafts";
import { forgetReaderMemory } from "./components/Reader";

export function forgetEndedConversations(before: Session | null, after: Session): void {
  const owner = draftOwner(browserConnection().identity);
  for (const paneId of endedPanes(before, after)) {
    forgetWebDraft(owner, paneId);
    forgetReaderMemory(paneId);
  }
}
