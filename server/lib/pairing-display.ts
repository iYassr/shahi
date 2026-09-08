import QRCode from "qrcode";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
export async function pairingDisplay(url: string, expiresAt: number, copied: boolean) {
  const symbols = await Promise.all((["M", "L"] as const).map(async errorCorrectionLevel => {
    const lines = (await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel })).split("\n");
    while (lines.length && !plain(lines.at(-1)!).trim()) lines.pop();
    return { lines, width: Math.max(...lines.map(line => plain(line).length)) };
  }));
  return (columns: number, rows: number): string => {
    // Reserve the header, expiry and close hint. Never print a partial QR:
    // terminal wrapping or scrolling makes it impossible for the phone to scan.
    const symbol = symbols.find(qr => qr.width <= columns && qr.lines.length + 4 <= rows);
    if (!symbol) {
      const smallest = symbols.at(-1)!;
      const hints = ["More room needed for the QR", `Enlarge to ${smallest.width} columns × ${smallest.lines.length + 4} rows,`, "or reduce your terminal font size.", copied ? "Pairing code copied to clipboard." : "Use --code-only to copy the pairing code.", "Enter to close"];
      return hints.map(line => line.slice(0, columns)).slice(0, rows).join("\n");
    }
    const pad = " ".repeat(Math.floor((columns - symbol.width) / 2));
    const center = (text: string) => " ".repeat(Math.max(0, Math.floor((columns - text.length) / 2))) + text;
    return [center("Scan with Shahi"), "", ...symbol.lines.map(line => pad + line),
      center(`Expires ${new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · one use`),
      center(copied ? "Code copied · Enter to close" : "Enter to close"),
    ].join("\n");
  };
}

export async function showPairingPopup(url: string, expiresAt: number, copied: boolean) {
  const render = await pairingDisplay(url, expiresAt, copied);
  const draw = () => process.stdout.write("\x1b[2J\x1b[H" + render(process.stdout.columns || 80, process.stdout.rows || 24));
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  process.stdout.on("resize", draw);
  try {
    draw();
    await new Promise<void>(resolve => {
      // Read a line in cooked mode; entering the popup never changes the
      // terminal's raw-mode settings or leaves them behind on exit.
      const done = () => {
        process.stdin.off("data", done);
        process.stdin.off("end", done);
        process.off("SIGINT", done);
        process.off("SIGTERM", done);
        resolve();
      };
      process.stdin.once("data", done);
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
