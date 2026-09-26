import { describe, expect, test } from "bun:test";
import { PaneWrites } from "./pane-writes";

/** A write that records when it starts and ends, and finishes when told. */
function recorder() {
  const log: string[] = [];
  const write = (name: string, ms = 5) => async () => {
    log.push(`${name} start`);
    await Bun.sleep(ms);
    log.push(`${name} end`);
    return name;
  };
  return { log, write };
}

describe("PaneWrites", () => {
  // Pre-release bug hunt, B6: two phones' messages to one pane were typed
  // into each other before either Enter, and submitted as one.
  test("runs one pane's writes one after another, in arrival order", async () => {
    const writes = new PaneWrites();
    const { log, write } = recorder();
    const results = await Promise.all([
      writes.run("w1:p1", write("a", 15)),
      writes.run("w1:p1", write("b", 1)),
      writes.run("w1:p1", write("c", 1)),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(log).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  test("does not hold one pane's writes behind another's", async () => {
    const writes = new PaneWrites();
    const { log, write } = recorder();
    await Promise.all([writes.run("w1:p1", write("slow", 20)), writes.run("w1:p2", write("fast", 1))]);
    expect(log.indexOf("fast end")).toBeLessThan(log.indexOf("slow end"));
  });

  test("a write that fails reports its failure and does not stop the next", async () => {
    const writes = new PaneWrites();
    const failed = writes.run("w1:p1", async () => { throw new Error("herdr said no"); });
    const next = writes.run("w1:p1", async () => "sent");
    await expect(failed).rejects.toThrow("herdr said no");
    expect(await next).toBe("sent");
  });
});
