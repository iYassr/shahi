/** ComputerSession owns its API identity, so equal pane IDs cannot share a draft. */
export interface NativeDraft { inFlight: boolean; listeners: Set<() => void>; text: string; pending: { key: string; id: string } | null }
const scopes = new WeakMap<object, Map<string, NativeDraft>>();
export function nativeDraft(owner: object, pane: string): NativeDraft {
  let drafts = scopes.get(owner);
  if (!drafts) scopes.set(owner, drafts = new Map());
  let draft = drafts.get(pane);
  if (!draft) {
    if (drafts.size >= 20) drafts.delete(drafts.keys().next().value!);
    drafts.set(pane, draft = { text: "", pending: null, inFlight: false, listeners: new Set() });
  }
  return draft;
}
export function clearNativeDrafts(owner: object) { scopes.delete(owner); }

export function notifyNativeDraft(draft: NativeDraft) { draft.listeners.forEach(notify => notify()); }
