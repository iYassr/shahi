import { IncompatibleServerError } from "@/lib/errors";

/** Whether an Agents error makes the last session snapshot unsafe to keep. */
export function shouldTakeOverSession(error: Error, session: unknown): boolean {
  return error instanceof IncompatibleServerError || !session;
}
