/**
 * A pane's screen, as lines of styled runs, for clients that draw it without
 * a terminal emulator.
 *
 * herdr's `pane.read {format: "ansi"}` is not a byte stream to replay: it is
 * the visible screen already laid out, one row per line, with only SGR
 * (`ESC[…m`) between the characters. Every escape in the captured fixtures
 * (server/fixtures, Claude Code 2.1.286 and codex 0.157.1 under herdr 0.9.1,
 * October 2026) is SGR, mostly 24-bit colour. So colour needs no cursor model,
 * only SGR read into spans. Every other escape is dropped exactly as the
 * server's `stripAnsi` drops it (same three alternatives), so the characters
 * here are always the frame's `text`.
 */

/** A run of characters drawn alike. Colours are `#rrggbb`; absent means the client's default. */
export interface AnsiSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  /** Foreground and background swapped, defaults included: see `spanColours`. */
  inverse?: true;
}

export type AnsiLine = readonly AnsiSpan[];

/**
 * The 16 standard colours, for a dark background: xterm's own black and blue
 * vanish on near-black, so these keep each hue and lift its lightness.
 */
const PALETTE = [
  "#4D4D4D", "#E06C75", "#98C379", "#E5C07B", "#61AFEF", "#C678DD", "#56B6C2", "#D0D0D0",
  "#7F848E", "#FF7B86", "#B5E890", "#FFD68A", "#82C4FF", "#E19BFF", "#7FD8E3", "#FFFFFF",
] as const;

const CUBE = [0, 95, 135, 175, 215, 255] as const;
const hex = (r: number, g: number, b: number) =>
  `#${((1 << 24) | (clamp(r) << 16) | (clamp(g) << 8) | clamp(b)).toString(16).slice(1).toUpperCase()}`;
const clamp = (n: number) => Math.max(0, Math.min(255, n | 0));

/** xterm's 256-colour table: the 16 above, a 6×6×6 cube, then 24 greys. */
export function colour256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return PALETTE[n];
  if (n < 232) {
    const i = n - 16;
    return hex(CUBE[Math.floor(i / 36)]!, CUBE[Math.floor(i / 6) % 6]!, CUBE[i % 6]!);
  }
  const grey = 8 + (n - 232) * 10;
  return hex(grey, grey, grey);
}

/** The same alternatives as the server's `stripAnsi`: OSC, CSI, then two-byte escapes. */
const ESCAPE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|(?:\x1b\[|\x9b)[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;
/** Its own instance for single lines, so the two passes never share `lastIndex`. */
const LINE_ESCAPE = new RegExp(ESCAPE.source, "g");

interface State {
  fg: string | undefined;
  bg: string | undefined;
  /** bold 1, dim 2, italic 4, underline 8, inverse 16 */
  flags: number;
}

const BOLD = 1, DIM = 2, ITALIC = 4, UNDERLINE = 8, INVERSE = 16;
const keyOf = (s: State) => `${s.fg ?? ""}|${s.bg ?? ""}|${s.flags}`;

/** Applies one SGR sequence's parameters (`"38;2;255;0;0"`) to `s`. */
function applySgr(s: State, params: string): void {
  const p = params === "" ? [0] : params.split(";").map((v) => (v === "" ? 0 : Number(v)));
  for (let i = 0; i < p.length; i++) {
    const n = p[i]!;
    if (n === 0) { s.fg = undefined; s.bg = undefined; s.flags = 0; }
    else if (n === 1) s.flags |= BOLD;
    else if (n === 2) s.flags |= DIM;
    else if (n === 3) s.flags |= ITALIC;
    else if (n === 4) s.flags |= UNDERLINE;
    else if (n === 7) s.flags |= INVERSE;
    else if (n === 22) s.flags &= ~(BOLD | DIM);
    else if (n === 23) s.flags &= ~ITALIC;
    else if (n === 24) s.flags &= ~UNDERLINE;
    else if (n === 27) s.flags &= ~INVERSE;
    else if (n >= 30 && n <= 37) s.fg = PALETTE[n - 30];
    else if (n === 39) s.fg = undefined;
    else if (n >= 40 && n <= 47) s.bg = PALETTE[n - 40];
    else if (n === 49) s.bg = undefined;
    else if (n >= 90 && n <= 97) s.fg = PALETTE[n - 90 + 8];
    else if (n >= 100 && n <= 107) s.bg = PALETTE[n - 100 + 8];
    else if (n === 38 || n === 48) {
      let colour: string | undefined;
      if (p[i + 1] === 5) { colour = colour256(p[i + 2]!); i += 2; }
      else if (p[i + 1] === 2) { colour = hex(p[i + 2]!, p[i + 3]!, p[i + 4]!); i += 4; }
      else break; // Malformed: nothing after it can be read with confidence.
      if (n === 38) s.fg = colour; else s.bg = colour;
    }
  }
}

function spanOf(text: string, s: State): AnsiSpan {
  const span: AnsiSpan = { text };
  if (s.fg) span.fg = s.fg;
  if (s.bg) span.bg = s.bg;
  if (s.flags & BOLD) span.bold = true;
  if (s.flags & DIM) span.dim = true;
  if (s.flags & ITALIC) span.italic = true;
  if (s.flags & UNDERLINE) span.underline = true;
  if (s.flags & INVERSE) span.inverse = true;
  return span;
}

/** One line read from its starting state; adjacent runs drawn alike are one span. */
function parseLine(raw: string, start: State): AnsiSpan[] {
  const s: State = { ...start };
  const spans: AnsiSpan[] = [];
  let last = 0;
  let lastKey = "";
  const push = (text: string) => {
    if (!text) return;
    const key = keyOf(s);
    const previous = spans.at(-1);
    if (previous && key === lastKey) previous.text += text;
    else { spans.push(spanOf(text, s)); lastKey = key; }
  };
  LINE_ESCAPE.lastIndex = 0;
  for (let m = LINE_ESCAPE.exec(raw); m; m = LINE_ESCAPE.exec(raw)) {
    push(raw.slice(last, m.index));
    last = m.index + m[0].length;
    const seq = m[0];
    if (seq.endsWith("m") && (seq.startsWith("\x1b[") || seq.startsWith("\x9b"))) {
      const params = seq.slice(seq.startsWith("\x9b") ? 1 : 2, -1);
      if (!params.includes("?")) applySgr(s, params);
    }
  }
  push(raw.slice(last));
  return spans;
}

/**
 * Lines already read, by their starting state and raw text. The screen is
 * re-read every 400ms while watched and most rows do not change, so a row
 * read before comes back as the same array: a client that memoises rows by
 * identity redraws only the rows that moved. Bounded; cleared when full.
 */
const lines = new Map<string, AnsiLine>();
const MAX_LINES = 2_000;

/** The screen as lines of spans; their characters joined are `stripAnsi(screen)`. */
export function ansiLines(screen: string): AnsiLine[] {
  const out: AnsiLine[] = [];
  const s: State = { fg: undefined, bg: undefined, flags: 0 };
  let lineStart = 0;
  let startKey = keyOf(s);
  let start: State = { ...s };
  // One pass for the line boundaries and the state each line starts in: a
  // newline only ever falls between escapes, never inside one.
  const finish = (end: number) => {
    const raw = screen.slice(lineStart, end);
    const key = `${startKey}\u0000${raw}`;
    let line = lines.get(key);
    if (!line) {
      if (lines.size >= MAX_LINES) lines.clear();
      line = parseLine(raw, start);
      lines.set(key, line);
    }
    out.push(line);
  };
  const text = (from: number, to: number) => {
    for (let nl = screen.indexOf("\n", from); nl !== -1 && nl < to; nl = screen.indexOf("\n", nl + 1)) {
      finish(nl);
      lineStart = nl + 1;
      startKey = keyOf(s);
      start = { ...s };
    }
  };
  let last = 0;
  ESCAPE.lastIndex = 0;
  for (let m = ESCAPE.exec(screen); m; m = ESCAPE.exec(screen)) {
    text(last, m.index);
    last = m.index + m[0].length;
    const seq = m[0];
    if (seq.endsWith("m") && (seq.startsWith("\x1b[") || seq.startsWith("\x9b"))) {
      const params = seq.slice(seq.startsWith("\x9b") ? 1 : 2, -1);
      if (!params.includes("?")) applySgr(s, params);
    }
  }
  text(last, screen.length);
  finish(screen.length);
  return out;
}

/** The colours a span is drawn in, with inverse resolved against the client's defaults. */
export function spanColours(span: AnsiSpan, defaults: { fg: string; bg: string }): { color?: string; backgroundColor?: string } {
  if (span.inverse) return { color: span.bg ?? defaults.bg, backgroundColor: span.fg ?? defaults.fg };
  return { ...(span.fg ? { color: span.fg } : {}), ...(span.bg ? { backgroundColor: span.bg } : {}) };
}
