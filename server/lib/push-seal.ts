/**
 * Sealed notification content: what a waiting agent is asking, readable only
 * by the phone that asked to be told.
 *
 * A native notification goes through Expo's push service and then Apple's,
 * and both read everything in it. The question an agent is waiting on — the
 * command it wants to run, the diff it wants to write — must not go through
 * them in clear text. So a phone paired over the relay gives the computer a
 * key of its own with its push registration (over the end-to-end encrypted
 * link), and the computer seals the words here. The phone's Notification
 * Service Extension opens them before iOS shows anything
 * (`mobile/plugins/notification-service/PushEnvelope.swift` is the other half,
 * and checks the same known-answer vector as `push-seal.test.ts`).
 *
 * AES-256-GCM with a fresh random 96-bit nonce per message: at a handful of
 * notifications an hour per key, random nonces are far inside GCM's bound.
 * The associated data names the format, the computer and the pane, the two
 * routing fields Expo and Apple carry in clear, so a box replayed under
 * another pane's notification does not open.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { shownContext, shownLabels, type ParsedPrompt, type PromptOption } from "@shahi/shared";

/**
 * Printable text of at most `maxBytes` of UTF-8, cut between graphemes so an
 * emoji or a combining mark is never split. Control characters become spaces:
 * they mean nothing in a notification and JSON escapes each into six bytes.
 */
export function fitText(text: string, maxBytes: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  const encoder = new TextEncoder();
  if (encoder.encode(clean).length <= maxBytes) return clean;
  const budget = maxBytes - encoder.encode("…").length;
  let out = "";
  let used = 0;
  for (const { segment } of new Intl.Segmenter().segment(clean)) {
    const size = encoder.encode(segment).length;
    if (used + size > budget) break;
    out += segment;
    used += size;
  }
  return `${out}…`;
}

export const PUSH_SEAL_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * APNs refuses a payload over 4 KB, and Expo adds its own fields around ours.
 * The box is base64 (4/3 larger) beside the content-free words and the
 * routing fields, so the sealed text stays at 2 KB: about 3 KB on the wire.
 */
export const MAX_SEALED_BYTES = 2_000;
const MAX_TITLE_BYTES = 160;
const MAX_BODY_BYTES = 700;
/** An action's title: a button, shown on one line. */
const MAX_ACTION_TITLE_BYTES = 80;
/** iOS shows a notification's actions in a short list; see `answerableOptions`. */
const MAX_ACTIONS = 3;

/** A push key as the phone sends it: base64 of 32 random bytes. Anything else is refused. */
export function parsePushKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === KEY_BYTES && bytes.toString("base64") === value ? value : null;
}

/**
 * What a notification names its key by, so the extension finds the right one
 * among the phone's computers: the first 8 bytes of its SHA-256, in hex. The
 * push services see it; it says nothing about the key.
 */
export function pushKeyId(key: string): string {
  return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 16);
}

export function associatedData(serverId: string, paneId: string): Buffer {
  return Buffer.from(`shahi-push/${PUSH_SEAL_VERSION}\n${serverId}\n${paneId}`, "utf8");
}

/** base64 of nonce ‖ ciphertext ‖ tag: CryptoKit's `SealedBox(combined:)`. */
export function seal(key: string, serverId: string, paneId: string, plaintext: string, nonce: Uint8Array = randomBytes(NONCE_BYTES)): string {
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
  cipher.setAAD(associatedData(serverId, paneId));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

/** The option an action answers with: the parser's own label, and the cleaned one on the button. */
export interface SealedOption {
  index: number;
  label: string;
  title: string;
}

/** What the extension shows, and what an action posts to `/answer`. */
export interface SealedContent {
  title: string;
  subtitle?: string;
  body: string;
  instanceId?: string;
  answer?: {
    promptId: string;
    question?: string;
    context?: string[];
    options: SealedOption[];
  };
}

/**
 * The options offered as buttons. Never a text field: choosing one opens a
 * field to type in, which a notification cannot. iOS lists only a few
 * actions, so past three it is the first two and the last, because the
 * agents measured here put the plain approval first and the refusal last
 * (Claude Code's Bash, WebFetch and MCP dialogs end in "No"; codex's in its
 * "No, and tell Codex…"). Every other choice is a tap away, in the app.
 */
export function answerableOptions(options: readonly PromptOption[]): PromptOption[] {
  const answerable = options.filter((o) => !o.textInput);
  return answerable.length <= MAX_ACTIONS ? answerable : [...answerable.slice(0, MAX_ACTIONS - 1), answerable.at(-1)!];
}

/**
 * Lines of printable text within `maxBytes`, each cut as `fitText` cuts:
 * the question and the command keep their own lines, as on the card.
 */
export function fitLines(lines: readonly string[], maxBytes: number): string {
  const encoder = new TextEncoder();
  const kept: string[] = [];
  let used = 0;
  for (const line of lines.flatMap((l) => l.split("\n"))) {
    const room = maxBytes - used - (kept.length ? 1 : 0);
    if (room <= 3) break;
    const fitted = fitText(line, room);
    kept.push(fitted);
    used += encoder.encode(fitted).length + (kept.length > 1 ? 1 : 0);
    if (fitted !== line.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")) break;
  }
  return kept.join("\n");
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The sealed content for one notification. The words are what the card
 * shows: the space, the conversation, the question and its context. The
 * answer carries the prompt exactly as parsed, because `/answer` compares
 * it with a fresh read of the screen: a label cut short would never match.
 * So what cannot fit is dropped rather than cut — the question and context
 * first (the prompt's id already names this appearance of it, and the
 * server refuses an id that is not current), then the buttons.
 */
export function sealedContent(input: {
  workspaceLabel: string;
  conversation: string;
  prompt: ParsedPrompt | null;
  instanceId?: string;
}): SealedContent {
  const suffix = " needs you";
  const title = fitText(input.workspaceLabel, MAX_TITLE_BYTES - suffix.length) + suffix;
  const conversation = fitText(input.conversation, MAX_TITLE_BYTES);
  const prompt = input.prompt;
  const base: SealedContent = prompt
    ? { title, subtitle: conversation, body: fitLines([prompt.question, ...shownContext(prompt.context)], MAX_BODY_BYTES) }
    : { title, body: conversation };
  if (input.instanceId) base.instanceId = input.instanceId;
  if (!prompt?.promptId) return base;

  const titles = shownLabels(prompt.options);
  const options = answerableOptions(prompt.options).map((option) => ({
    index: option.index,
    label: option.label,
    title: fitText(titles[prompt.options.indexOf(option)] ?? option.label, MAX_ACTION_TITLE_BYTES),
  }));
  if (options.length === 0) return base;

  const full: SealedContent = {
    ...base,
    answer: { promptId: prompt.promptId, question: prompt.question, ...(prompt.context ? { context: prompt.context } : {}), options },
  };
  if (bytes(full) <= MAX_SEALED_BYTES) return full;
  const bare: SealedContent = { ...base, answer: { promptId: prompt.promptId, options } };
  return bytes(bare) <= MAX_SEALED_BYTES ? bare : base;
}
