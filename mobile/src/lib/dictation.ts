import { requireOptionalNativeModule } from "expo";

/**
 * Live dictation with Apple's on-device SpeechTranscriber
 * (mobile/modules/dictation). iOS 26 on an iPhone that runs it, or no
 * dictation at all: there is deliberately no second engine. The keyboard's own
 * microphone still works everywhere else.
 */
export type DictationEvent =
  | { id: string; kind: "text"; finalized: string; volatile: string }
  | { id: string; kind: "level"; level: number }
  | { id: string; kind: "download"; fraction: number }
  /** The system ended it (a call, a lost headset, backgrounding, the time limit); `text` is what was said. */
  | { id: string; kind: "stopped"; reason: "interrupted" | "limit"; text: string };

export interface DictationAvailability { available: boolean; installed: boolean }

interface Native {
  availability(): Promise<DictationAvailability>;
  install(id: string): Promise<void>;
  start(id: string): Promise<void>;
  finish(id: string): Promise<string>;
  cancel(id: string): Promise<void>;
  addListener(event: "change", listener: (event: DictationEvent) => void): { remove(): void };
}

// A binary from before the module can run newer JavaScript: it has no
// dictation, and says nothing about it.
const native = () => requireOptionalNativeModule<Native>("ShahiDictation");
function required(): Native {
  const value = native();
  if (!value) throw new Error("Update Shahi to dictate.");
  return value;
}

export const dictation = {
  availability: async (): Promise<DictationAvailability> =>
    (await native()?.availability()) ?? { available: false, installed: false },
  install: async (id: string) => required().install(id),
  start: async (id: string) => required().start(id),
  finish: async (id: string) => required().finish(id),
  cancel: async (id: string) => { await native()?.cancel(id); },
  listen: (listener: (event: DictationEvent) => void) => native()?.addListener("change", listener) ?? { remove() {} },
};

/**
 * Dictated text continues the draft, never replaces it: after the draft's own
 * trailing space or line break (an attached path ends in one), else after a space.
 */
export function appendDictation(draft: string, text: string): string {
  const said = text.trim();
  if (!said) return draft;
  if (!draft.trim()) return said;
  return /\s$/.test(draft) ? draft + said : `${draft} ${said}`;
}
