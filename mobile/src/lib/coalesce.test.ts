import { coalesce } from "./coalesce";

/**
 * One load in flight, one more at most. This is what stops a repainting
 * terminal from fanning out into a request per frame.
 */
describe("coalesce", () => {
  const deferred = () => {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  test("calls made while a run is in flight collapse into exactly one rerun", async () => {
    const gates = [deferred(), deferred(), deferred()];
    let runs = 0;
    const fn = jest.fn(() => gates[runs++]!.promise);
    const load = coalesce(fn);

    const first = load();
    const second = load();
    const third = load();
    const fourth = load();
    expect(fn).toHaveBeenCalledTimes(1);

    gates[0]!.resolve();
    await first;
    // The three that arrived during the first run became one rerun.
    expect(fn).toHaveBeenCalledTimes(2);

    gates[1]!.resolve();
    await Promise.all([second, third, fourth]);
    expect(fn).toHaveBeenCalledTimes(2);

    // Idle again: the next call starts a fresh run immediately.
    const fifth = load();
    expect(fn).toHaveBeenCalledTimes(3);
    gates[2]!.resolve();
    await fifth;
  });

  test("a rejecting run does not wedge the next one", async () => {
    let attempt = 0;
    const load = coalesce(async () => {
      attempt++;
      if (attempt === 1) throw new Error("boom");
    });
    await expect(load()).resolves.toBeUndefined();
    await load();
    expect(attempt).toBe(2);
  });

  test("a request during the rerun gets one further run, not zero and not two", async () => {
    const gates = [deferred(), deferred(), deferred()];
    let runs = 0;
    const fn = jest.fn(() => gates[runs++]!.promise);
    const load = coalesce(fn);

    void load();
    const queuedDuringFirst = load();
    gates[0]!.resolve();
    // Let the rerun start.
    await new Promise((r) => setTimeout(r, 0));
    expect(fn).toHaveBeenCalledTimes(2);

    const queuedDuringSecond = load();
    gates[1]!.resolve();
    await queuedDuringFirst;
    await new Promise((r) => setTimeout(r, 0));
    expect(fn).toHaveBeenCalledTimes(3);

    gates[2]!.resolve();
    await queuedDuringSecond;
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
