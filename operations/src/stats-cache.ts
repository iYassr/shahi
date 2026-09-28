export function validRange(range: string): boolean { return ["1h", "24h", "7d"].includes(range); }

/** One bounded cache per monitor. Failed refreshes never serve old data as current. */
export class StatsCache {
  private cached = new Map<string, { data: unknown; until: number }>();
  private pending = new Map<string, Promise<unknown>>();
  constructor(private read: (range: string) => Promise<unknown>, private now = Date.now) {}
  async get(range: string): Promise<unknown> {
    if (!validRange(range)) throw new Error("invalid window");
    const hit = this.cached.get(range);
    if (hit && hit.until > this.now()) return hit.data;
    const running = this.pending.get(range);
    if (running) return running;
    const task = this.read(range).then((data) => {
      this.cached.set(range, { data, until: this.now() + 60_000 });
      return data;
    }).finally(() => this.pending.delete(range));
    this.pending.set(range, task);
    return task;
  }
}
