/**
 * Keeps a reader's page small enough to cross the relay.
 *
 * The reader asks for a window of messages by count — sixty on the phone — and
 * nothing bounded the window's weight. A tool result is cut to 2,000
 * characters where it is read, but a message's own text was sent whole, so one
 * very large pasted or written message among the last sixty (about 800 KB was
 * enough) put the page over what one relay frame carries. The relay link then
 * answered 413 on every poll, and the phone said "Nothing to read yet" about a
 * conversation it had been reading, until thirty more exchanges pushed the
 * large message out of the window (pre-release bug hunt; the same request over
 * loopback returned 836 KB with a 200).
 *
 * So a page is bounded twice, after the readers and before the ETag: every
 * text and thinking block is cut to a length a phone can show, with a line
 * that says so, and if the page still outweighs the budget its oldest
 * messages are left for "Load earlier". Both clients already take a page as
 * the messages that end where they asked, and count back from its length for
 * the next one, so a shorter page needs nothing new from either of them.
 */
import type { LogBlock, LogMessage, SessionLog } from "@shahi/shared";

/** The longest text or thinking block a page carries whole: many screens of reading. */
export const MAX_BLOCK_CHARS = 32_000;

/**
 * The most a page's JSON may weigh. Well under a relay body
 * (`RELAY_LIMITS.maxBodyBytes`, about 765 KB) because the whole response,
 * headers included, travels in that one sealed frame, and because a phone on
 * cellular polls this every few seconds.
 */
export const PAGE_BUDGET_BYTES = 512 * 1024;

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

/** The page as sent: the same object when it already fits, which is nearly always. */
export function fitPage(log: SessionLog, budget = PAGE_BUDGET_BYTES): SessionLog {
  const messages = log.messages.map(shorten);
  const changed = messages.some((message, i) => message !== log.messages[i]);
  const page = changed ? { ...log, messages } : log;
  if (bytes(page) <= budget) return page;

  // Oldest first, and never the newest: the tail is what a poll is for, and a
  // page with nothing in it would read as an empty conversation. With its
  // blocks cut, one message outweighs the budget only if it holds more than a
  // dozen of them at full length; that one is sent as it is.
  const sizes = messages.map((message) => bytes(message) + 1);
  let weight = bytes({ ...log, messages: [] }) + sizes.reduce((sum, size) => sum + size, 0);
  let start = 0;
  while (weight > budget && start < messages.length - 1) weight -= sizes[start++]!;
  return { ...log, messages: messages.slice(start) };
}

function shorten(message: LogMessage): LogMessage {
  if (!message.blocks.some(tooLong)) return message;
  return { ...message, blocks: message.blocks.map((block) => (tooLong(block) ? cut(block) : block)) };
}

function tooLong(block: LogBlock): block is Extract<LogBlock, { kind: "text" | "thinking" }> {
  return (block.kind === "text" || block.kind === "thinking") && block.text.length > MAX_BLOCK_CHARS;
}

function cut(block: Extract<LogBlock, { kind: "text" | "thinking" }>): LogBlock {
  // Never between the two halves of a surrogate pair, which would put a
  // replacement character, or invalid JSON for some parsers, at the cut.
  const end = /[\uD800-\uDBFF]/.test(block.text[MAX_BLOCK_CHARS - 1]!) ? MAX_BLOCK_CHARS - 1 : MAX_BLOCK_CHARS;
  const rest = block.text.length - end;
  return {
    ...block,
    text: `${block.text.slice(0, end)}\n\n… ${rest.toLocaleString("en-US")} more characters, too long to send to a phone. The whole message is in the transcript on your computer.`,
  };
}
