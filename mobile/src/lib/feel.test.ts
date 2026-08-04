import * as Haptics from "expo-haptics";
import { committed, landed, refused } from "./feel";

describe("haptics", () => {
  beforeEach(() => jest.clearAllMocks());

  test("a committed keystroke is a light tap", () => {
    committed();
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  });

  // Success and failure must not feel the same; that is the entire point of
  // firing one at all.
  test("landing and refusing use different notifications", () => {
    landed();
    refused();
    const calls = (Haptics.notificationAsync as jest.Mock).mock.calls.map((c) => c[0]);
    expect(new Set(calls).size).toBe(2);
  });
});
