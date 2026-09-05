/**
 * Renders a pane's screen with xterm.js.
 *
 * herdr's protocol has no way for a client to declare its own size: output
 * arrives already hard-wrapped at the server's terminal width (146 columns
 * here), and `recent_unwrapped` returns the same text because Claude Code wraps
 * its own output before it reaches the PTY. So there is nothing to reflow.
 *
 * Rather than pretend, the terminal is rendered at true size and the user is
 * given honest controls: fit the whole width on screen, or view at full size
 * and pan. Faking a reflow would mangle every diff, table and box the agents
 * draw.
 *
 * Each frame is a complete screen — there are no deltas to apply — so a repaint
 * is a full clear and write.
 *
 * Loaded on demand. xterm.js is most of this app's JavaScript, and the Screen
 * tab is not where anyone starts — so the dashboard should not pay for it.
 */
import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { CELL_WIDTH_RATIO, FONT_SIZE, LINE_HEIGHT } from "../termfit";

interface Props {
  ansi: string;
  cols: number;
  rows: number;
  /** Horizontal scale, 1 = true size. */
  scale: number;
}

/** Shahi ground and cursor; preserve the terminal ANSI palette for output. */
const THEME = {
  black: "#101010",
  red: "#ff8080",
  green: "#99ffe4",
  yellow: "#ffc799",
  blue: "#8bb8e8",
  magenta: "#ffc799",
  cyan: "#99ffe4",
  white: "#ffffff",
  brightBlack: "#8b8b8b",
  brightRed: "#ff8080",
  brightGreen: "#99ffe4",
  brightYellow: "#ffc799",
  brightBlue: "#8bb8e8",
  brightMagenta: "#ffc799",
  brightCyan: "#99ffe4",
  brightWhite: "#ffffff",
};

export function Terminal({ ansi, cols, rows, scale }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const identity = getComputedStyle(document.documentElement);
    const term = new Xterm({
      cols,
      rows,
      theme: {
        ...THEME,
        background: identity.getPropertyValue("--void").trim(),
        foreground: identity.getPropertyValue("--text").trim(),
        cursor: identity.getPropertyValue("--accent").trim(),
      },
      fontSize: FONT_SIZE,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      lineHeight: LINE_HEIGHT,
      // Nothing is typed into this element — input goes through the composer,
      // which can send the keys a phone keyboard cannot produce.
      disableStdin: true,
      cursorBlink: false,
      scrollback: 0,
      allowProposedApi: true,
    });

    term.open(host);
    termRef.current = term;

    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, [cols, rows]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // A frame is a whole screen, so reset before writing or the previous one
    // shows through wherever the new one is shorter.
    term.reset();
    term.write(ansi);
  }, [ansi]);

  // Reserve the scaled footprint once; scaling that same box would square the
  // zoom factor and clip small views or add blank panning space above 100%.
  const width = cols * FONT_SIZE * CELL_WIDTH_RATIO;
  const height = rows * FONT_SIZE * LINE_HEIGHT;
  return (
    <div className="term" style={{ width: width * scale, height: height * scale }}
      aria-label="Terminal output" role="img">
      <div ref={hostRef} style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }} />
    </div>
  );
}

export default Terminal;
