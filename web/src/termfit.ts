/**
 * The terminal's sizing maths, kept apart from the terminal itself.
 *
 * `Terminal.tsx` pulls in xterm.js, which is most of the app's JavaScript and
 * is only needed on the Screen tab. The pane view needs this function on every
 * render, so it lives here where importing it costs nothing.
 */

/** xterm's own settings, in one place so the terminal and its box agree. */
export const FONT_SIZE = 12;
export const LINE_HEIGHT = 1.15;
/** Monospace advance as a fraction of the font size, for SF Mono and Menlo. */
export const CELL_WIDTH_RATIO = 0.6;

/**
 * Scale that fits `cols` columns into the viewport width.
 *
 * xterm's cell width for SF Mono at 12px is close enough to 0.6em that this
 * lands within a column or two, which is all "fit width" needs to promise.
 */
export function fitScale(cols: number, viewportWidth: number): number {
  const approximateCellWidth = FONT_SIZE * CELL_WIDTH_RATIO;
  return Math.min(1, (viewportWidth - 16) / (cols * approximateCellWidth));
}
