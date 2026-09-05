import { expect, test } from "bun:test";
import { Operations } from "./operations";

test("concurrent retries and later retries share one write", async () => {
  const ops = new Operations();
  let writes = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const write = async () => { writes++; await wait; return { accepted: true }; };
  const a = ops.run("pane:message", "same", write);
  const b = ops.run("pane:message", "same", write);
  release();
  expect(await a).toEqual(await b);
  expect(await ops.run("pane:message", "same", write)).toEqual({ accepted: true });
  expect(writes).toBe(1);
  await expect(ops.run("pane:message", "different", write)).rejects.toThrow("different input");
});

test("an uncertain failed write is not replayed", async () => {
  const ops = new Operations();
  let writes = 0;
  const write = async () => { writes++; throw new Error("response lost after submission"); };
  await expect(ops.run("key", {}, write)).rejects.toThrow("response lost");
  await expect(ops.run("key", {}, write)).rejects.toThrow("response lost");
  expect(writes).toBe(1);
});

test("pending writes cannot expire or be evicted to make room", async () => {
  let now = 0;
  const ops = new Operations(100, 1, () => now);
  let release!: (value: number) => void;
  const pending = ops.run("a", {}, () => new Promise<number>((r) => { release = r; }));
  await Promise.resolve();
  now = 200;
  await expect(ops.run("b", {}, async () => 2)).rejects.toThrow("Too many");
  expect(ops.run("a", {}, async () => 3)).toBe(pending);
  release(1);
  expect(await pending).toBe(1);
  now = 301;
  expect(await ops.run("b", {}, async () => 2)).toBe(2);
});
