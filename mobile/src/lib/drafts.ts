/** ComputerSession owns its API identity, so equal pane IDs cannot share a draft. */
export interface NativeDraft { inFlight: boolean; listeners: Set<() => void>; text: string; pending: { key: string; id: string } | null }
const scopes = new WeakMap<object, Map<string, NativeDraft>>();
const LIMIT = 20;

export function nativeDraft(owner: object, pane: string): NativeDraft {
  let drafts = scopes.get(owner);
  if (!drafts) scopes.set(owner, drafts = new Map());
  let draft = drafts.get(pane);
  if (draft) {
    // A Map iterates in insertion order, so re-inserting on every read makes
    // the first entry the least recently used one.
    drafts.delete(pane);
  } else {
    draft = { text: "", pending: null, inFlight: false, listeners: new Set() };
    // A loop, so a scope that grew past the limit while sends were uncertain
    // shrinks back once they settle.
    while (drafts.size >= LIMIT && evictOne(drafts));
  }
  drafts.set(pane, draft);
  return draft;
}

/*
 * Which draft goes when a computer holds too many: the least recently used
 * empty one — a pane that was only looked at — and a typed one only when no
 * empty one is left. Never a draft whose send is running or whose uncertain
 * send kept its operation ID: retyping that message sends it under a new ID,
 * so a first send that did land is delivered twice. Nor one whose pane is on
 * screen, which holds the draft object and would keep typing into a copy no
 * one could find again.
 *
 * This used to evict the oldest-created entry whatever it held, and every
 * opened pane creates one, so checking twenty other agents discarded a typed
 * reply (September 2026 review). Only drafts that must be kept can take the
 * scope past the limit, and each of those is a send someone made or a pane
 * that is open.
 */
function evictOne(drafts: Map<string, NativeDraft>): boolean {
  let typed: string | undefined;
  for (const [pane, draft] of drafts) {
    if (draft.inFlight || draft.pending || draft.listeners.size > 0) continue;
    if (!draft.text) return drafts.delete(pane);
    typed ??= pane;
  }
  return typed !== undefined && drafts.delete(typed);
}

export function clearNativeDrafts(owner: object) { scopes.delete(owner); }

export function notifyNativeDraft(draft: NativeDraft) { draft.listeners.forEach(notify => notify()); }
