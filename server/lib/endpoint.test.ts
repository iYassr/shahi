import { describe, expect, test } from "bun:test";
import { isLoopback } from "./endpoint";

describe("isLoopback", () => {
  test("knows the three spellings", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("localhost")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
  });
});
