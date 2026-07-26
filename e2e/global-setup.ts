import { rmSync } from "node:fs";
import { SERVER_GONE } from "./fixtures";

/**
 * Clears the marker that says the test server died.
 *
 * It has to be a file rather than a variable because Playwright starts a fresh
 * worker process after a failing test, which resets anything held in module
 * scope — so the first test to notice the server had gone told nobody, and
 * every test after it rediscovered the same thing and failed again.
 */
export default function globalSetup() {
  rmSync(SERVER_GONE, { force: true });
}
