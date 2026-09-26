/** Private drafts exist only in this page's memory, scoped to a pairing grant. */
export interface WebDraft {
  text: string;
  inFlight: boolean;
  listeners: Set<() => void>;
  attachments: { name: string; path: string; size?: number }[];
  /** An uncertain send: its operation id, and the occupant it was meant for (see `DashboardPane.instanceId`). */
  pending: { body: string; id: string; instanceId?: string } | null;
}
const scopes = new Map<string, Map<string, WebDraft>>();
export function draftOwner(identity?: { serverId: string; deviceId: string } | null): string {
  return identity ? `${identity.serverId}:${identity.deviceId}` : "direct";
}
/*
 * Which draft goes when a computer holds too many: the least recently used
 * empty one — a pane that was only looked at — and a typed one only when no
 * empty one is left. Never a draft whose send is running or whose uncertain
 * send kept its operation ID (retyping it sends a second command), nor one
 * whose pane is on screen. The native app's store follows the same rule.
 *
 * This used to evict the oldest-created entry whatever it held, and every
 * opened pane creates one, so checking twenty other agents discarded a typed
 * reply (September 2026 review).
 */
function evictOne(drafts: Map<string, WebDraft>): boolean {
  let typed: string | undefined;
  for (const [pane, draft] of drafts) {
    if (draft.inFlight || draft.pending || draft.listeners.size > 0) continue;
    if (!draft.text && draft.attachments.length === 0) return drafts.delete(pane);
    typed ??= pane;
  }
  return typed !== undefined && drafts.delete(typed);
}
export function webDraft(owner: string, pane: string): WebDraft {
  let drafts = scopes.get(owner);
  if (!drafts) {
    if (scopes.size >= 8) scopes.delete(scopes.keys().next().value!);
    scopes.set(owner, drafts = new Map());
  }
  let draft = drafts.get(pane);
  if (draft) {
    // Re-inserted on every read, so insertion order is recency order.
    drafts.delete(pane);
  } else {
    draft = { text: "", attachments: [], pending: null, inFlight: false, listeners: new Set() };
    // A loop, so a scope that grew past the limit while sends were uncertain
    // shrinks back once they settle.
    while (drafts.size >= 20 && evictOne(drafts));
  }
  drafts.set(pane, draft);
  return draft;
}
export function clearWebDrafts(owner: string) { scopes.delete(owner); }

/**
 * Empties the draft of a pane whose conversation has ended (`endedPanes`): it
 * closed, or another program took its id. Kept by pane id, a draft outlived
 * the pane it was typed for: the pre-release bug hunt found an unsent draft in
 * an unrelated conversation's composer, and its uncertain send, retried there,
 * typed into a new shell. Emptied in place rather than removed, because a
 * composer on screen holds this object and keeps typing into it.
 */
export function forgetWebDraft(owner: string, pane: string) {
  const draft = scopes.get(owner)?.get(pane);
  if (!draft || (!draft.text && !draft.attachments.length && !draft.pending)) return;
  draft.text = "";
  draft.attachments = [];
  draft.pending = null;
  notifyWebDraft(draft);
}

/**
 * Whether any conversation, open or not, holds work a page reload would lose.
 *
 * The composer's own `data-update-blocked` marker only exists while its pane is
 * on screen, but drafts outlive navigation on purpose. A pre-release review
 * found the update check reloading away a draft — and an uncertain send's
 * operation ID, whose loss turns a retry into a second command — as soon as
 * the person had moved to another pane or the list.
 */
export function hasUnsentDrafts(): boolean {
  for (const drafts of scopes.values()) {
    for (const draft of drafts.values()) {
      if (draft.text || draft.attachments.length || draft.pending || draft.inFlight) return true;
    }
  }
  return false;
}

export function notifyWebDraft(draft: WebDraft) { draft.listeners.forEach(notify => notify()); }
