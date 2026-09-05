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
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { committed } from "@/lib/feel";
import { Icon } from "@/components/icons";
import { theme } from "@/lib/theme";

export function CopyOnHold({ text, children }: { text: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Long press to copy"
      onLongPress={() => {
        void Clipboard.setStringAsync(text);
        committed();
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      }}
    >
      {children}
      {copied && (
        <View style={styles.copied} pointerEvents="none">
          <Text style={styles.copiedText}>Copied</Text>
        </View>
      )}
    </Pressable>
  );
}

/** A visible action for prose; long-press remains available for terminal regions. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : "Copy message"}
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
