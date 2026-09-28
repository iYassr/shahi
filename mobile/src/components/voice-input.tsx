import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { randomUUID } from "expo-crypto";
import { Text } from "@/components/text";
import { voice, type VoiceLocale, type VoiceSupport } from "@/lib/voice";
import { theme } from "@/lib/theme";

type Phase = "loading" | "ready" | "preparing" | "starting" | "recording" | "transcribing" | "review";

export function VoiceInput({ onClose, onUse }: { onClose(): void; onUse(text: string): void }) {
  const [support, setSupport] = useState<VoiceSupport | null>(null);
  const [locale, setLocale] = useState<VoiceLocale | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [phase, setPhaseState] = useState<Phase>("loading");
  const phaseRef = useRef<Phase>("loading");
  const setPhase = (value: Phase) => { phaseRef.current = value; setPhaseState(value); };
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState(0);
  const mounted = useRef(true);
  const lease = useRef<string | null>(null);
  const closed = useRef(false);
  const startedAt = useRef(0);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const cancel = useCallback(() => {
    const id = lease.current; lease.current = null;
    if (id) void voice.cancel(id).catch(() => {});
  }, []);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true; cancel(); onCloseRef.current();
  }, [cancel]);
  useFocusEffect(useCallback(() => { closed.current = false; return () => close(); }, [close]));

  const finish = useCallback(async () => {
    const id = lease.current;
    if (!id || phaseRef.current !== "recording") return;
    setPhase("transcribing");
    try {
      const result = await voice.stop(id);
      if (!mounted.current || lease.current !== id) return;
      lease.current = null; setText(result); setPhase("review");
    } catch (e) {
      if (!mounted.current || lease.current !== id) return;
      cancel(); setError(e instanceof Error ? e.message : "The recording could not be transcribed."); setPhase("ready");
    }
  }, [cancel]);

  useEffect(() => {
    mounted.current = true;
    Promise.resolve().then(() => voice.support()).then(value => {
      if (!mounted.current || closed.current) return;
      setSupport(value); setLocale(value.locales.find(l => l.id === value.preferred) ?? null); setPhase("ready");
      if (!value.available) setError("On-device voice input requires iOS 26 or later and a supported language on this iPhone.");
    }, e => { if (mounted.current && !closed.current) { setError(e instanceof Error ? e.message : "Voice input is unavailable."); setPhase("ready"); } });
    const events = voice.listen(event => {
      if (!mounted.current || event.id !== lease.current) return;
      if (event.kind === "limit") void finish();
      else { cancel(); setError("Recording was interrupted. Please start again."); setPhase("ready"); }
    });
    const app = AppState.addEventListener("change", state => { if (state === "background") close(); });
    return () => { mounted.current = false; cancel(); events.remove(); app.remove(); };
  }, [cancel, close, finish]);

  useEffect(() => {
    if (phase !== "recording" && phase !== "preparing" && phase !== "transcribing") return;
    const began = Date.now();
    const timer = setInterval(() => {
      const id = lease.current;
      if (!id) return;
      if (phase === "recording") {
        const elapsed = Math.floor((Date.now() - startedAt.current) / 1000); setSeconds(elapsed);
        if (elapsed >= (support?.maximumSeconds ?? 300)) void finish();
      } else if (phase === "preparing") {
        void voice.progress(id).then(value => { if (mounted.current && lease.current === id) setProgress(value); }, () => {});
      } else if (Date.now() - began > 120_000) {
        cancel(); setError("Transcription took too long. Please try a shorter recording."); setPhase("ready");
      }
    }, 500);
    return () => clearInterval(timer);
  }, [phase, support, finish, cancel]);

  async function record() {
    if (closed.current || !locale || !support?.available || lease.current || phaseRef.current !== "ready") return;
    const id = randomUUID(); lease.current = id;
    setError(""); setProgress(0); setSeconds(0); setPhase("preparing");
    try {
      const ready = await voice.prepare(id, locale.id, !locale.installed);
      if (!mounted.current || lease.current !== id) { void voice.cancel(id).catch(() => {}); return; }
      // Download completion requires a separate Record tap. A model evicted
      // by iOS also returns here, to request permission before downloading.
      if (!ready || !locale.installed) {
        const updated = { ...locale, installed: ready };
        cancel(); setLocale(updated);
        setSupport(value => value && ({ ...value, locales: value.locales.map(item => item.id === updated.id ? updated : item) }));
        setPhase("ready"); return;
      }
      setPhase("starting"); await voice.start(id);
      if (!mounted.current || lease.current !== id) { void voice.cancel(id).catch(() => {}); return; }
      startedAt.current = Date.now(); setPhase("recording");
    } catch (e) {
      if (!mounted.current || lease.current !== id) return;
      cancel(); setError(e instanceof Error ? e.message : "Voice input could not start."); setPhase("ready");
    }
  }

  const busy = phase === "preparing" || phase === "starting" || phase === "transcribing";
  return <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <View style={styles.screen} accessibilityViewIsModal>
      <View style={styles.header}><Text accessibilityRole="header" style={styles.title}>Voice input</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel voice input" onPress={close} style={styles.button}><Text style={styles.action}>Cancel</Text></Pressable></View>
      <ScrollView automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <Text style={styles.description}>Audio is transcribed on this iPhone and deleted afterward. Review the text before adding it to your reply.</Text>
        {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {error.includes("Microphone access") && <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} style={styles.button}><Text style={styles.action}>Open Settings</Text></Pressable>}
        {phase === "loading" && <ActivityIndicator accessibilityLabel="Checking available languages" />}
        {support?.available && phase !== "review" && <>
          <Pressable accessibilityRole="button" accessibilityLabel="Choose transcription language" disabled={phase !== "ready"} onPress={() => setChoosing(v => !v)} style={styles.language}>
            <Text style={styles.action}>{locale?.name ?? "Choose a language"} ▾</Text>
          </Pressable>
          {choosing && phase === "ready" && support.locales.map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: item.id === locale?.id }} style={styles.button}
            onPress={() => { setLocale(item); setChoosing(false); setError(""); }}><Text style={styles.description}>{item.name}{item.installed ? "" : " · download needed"}</Text></Pressable>)}
          {locale && !locale.installed && phase === "ready" && <Text style={styles.description}>Download Apple’s language model once to transcribe offline. The system manages its storage. Recording starts only when you tap Record.</Text>}
          {phase === "recording" && <Text accessibilityLiveRegion="polite" style={styles.title}>Recording · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</Text>}
          {busy && <View style={styles.status}><ActivityIndicator /><Text style={styles.description}>{phase === "transcribing" ? "Transcribing on this iPhone…" : phase === "starting" ? "Opening microphone…" : `Preparing language${progress > 0 ? ` · ${Math.round(progress * 100)}%` : "…"}`}</Text></View>}
          <Pressable accessibilityRole="button" disabled={phase !== "recording" && (phase !== "ready" || !locale)} style={[styles.primary, busy && styles.disabled]}
            onPress={() => phase === "recording" ? void finish() : void record()}>
            <Text style={styles.primaryText}>{phase === "recording" ? "Stop and transcribe" : locale && !locale.installed ? "Download language" : "Record"}</Text>
          </Pressable>
          <Text style={styles.description}>Up to 5 minutes per recording. Speak in the selected language; technical names may need correction.</Text>
        </>}
        {phase === "review" && <>
          <TextInput accessibilityLabel="Edit voice transcript" multiline value={text} onChangeText={setText} style={styles.transcript} />
          <Pressable accessibilityRole="button" disabled={!text.trim()} style={[styles.primary, !text.trim() && styles.disabled]} onPress={() => { if (closed.current || !text.trim()) return; close(); onUse(text.trim()); }}><Text style={styles.primaryText}>Add to reply</Text></Pressable>
          <Text style={styles.description}>Your existing draft is kept. Tap Send in the conversation when you’re ready.</Text>
          <Pressable accessibilityRole="button" style={styles.button} onPress={() => { setText(""); setPhase("ready"); }}><Text style={styles.action}>Record again</Text></Pressable>
        </>}
      </ScrollView>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 20, gap: 12 },
  title: { color: theme.fg, fontSize: 20, fontWeight: "600", flexShrink: 1 },
  content: { padding: 20, paddingBottom: 48, gap: 20 },
  description: { color: theme.dim, fontSize: 15, lineHeight: 23 },
  action: { color: theme.peach, fontSize: 16 },
  error: { color: theme.rose, fontSize: 15, lineHeight: 23 },
  button: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  language: { minHeight: 48, justifyContent: "center", padding: 12, borderWidth: 1, borderColor: theme.line, borderRadius: 10 },
  primary: { minHeight: 52, justifyContent: "center", alignItems: "center", padding: 12, backgroundColor: theme.peach, borderRadius: 10 },
  primaryText: { color: theme.void, fontSize: 16, fontWeight: "600" },
  disabled: { opacity: 0.4 },
  status: { flexDirection: "row", gap: 12, alignItems: "center" },
  transcript: { minHeight: 180, padding: 14, color: theme.fg, backgroundColor: theme.surface, borderRadius: 10, fontSize: 17, textAlignVertical: "top" },
});
