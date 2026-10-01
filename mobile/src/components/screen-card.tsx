/**
 * The bottom of the terminal, as it is, with the keys that answer menus: for
 * an agent waiting on something no parser recognised (`PaneFrame.unrecognised`),
 * and for a new agent whose startup screens come before any conversation. The
 * rows are not re-labelled or re-wrapped, since Shahi cannot tell what they
 * mean; see `shared/src/screen-card.ts`. The web client's `ScreenCard` is the
 * same card.
 */
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { SCREEN_CARD_KEYS, screenTail } from "@shahi/shared";
import { Text } from "@/components/text";
import { theme } from "@/lib/theme";

const FONT = 11;
/** Menlo's advance is 0.6 of its size; a little over keeps the last column whole. */
const ADVANCE = 0.62;

export function ScreenCard({ text, waiting, disabled, onKeys, onOpenScreen }: {
  text: string;
  waiting: boolean;
  disabled: boolean;
  onKeys: (keys: string[]) => void;
  onOpenScreen: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const rows = screenTail(text);
  if (rows.length === 0) return null;
  const heading = waiting ? "Waiting on something Shahi cannot read" : "On the computer's screen";
  // Given a width, or the rows wrap to the card and a menu's columns stop
  // lining up; the horizontal scroll is what reaches the rest.
  const longest = rows.reduce((most, row) => Math.max(most, row.length), 0);
  return (
    <View testID="screen-card" style={styles.card}>
      <Text style={styles.heading}>{heading}</Text>
      {waiting && <Text style={styles.hint}>Messages are not sent until it is answered.</Text>}
      <ScrollView horizontal style={styles.screen} contentContainerStyle={styles.screenBody}>
        <Text selectable accessibilityLabel={rows.join("\n")} style={[styles.rows, { width: Math.ceil(longest * FONT * ADVANCE * fontScale) + 4 }]}>
          {rows.join("\n")}
        </Text>
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.keys}>
        {SCREEN_CARD_KEYS.map(({ label, keys, name }) => (
          <Pressable
            key={label}
            accessibilityRole="button"
            accessibilityLabel={name}
            accessibilityState={{ disabled }}
            disabled={disabled}
            style={styles.key}
            onPress={() => onKeys(keys)}
          >
            <Text style={styles.keyText}>{label}</Text>
          </Pressable>
        ))}
        <Pressable accessibilityRole="button" style={styles.key} onPress={onOpenScreen}>
          <Text style={[styles.keyText, { color: theme.peach }]}>Open Screen</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    margin: 16,
    padding: 14,
    gap: 8,
    borderWidth: 1,
    borderColor: theme.peach,
    borderRadius: 10, borderCurve: "continuous",
    backgroundColor: theme.surface,
  },
  heading: { color: theme.fg, fontSize: 15, lineHeight: 21 },
  hint: { color: theme.dim, fontSize: 13 },
  // No height cap of its own: the notices area it sits in scrolls (see `Pane`).
  screen: { borderRadius: 8, borderCurve: "continuous", backgroundColor: theme.void },
  screenBody: { padding: 8 },
  rows: { color: theme.fg, fontFamily: theme.mono, fontSize: FONT, lineHeight: 16 },
  keys: { gap: 6 },
  key: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 7, borderCurve: "continuous",
  },
  keyText: { color: theme.dim, fontSize: 12 },
});
