import { UiText } from "@/components/ui-text";
import { useI18n } from "@/lib/i18n";
/**
 * Long-press to copy, for text that lives in a horizontal scroller.
 *
 * Range selection needs a drag, and inside a ScrollView the drag is already
 * taken — panning wins and the selection handles never appear. So the
 * monospace regions (fenced code, tool output, the terminal screen) copy
 * whole on a long press, with the platform's tick and a moment of "Copied"
 * to say what happened. Prose stays `selectable` instead: there the drag is
 * free, and copying *specific* text is the point.
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "@/components/text";
import * as Clipboard from "expo-clipboard";
import { committed } from "@/lib/feel";
import { Icon } from "@/components/icons";
import { theme } from "@/lib/theme";

/**
 * The hold goes to the text, inside the scroll views, as `children(hold)`.
 * It was a Pressable around them, and a touchable around a ScrollView takes
 * the touch before the ScrollView's pan can start: neither the terminal nor
 * a code block scrolled at all, either way (simulator, 20 October 2026;
 * XCUITest had seen the terminal stay put in September and could not say
 * why). A touchable inside a scroll view yields to its pan, as list rows do.
 */
export function CopyOnHold({ text, style, children }: { text: string; style?: StyleProp<ViewStyle>; children: (hold: () => void) => React.ReactNode }) {
  const { t: ui } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hold = () => {
    void Clipboard.setStringAsync(text);
    committed();
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };
  return (
    <View
      // A region that must fit a bounded space (the terminal) says so here:
      // unstyled, the region takes its content's full height whatever its
      // parent has room for.
      style={style}
      accessible
      accessibilityRole="button"
      // The text itself. Left to build a label from its children, iOS added
      // the scroll views' indicators, so the terminal read "…, Vertical
      // scroll bar, 1 page" (pre-release bug hunt).
      accessibilityLabel={text}
      accessibilityHint={ui("Long press to copy")}
      accessibilityActions={[{ name: "longpress" }]}
      onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === "longpress") hold(); }}
    >
      {children(hold)}
      {copied && (
        <View style={styles.copied} pointerEvents="none">
          <UiText style={styles.copiedText}>Copied</UiText>
        </View>
      )}
    </View>
  );
}

/** A visible action for prose; long-press remains available for terminal regions. */
export function CopyButton({ text }: { text: string }) {
  const { t: ui } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? ui("Copied") : ui("Copy message")}
      style={({ pressed }) => [styles.copyButton, pressed && { opacity: 0.65 }]}
      onPress={async () => {
        try {
          await Clipboard.setStringAsync(text);
          committed();
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1400);
        } catch { /* Keep the copy action available if the clipboard refused it. */ }
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={17} color={copied ? theme.mint : theme.dim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  copyButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", alignSelf: "flex-end", borderRadius: 12, borderCurve: "continuous" },
  copied: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: theme.raised,
    borderRadius: 6, borderCurve: "continuous",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  copiedText: { color: theme.mint, fontFamily: theme.mono, fontSize: 11 },
});
