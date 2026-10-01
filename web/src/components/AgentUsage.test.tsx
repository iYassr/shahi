import { afterEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { PlanUsage } from "@shahi/shared";
import { ApiContext, api } from "../api";
import { AgentUsage } from "./AgentUsage";

/**
 * The browser's Claude Code and Codex sections, held to what the phone's
 * Agents section does: Codex at once, Claude Code only once turned on, and a
 * window that has reset since its reading not shown as current.
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let view: ReactTestRenderer;
afterEach(async () => { if (view) await act(async () => view.unmount()); });

const now = Date.now();
const codex = { observedAt: now - 3 * 3_600_000, plan: "pro", windows: [{ label: "Weekly", usedPercent: 53.2, resetsAt: now + 2 * 86_400_000 }] };
const off: PlanUsage = { claude: { enabled: false, usage: null }, codex: { usage: codex }, checkedAt: now };
const on: PlanUsage = {
  claude: { enabled: true, usage: { observedAt: now - 60_000, windows: [{ label: "5-hour", usedPercent: 85, resetsAt: now + 3_600_000 }, { label: "Weekly", usedPercent: 40, resetsAt: now - 1 }] } },
  codex: { usage: codex }, checkedAt: now,
};
const text = () => JSON.stringify(view.toJSON());

test("Codex shows at once; Claude Code waits for its switch, which says what it costs", async () => {
  await act(async () => { view = create(<ApiContext.Provider value={{ ...api, planUsage: async () => off }}><AgentUsage computer="this computer" /></ApiContext.Provider>); });
  expect(text()).toContain("Codex");
  expect(text()).toContain("Pro");
  expect(view.root.findAll((n) => n.props.role === "meter").map((n) => n.props["aria-valuetext"])).toEqual(["53% used"]);
  expect(text()).toContain("Claude Code then hides its footer hints");
});

test("turning Claude Code on shows its windows, a reset one without a current figure", async () => {
  const calls: boolean[] = [];
  const client = { ...api, planUsage: async () => off, setClaudePlanUsage: async (enabled: boolean) => { calls.push(enabled); return on; } };
  await act(async () => { view = create(<ApiContext.Provider value={client}><AgentUsage computer="this computer" /></ApiContext.Provider>); });
  const toggle = view.root.find((n) => n.type === "input" && n.props.role === "switch");
  await act(async () => { toggle.props.onChange({ target: { checked: true } }); });
  expect(calls).toEqual([true]);
  const meters = view.root.findAll((n) => n.props.role === "meter").map((n) => [n.props["aria-label"], n.props["aria-valuetext"]]);
  expect(meters).toEqual([["5-hour limit", "85% used"], ["Weekly limit", "No current reading"], ["Weekly limit", "53% used"]]);
  expect(text()).toContain("Reset since the last reading");
});
