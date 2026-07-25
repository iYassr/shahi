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
 */
import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

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

const FONT_SIZE = 12;

export function Terminal({ ansi, cols, rows, scale }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  /**
   * The terminal's size before scaling.
   *
   * Needed because `transform: scale` draws smaller without laying out smaller:
   * at "Fit width" the element still reserved its full 787px, so the pane
   * scrolled sideways into 400px of empty black even though everything already
   * fitted. Measuring it lets the box match what is actually drawn.
   */
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      cols,
      rows,
      theme: THEME,
      fontSize: FONT_SIZE,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      lineHeight: 1.15,
      // Nothing is typed into this element — input goes through the composer,
      // which can send the keys a phone keyboard cannot produce.
      disableStdin: true,
      cursorBlink: false,
      scrollback: 0,
      allowProposedApi: true,
    });

    term.open(host);
    termRef.current = term;

    const measure = () => {
      const inner = host.querySelector<HTMLElement>(".xterm");
      if (inner?.offsetWidth) setNatural({ width: inner.offsetWidth, height: inner.offsetHeight });
    };
    measure();
    // The first measurement lands before the monospace font resolves, and the
    // cell width changes when it does.
    void document.fonts?.ready.then(measure);

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
      style={{
        transform: `scale(${scale})`,
        ...(natural && {
          width: natural.width * scale,
          height: natural.height * scale,
        }),
      }}
      // The terminal is a rendered image of another screen, not a live region
      // to be announced; the transcript tab is the readable form.
      aria-label="Terminal output"
      role="img"
    />
  );
}

/**
 * Scale that fits `cols` columns into the viewport width.
 *
 * xterm's cell width for SF Mono at 12px is close enough to 0.6em that this
 * lands within a column or two, which is all "fit width" needs to promise.
 */
export function fitScale(cols: number, viewportWidth: number): number {
  const approximateCellWidth = FONT_SIZE * 0.6;
  return Math.min(1, (viewportWidth - 16) / (cols * approximateCellWidth));
}
