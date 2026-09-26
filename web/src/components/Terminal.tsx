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
  /** The same screen without escapes, for assistive technology. */
  text: string;
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

export function Terminal({ ansi, text, cols, rows, scale }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  // The first size only: later sizes resize this instance (below) rather than
  // rebuilding it, so nothing depends on a frame arriving to repaint it.
  const initial = useRef({ cols, rows });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const identity = getComputedStyle(document.documentElement);
    const term = new Xterm({
      cols: initial.current.cols,
      rows: initial.current.rows,
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
    /*
     * A picture of the screen, not a place to type.
     *
     * `disableStdin` only stops xterm sending input. Its hidden textarea
     * stayed in the tab order, and its key handler still turned Tab,
     * Shift+Tab and Escape into terminal sequences and cancelled them: focus
     * could reach the terminal and never leave, and Escape could not close
     * focus view (pre-release bug hunt, 2026-09). Declining every key hands
     * it back to the browser, and to the page's own Escape handler.
     */
    term.attachCustomKeyEventHandler(() => false);
    if (term.textarea) {
      term.textarea.tabIndex = -1;
      term.textarea.setAttribute("aria-hidden", "true");
    }
    termRef.current = term;

    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, []);

  /*
   * Size and screen are painted together, once per change of either.
   *
   * The size used to rebuild the terminal and only a new frame painted it, so
   * a pane whose real layout arrived after its first frame (drawn at the
   * 146×42 default) went blank, and an idle shell or a blocked agent sends no
   * new frame to fix that (found in the pre-release review, 2026-09). One
   * effect also keeps a frame from being written twice when both change:
   * xterm queues writes but resets at once, so a second reset-and-write in the
   * same tick would print the screen twice.
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    // A frame is a whole screen, so reset before writing or the previous one
    // shows through wherever the new one is shorter.
    term.reset();
    term.write(ansi);
  }, [ansi, cols, rows]);

  // Reserve the scaled footprint once; scaling that same box would square the
  // zoom factor and clip small views or add blank panning space above 100%.
  const width = cols * FONT_SIZE * CELL_WIDTH_RATIO;
  const height = rows * FONT_SIZE * LINE_HEIGHT;
  /*
   * xterm draws rows a screen reader is told to skip, and `role="img"` made
   * everything inside presentational, so the Screen tab was a picture with no
   * words (pre-release bug hunt). The screen's text sits beside it instead:
   * readable by moving through it, and not a live region, because a whole
   * screen repainted every 400ms would be announced without end.
   */
  return (
    <div className="term" style={{ width: width * scale, height: height * scale }}
      aria-label="Terminal output" role="region">
      <pre className="visually-hidden">{text}</pre>
      <div ref={hostRef} aria-hidden="true" style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }} />
    </div>
  );
}

export default Terminal;
