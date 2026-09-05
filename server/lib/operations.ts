export class OperationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Retain both successes and uncertain failures so a retry never repeats a write. */
export class Operations {
  private readonly entries = new Map<string, { input: string; promise: Promise<unknown>; settled: boolean; at: number }>();

  constructor(private readonly ttlMs = 10 * 60_000, private readonly limit = 500, private readonly now = Date.now) {}

  run<T>(key: string, input: unknown, action: () => Promise<T>): Promise<T> {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.settled && now - entry.at > this.ttlMs) this.entries.delete(id);
    }
    const signature = JSON.stringify(input);
    const seen = this.entries.get(key);
    if (seen) {
      if (seen.input !== signature) return Promise.reject(new OperationError("This request id was already used for different input.", 409));
      return seen.promise as Promise<T>;
    }
    if (this.entries.size >= this.limit) {
      return Promise.reject(new OperationError("Too many recent operations. Wait before submitting another.", 429));
    }
    // Publish the promise before action starts: even concurrent requests see it.
    const entry = { input: signature, promise: Promise.resolve().then(action), settled: false, at: now };
    this.entries.set(key, entry);
    const finish = () => { entry.settled = true; entry.at = this.now(); };
    void entry.promise.then(finish, finish);
    return entry.promise;
  }
}
