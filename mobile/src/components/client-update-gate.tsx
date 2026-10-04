import { UiText } from "@/components/ui-text";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AppState, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { ClientUpdateCheck, IOS_APP_URL, UPDATE_CHECK_MS, type UpdateRule } from "@shahi/shared/client-update";
import { Text } from "@/components/text";
import { theme } from "@/lib/theme";

const CACHE = "shahi.client-update.v1";
const STORE = { keychainService: "app.shahi.client-update", keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const UpdateRequired = createContext(false);
export const useClientUpdateRequired = () => useContext(UpdateRequired);

/** Above connection recovery and error screens: a broken backend still updates. */
export function ClientUpdateGate({ children }: { children: ReactNode }) {
  const [rule, setRule] = useState<UpdateRule | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("");
  const checker = useRef<ClientUpdateCheck | null>(null);
  useEffect(() => {
    if (Platform.OS !== "ios" || __DEV__) return;
    let live = true;
    const check = new ClientUpdateCheck({ platform: "ios", build: Number(Constants.nativeBuildVersion),
      load: () => SecureStore.getItemAsync(CACHE, STORE), save: text => SecureStore.setItemAsync(CACHE, text, STORE),
      changed: value => { if (live) setRule(value); },
    });
    checker.current = check;
    void check.restore().then(() => { if (live) void check.check(); });
    const timer = setInterval(() => { if (AppState.currentState === "active") void check.check(); }, UPDATE_CHECK_MS);
    const listener = AppState.addEventListener("change", state => { if (state === "active") void check.check(); });
    return () => { live = false; checker.current = null; clearInterval(timer); listener.remove(); };
  }, []);
  async function retry() {
    setChecking(true); setNotice("");
    const ok = await checker.current?.check(true);
    setChecking(false);
    setNotice(ok ? "The update is still required. Install it, then reopen Shahi." : "Could not check right now. Check your connection and try again.");
  }
  async function open(url: string) {
    try { await Linking.openURL(url); }
    catch { setNotice("Open the App Store or TestFlight and update Shahi."); }
  }
  return <>
    {/* Keep drafts and pending-send identities in memory while the notice is up. */}
    <UpdateRequired.Provider value={!!rule}>{children}</UpdateRequired.Provider>
    <Modal visible={!!rule} animationType="fade" presentationStyle="fullScreen" onRequestClose={() => {}}>
      <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <ScrollView contentContainerStyle={styles.screen}>
        <UiText style={styles.title} accessibilityRole="header">Update Shahi</UiText>
        <Text style={styles.detail}>{rule?.message}</Text>
        <UiText style={styles.detail}>Install the latest Shahi to continue. Your saved computers stay connected.</UiText>
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => void open(IOS_APP_URL)}><UiText style={styles.buttonText}>Open App Store</UiText></Pressable>
        <Pressable accessibilityRole="button" style={styles.secondary} onPress={() => void open("itms-beta://")}><UiText style={styles.action}>Open TestFlight</UiText></Pressable>
        <Pressable accessibilityRole="button" style={styles.secondary} disabled={checking} onPress={() => void retry()}><UiText style={styles.action}>{checking ? "Checking…" : "Check again"}</UiText></Pressable>
        {!!notice && <UiText style={styles.detail} accessibilityLiveRegion="polite">{notice}</UiText>}
      </ScrollView>
      </SafeAreaView>
    </Modal>
  </>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.void },
  screen: { flexGrow: 1, padding: 32, alignItems: "center", justifyContent: "center", gap: 14 },
  title: { color: theme.fg, fontSize: 25, fontWeight: "600" },
  detail: { color: theme.dim, fontSize: 16, lineHeight: 23, textAlign: "center" },
  button: { minHeight: 48, paddingHorizontal: 24, justifyContent: "center", borderRadius: 10, backgroundColor: theme.peach },
  buttonText: { color: theme.void, fontSize: 16, fontWeight: "600" },
  secondary: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12 }, action: { color: theme.peach, fontSize: 16 },
});
