/** Private drafts exist only in this page's memory, scoped to a pairing grant. */
export interface WebDraft {
  text: string;
  inFlight: boolean;
  listeners: Set<() => void>;
  attachments: { name: string; path: string; size?: number }[];
  pending: { body: string; id: string } | null;
}
const scopes = new Map<string, Map<string, WebDraft>>();
export function draftOwner(identity?: { serverId: string; deviceId: string } | null): string {
  return identity ? `${identity.serverId}:${identity.deviceId}` : "direct";
}
export function webDraft(owner: string, pane: string): WebDraft {
  let drafts = scopes.get(owner);
  if (!drafts) {
    if (scopes.size >= 8) scopes.delete(scopes.keys().next().value!);
    scopes.set(owner, drafts = new Map());
  }
  let draft = drafts.get(pane);
  if (!draft) {
    if (drafts.size >= 20) drafts.delete(drafts.keys().next().value!);
    drafts.set(pane, draft = { text: "", attachments: [], pending: null, inFlight: false, listeners: new Set() });
  }
  return draft;
}
export function clearWebDrafts(owner: string) { scopes.delete(owner); }

export function notifyWebDraft(draft: WebDraft) { draft.listeners.forEach(notify => notify()); }
