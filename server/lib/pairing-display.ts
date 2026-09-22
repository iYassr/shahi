import QRCode from "qrcode";

/**
 * The pairing code as a link to the browser app. The code rides in the
 * fragment, which a browser never sends to the site, its referrers or its logs;
 * both clients' `parsePairingUrl` also accept it pasted.
 */
export const browserPairingLink = (url: string) => `https://getshahi.dev/pwa/#pair=${encodeURIComponent(url)}`;

/**
 * What the popup shows: the QR, or the same code as text for a machine the
 * phone cannot see — a laptop whose agents run on a server over SSH, where
 * there is no clipboard to copy into and a QR on the laptop's own screen
 * cannot be scanned by the laptop. The text was dropped when the QR got its
 * fitted screen, leaving no way to it from the popup at all; `--code-only`
 * needs a flag an action cannot pass (pre-release review).
 */
export type PairingView = "qr" | "text";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
export async function pairingDisplay(url: string, expiresAt: number, copied: boolean) {
  const symbols = await Promise.all((["M", "L"] as const).map(async errorCorrectionLevel => {
    const lines = (await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel })).split("\n");
    while (lines.length && !plain(lines.at(-1)!).trim()) lines.pop();
    return { lines, width: Math.max(...lines.map(line => plain(line).length)) };
  }));
  const expiry = `Expires ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · one use`;
  const link = browserPairingLink(url);

  const asText = (columns: number, rows: number): string => {
    // The link is written whole and left to the terminal to wrap: a line
    // break inside it would travel with a copy and break the code. So it is
    // measured, and the optional lines give way before it would scroll.
    const height = (line: string) => Math.max(1, Math.ceil(line.length / columns));
    const essential = [link, "", "T+Enter: QR · Enter to close"];
    const optional = [expiry, "", "Open it in a browser, or paste it into the browser app:", ""];
    while (optional.length && [...optional, ...essential].reduce((n, line) => n + height(line), 0) > rows) optional.shift();
    const lines = [...optional, ...essential];
    if (lines.reduce((n, line) => n + height(line), 0) > rows) {
      return ["More room needed for the code as text.", "T+Enter: QR · Enter to close"].map(line => line.slice(0, columns)).slice(0, rows).join("\n");
    }
    return lines.join("\n");
  };

  return (columns: number, rows: number, view: PairingView = "qr"): string => {
    if (view === "text") return asText(columns, rows);
    // Reserve the header, expiry and close hint. Never print a partial QR:
    // terminal wrapping or scrolling makes it impossible for the phone to scan.
    const symbol = symbols.find(qr => qr.width <= columns && qr.lines.length + 4 <= rows);
    if (!symbol) {
      const smallest = symbols.at(-1)!;
      const hints = ["More room needed for the QR", `Enlarge to ${smallest.width} columns × ${smallest.lines.length + 4} rows,`, "or reduce your terminal font size.", copied ? "Code copied. T+Enter shows it as text." : "T+Enter shows the code as text.", "Enter to close"];
      return hints.map(line => line.slice(0, columns)).slice(0, rows).join("\n");
    }
    const pad = " ".repeat(Math.floor((columns - symbol.width) / 2));
    const center = (text: string) => " ".repeat(Math.max(0, Math.floor((columns - text.length) / 2))) + text;
    return [center("Scan with Shahi"), "", ...symbol.lines.map(line => pad + line),
      center(expiry),
      center(copied ? "Code copied · T+Enter: as text · Enter to close" : "T+Enter: code as text · Enter to close"),
    ].join("\n");
  };
}

export async function showPairingPopup(url: string, expiresAt: number, copied: boolean) {
  const render = await pairingDisplay(url, expiresAt, copied);
  let view: PairingView = "qr";
  const draw = () => process.stdout.write("\x1b[2J\x1b[H" + render(process.stdout.columns || 80, process.stdout.rows || 24, view));
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  process.stdout.on("resize", draw);
  try {
    draw();
    await new Promise<void>(resolve => {
      // Read a line in cooked mode; entering the popup never changes the
      // terminal's raw-mode settings or leaves them behind on exit.
      const done = () => {
        process.stdin.off("data", line);
        process.stdin.off("end", done);
        process.off("SIGINT", done);
        process.off("SIGTERM", done);
        resolve();
      };
      // "t" swaps the QR and the text; any other line, a bare Enter included, closes.
      const line = (chunk: Buffer | string) => {
        if (String(chunk).trim().toLowerCase() !== "t") return done();
        view = view === "qr" ? "text" : "qr";
        draw();
      };
      process.stdin.on("data", line);
      process.stdin.once("end", done);
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
      process.stdin.resume();
    });
  } finally {
    process.stdin.pause();
    process.stdout.off("resize", draw);
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  }
}
