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

/** Vesper, so the embedded terminal matches the app around it. */
const THEME = {
  background: "#101010",
  foreground: "#ffffff",
  cursor: "#ffc799",
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

    const term = new Xterm({
      cols,
      rows,
      theme: THEME,
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

  return (
    <div
      className="term"
      ref={hostRef}
      /*
       * The box is sized to what the transform actually draws.
       *
       * `scale` shrinks the picture and not the layout, so at "Fit width" this
       * element still reserved its full unscaled width and the pane scrolled
       * sideways into empty black. Computed from the grid rather than measured
       * off the DOM: xterm sizes itself from its container, so measuring the
       * container and then resizing it chases its own tail.
       */
      style={{
        transform: `scale(${scale})`,
        width: cols * FONT_SIZE * CELL_WIDTH_RATIO * scale,
        height: rows * FONT_SIZE * LINE_HEIGHT * scale,
      }}
      // The terminal is a rendered image of another screen, not a live region
      // to be announced; the transcript tab is the readable form.
      aria-label="Terminal output"
      role="img"
    />
  );
}

export default Terminal;
