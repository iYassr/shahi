import { SHAHI_API_VERSION } from "@shahi/shared";
import { expect, test } from "./fixtures";
import { scenario } from "./stub/control";

/**
 * The stub keeps one situation for the whole run, and until the September 2026
 * review a test that did not choose one inherited the previous test's: left on
 * "empty", eight keyboard tests and two others failed at their first row. These
 * two run in order on purpose — the first leaves the worst state it can, and
 * the second, choosing nothing, must still start where the stub starts.
 */
test.describe.configure({ mode: "serial" });

test.describe("a test does not inherit the situation the one before it left", () => {
  test("leaves no agents and a contract this app cannot speak", async ({ page }) => {
    await scenario(page, "empty");
    const override = await page.request.post("/__stub/meta", { data: { api: { min: 99, max: 99 } } });
    expect(override.ok()).toBe(true);
  });

  test("still starts with the stub's agents, on the app's contract", async ({ page }) => {
    const meta = await (await page.request.get("/api/meta")).json();
    expect(meta.api).toEqual({ min: SHAHI_API_VERSION, max: SHAHI_API_VERSION });
    await page.goto("/");
    await expect(page.locator(".row").first()).toBeVisible();
  });
});
