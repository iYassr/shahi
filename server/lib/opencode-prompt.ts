import type { ParsedPrompt } from "@shahi/shared";

const LABELS = ["Allow once", "Allow always", "Reject"];

/** OpenCode marks its horizontal permission choice by background colour. */
export function openCodePrompt(raw: string, lines: string[]): ParsedPrompt | null {
  const clean = lines.map(line => line.replace(/^\s*┃\s?/, "").trimEnd());
  const header = clean.findLastIndex(line => line.trim() === "△ Permission required");
  const footer = clean.findIndex((line, i) => i > header && /^\s*Allow once\s+Allow always\s+Reject\s+ctrl\+f fullscreen\s+⇆ select\s+enter confirm\s*$/.test(line));
  if (header < 0 || footer < 0) return null;
  const rawRow = raw.split("\n").findLast(line => line.includes("Allow once") && line.includes("Allow always") && line.includes("Reject"));
  if (!rawRow) return null;
  const styles = backgrounds(rawRow);
  const colors = LABELS.map(label => {
    const start = styles.text.indexOf(label);
    if (start < 0) return undefined;
    const held = styles.colors.slice(start, start + label.length);
    return held.every(color => color === held[0]) ? held[0] : undefined;
  });
  // The two unselected choices share the panel colour. Exactly one differs.
  // No colour information, or an unfamiliar renderer, gives no guessed cursor.
  if (colors.some(color => color === undefined)) return null;
  const selected = colors.findIndex(color => colors.filter(other => other === color).length === 1);
  if (selected < 0 || new Set(colors).size !== 2) return null;
  const context = clean.slice(header + 1, footer).join("\n").trim();
  if (!context) return null;
  return { question: "Permission required", context: [context], answer: "horizontal", options: LABELS.map((label, i) => ({ index: i + 1, label, selected: i === selected })) };
}

/** Read only SGR background state; themes may use truecolour, indexed or ANSI. */
function backgrounds(row: string): { text: string; colors: (string | undefined)[] } {
  let bg: string | undefined;
  let text = "";
  const colors: (string | undefined)[] = [];
  for (const part of row.split(/(\x1b\[[0-9;]*m)/)) {
    if (!part.startsWith("\x1b[")) {
      text += part;
      colors.push(...Array.from({ length: part.length }, () => bg));
      continue;
    }
    const codes = part.slice(2, -1).split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0 || code === 49) bg = undefined;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code);
      else if (code === 38 || code === 48 || code === 58) {
        const count = codes[i + 1] === 2 ? 4 : codes[i + 1] === 5 ? 2 : 0;
        if (code === 48 && count && i + count < codes.length) bg = codes.slice(i + 1, i + count + 1).join(";");
        i += count;
      }
    }
  }
  return { text, colors };
}
