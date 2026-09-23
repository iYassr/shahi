import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ApiContext, ApiError, api } from "../api";
import { Login } from "./Login";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount()); });

// Pre-release review: only the passcode's hash is kept, the first run shows
// it in a popup the plugin log does not record, and this page gave no way
// back. The reset action is the one that works.
test("a lost passcode has a way back from the sign-in page", async () => {
  await act(async () => { view = create(<ApiContext.Provider value={api}><Login onSuccess={() => {}} /></ApiContext.Provider>); });
  const text = JSON.stringify(view.toJSON());
  expect(text).toContain("herdr plugin action invoke shahi.reset-passcode");
  expect(text).toContain("herdr plugin log list --plugin shahi");
});

test("a sign-in refused as too many attempts says to wait, not that the passcode is wrong", async () => {
  const refusing = { ...api, login: async () => { throw new ApiError("Too many sign-in attempts are waiting. Try again shortly.", 429); } };
  await act(async () => { view = create(<ApiContext.Provider value={refusing}><Login onSuccess={() => {}} /></ApiContext.Provider>); });
  const form = view.root.findByType("form");
  await act(async () => { await form.props.onSubmit({ preventDefault() {} }); });
  const text = JSON.stringify(view.toJSON());
  expect(text).toContain("Too many sign-in attempts");
  expect(text).not.toContain("That passcode did not work.");
});
