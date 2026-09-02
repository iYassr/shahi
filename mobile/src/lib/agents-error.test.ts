import { IncompatibleServerError, UnreachableError } from "@/lib/errors";
import { shouldTakeOverSession } from "./agents-error";

describe("Agents error takeover", () => {
  const staleSession = { panes: [] };

  test("an incompatible server replaces a stale session with upgrade instructions", () => {
    const error = new IncompatibleServerError("Update the app.", { min: 3, max: 3 });
    expect(shouldTakeOverSession(error, staleSession)).toBe(true);
  });

  test("a transient failure keeps a useful stale session visible", () => {
    const error = new UnreachableError("offline", "localhost", "offline");
    expect(shouldTakeOverSession(error, staleSession)).toBe(false);
  });

  test("any initial failure takes over when no session has loaded", () => {
    expect(shouldTakeOverSession(new Error("broken"), null)).toBe(true);
  });
});
