import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PlanUsage } from "@shahi/shared";
import { AgentUsage } from "./agent-usage";

/**
 * Settings' Agents section. What must hold: Codex's limits show with nothing
 * to turn on; Claude Code's are off until the person turns them on, with what
 * that costs said beside the switch; a reading from before a window reset is
 * not shown as current.
 */
const now = Date.now();
const codex = { observedAt: now - 3 * 3_600_000, plan: "pro", windows: [{ label: "Weekly", usedPercent: 53.2, resetsAt: now + 2 * 86_400_000 }] };
const off: PlanUsage = { claude: { enabled: false, usage: null }, codex: { usage: codex }, checkedAt: now };
const on: PlanUsage = {
  claude: { enabled: true, usage: { observedAt: now - 60_000, windows: [{ label: "5-hour", usedPercent: 85, resetsAt: now + 3_600_000 }, { label: "Weekly", usedPercent: 40, resetsAt: now - 1 }] } },
  codex: { usage: codex }, checkedAt: now,
};

function api(first: PlanUsage) {
  return { planUsage: jest.fn().mockResolvedValue(first), setClaudePlanUsage: jest.fn().mockResolvedValue(on) };
}

test("Codex's limits show at once, and Claude Code's wait for the person to turn them on", async () => {
  const client = api(off);
  const view = render(<AgentUsage api={client as never} focused live computer="studio" />);
  await waitFor(() => view.getByText("Codex"));
  expect(view.getByText("Pro")).toBeTruthy();
  expect(view.getByLabelText(/Weekly limit, 53% used\. Resets/)).toBeTruthy();
  expect(view.getByText("Updated 3h ago, from Codex's last turn.")).toBeTruthy();
  expect(view.getByText(/Claude Code then hides its footer hints/)).toBeTruthy();
  expect(view.queryByLabelText(/5-hour limit/)).toBeNull();
});

test("turning Claude Code on shows its windows, and a window that has reset since is not shown as current", async () => {
  const client = api(off);
  const view = render(<AgentUsage api={client as never} focused live computer="studio" />);
  await waitFor(() => view.getByLabelText("Show Claude Code plan usage"));
  fireEvent(view.getByLabelText("Show Claude Code plan usage"), "valueChange", true);
  await waitFor(() => view.getByLabelText(/5-hour limit, 85% used/));
  expect(client.setClaudePlanUsage).toHaveBeenCalledWith(true);
  expect(view.getAllByLabelText(/Weekly limit/).map((n) => n.props.accessibilityLabel)).toContain("Weekly limit, no current reading. Reset since the last reading");
  expect(view.getByText(/put back the status line you had before/)).toBeTruthy();
});

test("Claude Code turned on before its next reply says when its limits will appear", async () => {
  const client = api({ ...on, claude: { enabled: true, usage: null } });
  const view = render(<AgentUsage api={client as never} focused live computer="studio" />);
  await waitFor(() => view.getByText(/Appears after Claude Code's next reply on studio/));
});

test("a refusal is said, and the switch stays where it was", async () => {
  const client = api(off);
  client.setClaudePlanUsage.mockRejectedValue(new Error("Claude Code's settings.json could not be read, so it was left unchanged."));
  const view = render(<AgentUsage api={client as never} focused live computer="studio" />);
  await waitFor(() => view.getByLabelText("Show Claude Code plan usage"));
  fireEvent(view.getByLabelText("Show Claude Code plan usage"), "valueChange", true);
  await waitFor(() => view.getByText(/settings.json could not be read/));
  expect(view.getByLabelText("Show Claude Code plan usage").props.value).toBe(false);
});

test("nothing is read while Settings is not on screen", () => {
  const client = api(off);
  render(<AgentUsage api={client as never} focused={false} live computer="studio" />);
  expect(client.planUsage).not.toHaveBeenCalled();
});
