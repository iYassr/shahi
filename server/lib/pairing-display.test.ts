import { expect, test } from "bun:test";
import { pairingDisplay } from "./pairing-display";
const url = "shahi://pair#v=1&server=" + "a".repeat(43) + "&relay=" + encodeURIComponent("https://relay.getshahi.dev") + "&secret=" + "b".repeat(43);
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

test("the complete code and controls fit without wrapping or scrolling", async () => {
  const render = await pairingDisplay(url, Date.now() + 600000, true);
  for (const [width, height] of [[80, 40], [60, 32], [55, 30]]) {
    const screen = strip(render(width!, height!));
    expect(screen).toContain("Scan with Shahi");
    expect(screen).toContain("Enter to close");
    expect(screen).not.toContain(url);
    expect(screen.split("\n").length).toBeLessThanOrEqual(height!);
    for (const line of screen.split("\n")) expect(line.length).toBeLessThanOrEqual(width!);
    expect(screen).toMatch(/[▄▀█]/);
  }
});
test("a short or narrow terminal shows a resize hint instead of a clipped code", async () => {
  const render = await pairingDisplay(url, Date.now() + 600000, false);
  for (const [width, height] of [[80, 24], [40, 40]]) {
    const screen = strip(render(width!, height!));
    expect(screen).toContain("More room needed");
    expect(screen).not.toMatch(/[▄▀█]/);
    expect(screen.split("\n").length).toBeLessThanOrEqual(height!);
    for (const line of screen.split("\n")) expect(line.length).toBeLessThanOrEqual(width!);
  }
});
test("resizing restores the full QR without creating a new pairing code", async () => {
  const render = await pairingDisplay(url, Date.now() + 600000, true);
  const original = render(80, 40);
  expect(render(80, 24)).toContain("More room needed");
  expect(render(80, 40)).toBe(original);
});
