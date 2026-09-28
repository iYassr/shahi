import { requireOptionalNativeModule } from "expo";

export interface VoiceLocale { id: string; name: string; installed: boolean }
export interface VoiceSupport { available: boolean; locales: VoiceLocale[]; preferred: string; maximumSeconds: number }
export interface VoiceEvent { id: string; kind: "limit" | "interrupted" }
interface VoiceNative {
  support(): Promise<VoiceSupport>;
  prepare(id: string, locale: string, download: boolean): Promise<boolean>;
  progress(id: string): Promise<number>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<string>;
  cancel(id: string): Promise<void>;
  addListener(event: "change", listener: (event: VoiceEvent) => void): { remove(): void };
}

// An older binary can receive compatible JS without having the native module.
// It must offer a useful explanation, never fall back to cloud recognition.
function native() { return requireOptionalNativeModule<VoiceNative>("ShahiVoice"); }
function required() {
  const value = native();
  if (!value) throw new Error("Update Shahi to use on-device voice input.");
  return value;
}
export const voice = {
  support: () => required().support(),
  prepare: (id: string, locale: string, download: boolean) => required().prepare(id, locale, download),
  progress: (id: string) => required().progress(id),
  start: (id: string) => required().start(id),
  stop: (id: string) => required().stop(id),
  cancel: async (id: string) => { await native()?.cancel(id); },
  listen: (listener: (event: VoiceEvent) => void) => native()?.addListener("change", listener) ?? { remove() {} },
};

export function appendDictation(draft: string, transcript: string): string {
  const text = transcript.trim();
  return !text ? draft : !draft ? text : draft + (/\s$/.test(draft) ? "" : "\n") + text;
}
