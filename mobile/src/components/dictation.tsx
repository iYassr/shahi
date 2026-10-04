import { UiText } from "@/components/ui-text";
import { ui, useI18n } from "@/lib/i18n";
/**
 * Dictating a reply: a microphone beside Send, and a live panel above the
 * reply box while it listens.
 *
 * Words appear as they are spoken, tentative ones dimmed until Apple's model
 * settles them (mobile/src/lib/dictation.ts). Tapping the microphone again, or
 * Add, puts what was said into the draft; nothing is ever sent from here.
 * Whatever ends a dictation keeps its words: leaving the conversation, a call,
 * or the time limit adds them to the draft rather than dropping text the
 * person already saw (docs/voice-input.md).
 */
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ActivityIndicator, Linking, Pressable, StyleSheet, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { Icon } from "@/components/icons";
import { Text } from "@/components/text";
import { dictation, type DictationAvailability } from "@/lib/dictation";
import { committed, refused } from "@/lib/feel";
import { theme } from "@/lib/theme";

type Phase = "idle" | "downloading" | "starting" | "listening" | "finishing";

export interface Dictation {
  available: boolean;
  phase: Phase;
  finalized: string;
  volatile: string;
  /** Microphone loudness, 0 to 1, for the meter. */
  level: number;
  seconds: number;
  /** Download progress of Apple's model, 0 to 1. */
  progress: number;
  notice: string | null;
  error: string | null;
  toggle(): void;
  cancel(): void;
  dismiss(): void;
}

const announce = (message: string) => AccessibilityInfo.announceForAccessibility(ui(message));

export function useDictation(insert: (text: string) => void, { active = true, owner }: { active?: boolean; owner?: unknown } = {}): Dictation {
  const insertRef = useRef(insert);
  insertRef.current = insert;
  // Asked afresh for each conversation: iOS can remove an unused model at any time.
  const [availability, setAvailability] = useState<DictationAvailability | null>(null);
  const [phase, setPhaseState] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const setPhase = (value: Phase) => { phaseRef.current = value; setPhaseState(value); };
  const lease = useRef<string | null>(null);
  const insertForLease = useRef(insert);
  const finishing = useRef<{ id: string; result: Promise<string> } | null>(null);
  const [finalized, setFinalizedState] = useState("");
  const finalizedRef = useRef("");
  const setFinalized = (value: string) => { finalizedRef.current = value; setFinalizedState(value); };
  const [volatile, setVolatile] = useState("");
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(0);

  const clear = () => { setFinalized(""); setVolatile(""); setLevel(0); setSeconds(0); };
  const deliver = (text: string) => {
    if (!text.trim()) return;
    insertForLease.current(text);
    announce("Added what you said to your reply.");
  };

  function finishOnce(id: string) {
    if (finishing.current?.id === id) return finishing.current.result;
    const result = dictation.finish(id);
    finishing.current = { id, result };
    return result;
  }
  function stopAndKeep() {
    const id = lease.current;
    lease.current = null;
    if (!id) return;
    const destination = insertForLease.current;
    const said = finalizedRef.current;
    if (phaseRef.current === "listening" || phaseRef.current === "finishing") {
      // Add may already be waiting for the last words. A second native finish
      // loses them; a mutable callback can put them in the next conversation.
      void finishOnce(id).then(text => destination(text || said), () => destination(said));
    } else void dictation.cancel(id).catch(() => {});
  }

  useEffect(() => {
    if (!active) { stopAndKeep(); clear(); setPhase("idle"); }
    return () => { stopAndKeep(); clear(); setPhase("idle"); };
  }, [active, owner]);

  useEffect(() => {
    let live = true;
    dictation.availability().then(
      (value) => { if (live) setAvailability(value); },
      () => { if (live) setAvailability({ available: false, installed: false }); },
    );
    const events = dictation.listen((event) => {
      if (event.id !== lease.current) return;
      if (event.kind === "text") { setFinalized(event.finalized); setVolatile(event.volatile); }
      else if (event.kind === "level") setLevel(event.level);
      else if (event.kind === "download") setProgress(event.fraction);
      else {
        lease.current = null;
        deliver(event.text);
        clear();
        setPhase("idle");
        setNotice(event.reason === "limit"
          ? "Dictation stops after five minutes. What you said is in your reply."
          : "Dictation stopped. What you said is in your reply.");
      }
    });
    return () => {
      live = false;
      events.remove();
      // Leaving the conversation keeps what was said: it lands in this
      // conversation's draft, which outlives the screen.
      stopAndKeep();
    };
  }, []);

  useEffect(() => {
    if (phase !== "listening") return;
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 500);
    return () => clearInterval(timer);
  }, [phase]);

  async function begin() {
    if (!active || !availability?.available || phaseRef.current !== "idle") return;
    const id = randomUUID();
    insertForLease.current = insertRef.current;
    finishing.current = null;
    lease.current = id;
    setError(null); setNotice(null); clear();
    try {
      if (!availability.installed) {
        // Apple's model is fetched once, by iOS, and shared with other apps.
        // Its arrival does not open the microphone: that waits for a tap.
        setProgress(0); setPhase("downloading");
        await dictation.install(id);
        if (lease.current !== id) return;
        setAvailability({ available: true, installed: true });
        lease.current = null;
        setPhase("idle");
        setNotice("Apple's speech model is ready. Tap the microphone to talk.");
        return;
      }
      setPhase("starting");
      await dictation.start(id);
      if (lease.current !== id) { void dictation.cancel(id).catch(() => {}); return; }
      startedAt.current = Date.now();
      setPhase("listening");
      committed();
      announce("Listening.");
    } catch (e) {
      if (lease.current !== id) return;
      lease.current = null;
      setPhase("idle");
      refused();
      const message = e instanceof Error ? e.message : "Dictation could not start.";
      // iOS removed the model since it was checked; the next tap fetches it.
      if (/downloaded again/.test(message)) setAvailability({ available: true, installed: false });
      setError(message);
    }
  }

  async function end() {
    const id = lease.current;
    if (!id || phaseRef.current !== "listening") return;
    setPhase("finishing");
    let text = "";
    try {
      text = await finishOnce(id);
    } catch (e) {
      // The words already settled on screen are kept even if the last ones fail.
      text = finalizedRef.current;
      setError(e instanceof Error ? e.message : "The last words could not be transcribed.");
    }
    if (lease.current !== id) return;
    lease.current = null;
    deliver(text);
    committed();
    clear();
    setPhase("idle");
  }

  function cancel() {
    const id = lease.current;
    lease.current = null;
    if (id && phaseRef.current !== "downloading") void dictation.cancel(id).catch(() => {});
    clear();
    setPhase("idle");
  }

  return {
    available: !!availability?.available,
    phase, finalized, volatile, level, seconds, progress, notice, error,
    toggle: () => { if (phaseRef.current === "idle") void begin(); else if (phaseRef.current === "listening") void end(); },
    cancel,
    dismiss: () => { setNotice(null); setError(null); },
  };
}

export function DictationButton({ voice, disabled }: { voice: Dictation; disabled: boolean }) {
  const { t: ui } = useI18n();
  const listening = voice.phase === "listening";
  const busy = voice.phase === "downloading" || voice.phase === "starting" || voice.phase === "finishing";
  const off = disabled || busy;
  return (
    <Pressable
      style={[styles.mic, listening && styles.micOn, off && styles.off]}
      onPress={voice.toggle}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={listening ? ui("Stop dictating and add to reply") : ui("Dictate")}
      accessibilityState={{ disabled: off, busy }}
    >
      {busy ? <ActivityIndicator color={theme.dim} /> : <Icon name={listening ? "check" : "mic"} size={20} color={listening ? theme.void : theme.fg} />}
    </Pressable>
  );
}

const BARS = 5;

export function DictationPanel({ voice }: { voice: Dictation }) {
  const { t: ui } = useI18n();
  const { phase } = voice;
  if (phase === "idle") {
    const message = voice.error ?? voice.notice;
    if (!message) return null;
    return (
      <View style={styles.panel}>
        <UiText style={voice.error ? styles.error : styles.dim} accessibilityRole={voice.error ? "alert" : undefined}>{message}</UiText>
        <View style={styles.actions}>
          {voice.error?.includes("Settings") && (
            <Pressable style={styles.action} accessibilityRole="button" onPress={() => void Linking.openSettings()}>
              <UiText style={styles.actionText}>Open Settings</UiText>
            </Pressable>
          )}
          <Pressable style={styles.action} accessibilityRole="button" accessibilityLabel={ui("Dismiss")} onPress={voice.dismiss}>
            <UiText style={styles.actionText}>OK</UiText>
          </Pressable>
        </View>
      </View>
    );
  }
  if (phase === "downloading") {
    return (
      <View style={styles.panel}>
        <Text style={styles.dim}>{ui("Downloading Apple's English speech model")}{voice.progress > 0 ? ` · ${Math.round(voice.progress * 100)}%` : "…"}
        </Text>
        <UiText style={styles.small}>Once, for every app on this iPhone. It runs on the phone; nothing you say leaves it.</UiText>
        <View style={styles.actions}>
          <Pressable style={styles.action} accessibilityRole="button" onPress={voice.cancel}><UiText style={styles.actionText}>Cancel</UiText></Pressable>
        </View>
      </View>
    );
  }
  const heard = voice.finalized || voice.volatile;
  return (
    <View style={styles.panel}>
      <View style={styles.status}>
        <View style={styles.meter} accessible accessibilityLabel={ui("Microphone level")} accessibilityValue={{ min: 0, max: 100, now: Math.round(voice.level * 100) }}>
          {Array.from({ length: BARS }, (_, index) => (
            <View key={index} style={[styles.bar, { height: 4 + Math.max(0, voice.level - index * 0.12) * 18 }]} />
          ))}
        </View>
        <Text style={styles.small}>
          {phase === "starting" ? ui("Starting the microphone…") : phase === "finishing" ? ui("Adding…") : ui("Listening · {value1}:{value2}", {value1: Math.floor(voice.seconds / 60), value2: String(voice.seconds % 60).padStart(2, "0")})}
        </Text>
      </View>
      <Text style={styles.heard} selectable>
        {heard ? voice.finalized : ui("Say your reply…")}
        {voice.finalized && voice.volatile ? " " : ""}
        {voice.volatile ? <Text style={styles.tentative}>{voice.volatile}</Text> : null}
      </Text>
      <View style={styles.actions}>
        <Pressable style={styles.action} accessibilityRole="button" accessibilityLabel={ui("Cancel dictation")} onPress={voice.cancel}>
          <UiText style={styles.actionText}>Cancel</UiText>
        </Pressable>
        <Pressable style={[styles.action, styles.add]} accessibilityRole="button" accessibilityLabel={ui("Add to reply")} disabled={phase !== "listening"} onPress={voice.toggle}>
          <UiText style={styles.addText}>Add</UiText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The attach button's shape: both sit inside the reply box's rounded row.
  mic: { width: 44, minHeight: 44, borderRadius: 10, borderCurve: "continuous", alignItems: "center", justifyContent: "center" },
  micOn: { backgroundColor: theme.peach },
  off: { opacity: 0.35 },
  panel: { marginHorizontal: 8, marginBottom: 6, padding: 12, gap: 8, borderRadius: 12, borderCurve: "continuous", backgroundColor: theme.raised, borderWidth: 1, borderColor: theme.line },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  meter: { flexDirection: "row", alignItems: "center", gap: 3, height: 22 },
  bar: { width: 4, borderRadius: 2, backgroundColor: theme.peach },
  heard: { color: theme.fg, fontSize: 16, lineHeight: 22 },
  tentative: { color: theme.dim },
  dim: { color: theme.dim, fontSize: 14, lineHeight: 20 },
  small: { color: theme.dim, fontSize: 12 },
  error: { color: theme.rose, fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
  action: { minHeight: 44, minWidth: 44, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", borderRadius: 8, borderCurve: "continuous" },
  actionText: { color: theme.peach, fontSize: 15 },
  add: { backgroundColor: theme.peach },
  addText: { color: theme.void, fontSize: 15, fontWeight: "600" },
});
