import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { cleanName, computerName, loadComputerName } from "./computer-name";

// Simulator run, October 2026: the phone named this Mac "FA-F5-F2-84-C0-7E",
// the network's hostname, instead of the Computer Name the person chose.
test("a Mac is named by its Computer Name, not the network's hostname", async () => {
  await loadComputerName(async () => "Yasser’s MacBook Pro\n", "darwin");
  expect(computerName()).toBe("Yasser’s MacBook Pro");
});

test("without a Computer Name, or off a Mac, the hostname stays", async () => {
  await loadComputerName(async () => null, "darwin");
  expect(computerName()).toBe(hostname());
  await loadComputerName(async () => { throw new Error("no scutil"); }, "darwin");
  expect(computerName()).toBe(hostname());
  await loadComputerName(async () => "ignored", "linux");
  expect(computerName()).toBe(hostname());
});

test("a name is shown without control characters and within bounds", () => {
  expect(cleanName("  Studio\u0007 Mac\n")).toBe("Studio Mac");
  expect(cleanName("\n\t")).toBeNull();
  expect([...cleanName("x".repeat(200))!].length).toBe(63);
});
