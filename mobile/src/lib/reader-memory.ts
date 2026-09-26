/**
 * What the reader remembers about each pane, per computer: where you were, the
 * conversation last shown, and the terminal's place and view. Kept here, not
 * in the pane screen, because the computer's session forgets a pane's memory
 * when its conversation ends, and a library does not reach into a screen.
 */
import type { LogMessage } from "@shahi/shared";
import type { ScrollAnchor } from "./scroll-cells";

/**
 * Where you were in each pane's transcript, for the life of the process.
 *
 * The scroll offset otherwise lives only inside the mounted list, and both
 * ways of leaving destroy that: popping the route unmounts the whole screen,
 * and the read/screen toggle unmounts just the list. Either way, coming back
 * silently threw the reader to the tail — or worse, the top. "bottom" is kept
 * as its own value so a pane left at the tail still opens at the tail, which
 * is where a pane you were not reading mid-scroll should open.
 *
 * A position is the message id AND the pixel offset within that message.
 * Offsets were tried and failed exactly where it matters — leaving the pane
 * and coming back: the remount re-estimates item heights, and the fetched
 * window shifts as the conversation grows, so the saved offset named a
 * different place, and the restore either landed wrong or wedged waiting
 * for a content height that never came back (leaving every later scroll
 * unrecorded, which read as "never remembered"). The message being read is
 * the place; its id survives both remeasurement and window drift, while the
 * intra-message offset preserves the paragraph inside a multi-screen answer.
 */
interface ReaderMemory {
  scroll: Map<string, ScrollAnchor | "bottom">;
  /**
   * The conversation last shown, and which transcript it came from: message
   * ids are only unique within one transcript file (see `readLog`).
   */
  messages: Map<string, { transcript: string | null; messages: LogMessage[]; total?: number }>;
  /**
   * Where you were on each pane's *terminal*, and which view you were reading.
   *
   * The reader's memory above is by message id, because its list is windowed
   * and grows under you. The terminal is the opposite: one fixed block of
   * characters — herdr's `visible` is a screen's worth of rows — laid out the
   * same on every remount, so a pixel offset is the honest place here and the
   * reason offsets failed for the reader does not apply. It is a place in two
   * axes: 146 columns that do not fit across a phone scroll sideways, and a
   * screen taller than the viewport scrolls down.
   */
  terminalPlace: Map<string, { x: number; y: number }>;
  /**
   * Read-vs-screen, so leaving a pane on the terminal and coming back opens on
   * the terminal — before this, every return snapped to the reader and you
   * lost both the view and your place in it.
   */
  terminalView: Map<string, "reader" | "screen">;
}

/**
 * Reader memory belongs to a computer, the way drafts do: keyed by the
 * ComputerSession's API object, because pane ids are only unique within one
 * computer. It used to be one set of maps guarded by the connection's
 * credential, cleared whenever that changed — and the credential changes on
 * every SSH re-login (a new cookie) and on every switch to another computer (a
 * new relay target), so recovering from sleep or looking at a second computer
 * threw away every remembered place, view and conversation (pre-release
 * review). The API object survives both, and a new sign-in to the same
 * computer creates a new one, so nothing crosses computers or outlives a
 * sign-out. A WeakMap, so a disposed computer's memory goes with it.
 */
const memories = new WeakMap<object, ReaderMemory>();
export function memoryOf(owner: object): ReaderMemory {
  let memory = memories.get(owner);
  if (!memory) {
    memory = { scroll: new Map(), messages: new Map(), terminalPlace: new Map(), terminalView: new Map() };
    memories.set(owner, memory);
  }
  return memory;
}
export const paneScrollPlace = (owner: object, paneId: string) => memoryOf(owner).scroll.get(paneId);

/**
 * Forgets one pane's place, conversation and view. Its conversation ended:
 * closed, or another program took the pane id, and herdr reuses pane ids, so
 * the pre-release bug hunt found a remembered conversation shown under the
 * next one (see `ComputerSession`). Tests reset the maps with it as well.
 */
export function forgetPaneMemory(owner: object, paneId: string): void {
  const memory = memoryOf(owner);
  memory.scroll.delete(paneId);
  memory.messages.delete(paneId);
  memory.terminalPlace.delete(paneId);
  memory.terminalView.delete(paneId);
}
