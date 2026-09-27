import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Alert, Linking, StyleSheet, type GestureResponderEvent, type StyleProp, type TextStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import { isWebUrl } from "@shahi/shared";
import { Text } from "@/components/text";
import { committed } from "@/lib/feel";
import { theme } from "@/lib/theme";

/** Inline Text preserves surrounding prose selection and its line layout. */
export function ExternalLink({ url, children, style }: { url: string; children?: ReactNode; style?: StyleProp<TextStyle> }) {
  const [copied, setCopied] = useState(false);
  const held = useRef(false);
  const mounted = useRef(true);
  const currentUrl = useRef(url);
  currentUrl.current = url;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    held.current = false;
    setCopied(false);
    if (timer.current) clearTimeout(timer.current);
  }, [url]);
  const valid = isWebUrl(url);
  const label = children ?? url;
  const open = async () => {
    if (!valid) return;
    try { await Linking.openURL(url); }
    catch { if (mounted.current && currentUrl.current === url) Alert.alert("Couldn’t open link", "Try again, or long press the link to copy its address."); }
  };
  const copy = async () => {
    if (!valid) return;
    try {
      if (!await Clipboard.setStringAsync(url)) throw new Error("Clipboard unavailable");
      if (!mounted.current || currentUrl.current !== url) return;
      committed();
      setCopied(true);
      AccessibilityInfo.announceForAccessibility("Link copied");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch { if (mounted.current && currentUrl.current === url) Alert.alert("Couldn’t copy link", "The clipboard is unavailable. Try again."); }
  };
  if (!valid) return <Text style={style}>{label}</Text>;
  const stop = (event?: GestureResponderEvent) => event?.stopPropagation();
  return <Text
    style={[styles.link, style]}
    accessibilityRole="link"
    accessibilityLabel={typeof label === "string" ? label : url}
    accessibilityHint="Tap to open. Long press or use Copy link to copy the address."
    accessibilityActions={[{ name: "activate", label: "Open link" }, { name: "copy", label: "Copy link" }]}
    onAccessibilityAction={event => {
      event.stopPropagation();
      if (event.nativeEvent.actionName === "copy") void copy();
      else if (event.nativeEvent.actionName === "activate") void open();
    }}
    onPressIn={() => { held.current = false; }}
    onLongPress={event => { stop(event); held.current = true; void copy(); }}
    onPress={event => { stop(event); if (!held.current) void open(); held.current = false; }}
  >{label}{copied && <Text style={styles.copied} accessibilityElementsHidden importantForAccessibility="no"> · Copied</Text>}</Text>;
}

const styles = StyleSheet.create({
  link: { color: theme.peach, textDecorationLine: "underline" },
  copied: { color: theme.mint, fontSize: 12, textDecorationLine: "none" },
});
