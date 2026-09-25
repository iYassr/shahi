import { expect, test } from "bun:test";
import QRCode from "qrcode";
import { parsePairingUrl } from "@shahi/shared/pairing";
import { browserPairingLink, pairingDisplay } from "./pairing-display";
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
// herdr's popup is about 32 columns and 3 rows smaller than the terminal, so
// "Enlarge to 51 columns × 30 rows" appeared inside an 80×36 terminal, which
// already had both (pre-release bug hunt). The hint now says what is missing.
test("a popup too narrow for the QR says how much more room it needs, not a terminal size it already has", async () => {
  const render = await pairingDisplay(url, Date.now() + 600000, false);
  // The smallest code the popup can show: low error correction, plus the
  // header, expiry and close lines.
  const symbol = strip(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "L" })).trimEnd().split("\n");
  const width = Math.max(...symbol.map(line => line.length));
  const height = symbol.length + 4;
  expect(strip(render(width, height))).toContain("Scan with Shahi");
  const narrow = strip(render(width - 3, height + 3));
  expect(narrow).toContain("More room needed for the QR");
  expect(narrow).toContain("3 more columns in this window.");
  expect(narrow).not.toContain("row");
  expect(narrow).not.toMatch(/Enlarge to \d+ columns/);
  expect(narrow).toContain("hide herdr's");
  const both = strip(render(width - 1, height - 2));
  expect(both).toContain("1 more column and 2 more rows in this window.");
  for (const [w, h] of [[width - 3, height + 3], [width - 1, height - 2]]) {
    for (const line of strip(render(w!, h!)).split("\n")) expect(line.length).toBeLessThanOrEqual(w!);
  }
});

test("resizing restores the full QR without creating a new pairing code", async () => {
  const render = await pairingDisplay(url, Date.now() + 600000, true);
  const original = render(80, 40);
  expect(render(80, 24)).toContain("More room needed");
  expect(render(80, 40)).toBe(original);
});

/**
 * A laptop whose agents run on a server over SSH has no clipboard the popup
 * can copy into, and cannot scan a QR on its own screen. The pre-release
 * review found the popup offered nothing else: the text code and the browser
 * link the README promises had gone when the QR got its fitted screen, and
 * the hint pointed at `--code-only`, a flag an action cannot pass.
 */
test("a laptop with no clipboard can have the code as text, whole", async () => {
  const render = await pairingDisplay(url, Date.now() + 600000, false);
  expect(strip(render(80, 40))).toContain("T+Enter: code as text");
  expect(strip(render(80, 24))).toContain("T+Enter shows the code as text");
  expect(strip(render(80, 24))).not.toContain("--code-only");
  for (const [width, height] of [[80, 24], [60, 12], [40, 10]]) {
    const lines = strip(render(width!, height!, "text")).split("\n");
    // Written as one line and left to the terminal to wrap: a break of ours
    // inside it would travel with a copy and spoil the code.
    const link = lines.find(line => line.includes("#pair="));
    expect(link).toBe(browserPairingLink(url));
    expect(parsePairingUrl(link!)).toEqual(parsePairingUrl(url));
    const rows = lines.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / width!)), 0);
    expect(rows).toBeLessThanOrEqual(height!);
    expect(lines.join("\n")).toContain("Enter to close");
  }
  const cramped = strip(render(40, 4, "text"));
  expect(cramped).toContain("More room needed");
  expect(cramped).not.toContain("#pair=");
});

test("in the popup, T and Enter swaps to the text and back, and Enter alone closes", async () => {
  const script = `import { showPairingPopup } from ${JSON.stringify(`${import.meta.dir}/pairing-display.ts`)};
await showPairingPopup(${JSON.stringify(url)}, Date.now() + 600000, false);`;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  let out = "";
  const reading = (async () => { for await (const chunk of proc.stdout) out += new TextDecoder().decode(chunk); })();
  const until = async (what: (text: string) => boolean) => {
    for (const end = Date.now() + 5000; Date.now() < end && !what(strip(out)); ) await Bun.sleep(20);
    return what(strip(out));
  };
  const link = browserPairingLink(url);
  const count = (text: string, part: string) => text.split(part).length - 1;
  try {
    expect(await until(text => text.includes("Enter to close"))).toBe(true);
    expect(strip(out)).not.toContain(link);
    // A popup is a PTY in cooked mode, so each line arrives as one chunk.
    proc.stdin.write("t\n");
    await proc.stdin.flush();
    expect(await until(text => text.includes(link))).toBe(true);
    proc.stdin.write("T\n");
    await proc.stdin.flush();
    expect(await until(text => count(text, "T+Enter shows the code as text") === 2)).toBe(true);
    proc.stdin.write("\n");
    await proc.stdin.flush();
    expect(await Promise.race([proc.exited, Bun.sleep(5000).then(() => "still open")])).toBe(0);
  } finally {
    proc.kill();
    await reading;
  }
}, 20_000);
