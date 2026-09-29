/** Public recovery information, independent of the computer and its API. */
export const CLIENT_UPDATE_URL = "https://getshahi.dev/api/client-update";
export const IOS_APP_URL = "https://apps.apple.com/app/id6813370698";
/** Increase before publishing a browser release that can be required remotely. */
export const WEB_CLIENT_BUILD = 1;
export const UPDATE_CHECK_MS = 60_000;
const MAX_POLICY_MS = 14 * 24 * 60 * 60 * 1000;

export type UpdatePlatform = "ios" | "web";
export interface UpdateRule { minimumBuild: number; expiresAt: string; message: string }
export interface ClientUpdatePolicy { schema: 1; ios: UpdateRule | null; web: UpdateRule | null }

export function parseUpdatePolicy(value: unknown, now = Date.now()): ClientUpdatePolicy | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (p.schema !== 1) return null;
  for (const platform of ["ios", "web"]) {
    if (p[platform] === null) continue;
    const r = p[platform] as Partial<UpdateRule> | undefined;
    if (!r || typeof r !== "object" || Array.isArray(r) || !Number.isSafeInteger(r.minimumBuild) || r.minimumBuild! < 1
      || typeof r.message !== "string" || !r.message.trim() || r.message.length > 400
      || typeof r.expiresAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(r.expiresAt)
      || !Number.isFinite(Date.parse(r.expiresAt)) || Date.parse(r.expiresAt) > now + MAX_POLICY_MS) return null;
  }
  return p as unknown as ClientUpdatePolicy;
}

export function requiredUpdate(policy: ClientUpdatePolicy | null, platform: UpdatePlatform, build: number, now = Date.now()): UpdateRule | null {
  const rule = policy?.[platform];
  // Development/unknown builds cannot safely be compared with store builds.
  return rule && Number.isSafeInteger(build) && build > 0 && build < rule.minimumBuild && Date.parse(rule.expiresAt) > now ? rule : null;
}

/** Keeps a valid requirement through a network failure, but never past expiry.
 * Null rules revoke it immediately. No credentials, identifiers or backend data
 * go to the website. Invalid responses cannot invent a lockout or erase one.
 */
export class ClientUpdateCheck {
  private policy: ClientUpdatePolicy | null = null;
  private pending: Promise<boolean> | null = null;
  private checkedAt = -Infinity;
  private received = false;
  constructor(private options: {
    platform: UpdatePlatform; build: number;
    load: () => Promise<string | null>; save: (text: string) => Promise<void>;
    changed: (rule: UpdateRule | null) => void;
    fetch?: typeof fetch; now?: () => number;
  }) {}
  private now() { return (this.options.now ?? Date.now)(); }
  private emit() { this.options.changed(requiredUpdate(this.policy, this.options.platform, this.options.build, this.now())); }
  async restore() {
    try {
      const cached = await this.options.load();
      // A foreground event can finish a fresh request before slow storage.
      if (!this.received) this.policy = parseUpdatePolicy(JSON.parse(cached ?? "null"), this.now());
    } catch { /* A cache is optional. */ }
    this.emit();
  }
  check(force = false): Promise<boolean> {
    this.emit(); // Expiry releases the gate even when the next request fails.
    if (this.pending) return this.pending;
    if (!force && this.now() - this.checkedAt < UPDATE_CHECK_MS) return Promise.resolve(false);
    this.checkedAt = this.now();
    this.pending = this.fetchPolicy().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async fetchPolicy(): Promise<boolean> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 7000);
    try {
      const response = await (this.options.fetch ?? fetch)(CLIENT_UPDATE_URL, {
        credentials: "omit", cache: "no-store", redirect: "error", signal: abort.signal,
      });
      if (!response.ok) return false;
      const text = await response.text();
      if (text.length > 16_384) return false;
      const policy = parseUpdatePolicy(JSON.parse(text), this.now());
      if (!policy) return false;
      this.received = true;
      this.policy = policy;
      this.emit();
      try { await this.options.save(JSON.stringify(policy)); } catch { /* Storage must not prevent recovery. */ }
      return true;
    } catch { return false; }
    finally { clearTimeout(timer); this.emit(); }
  }
}
