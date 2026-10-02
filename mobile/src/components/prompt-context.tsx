/**
 * What the agent put above its question — the tool and the command it wants to
 * run, a codex approval's reason, an `AskUserQuestion` header. Without it an
 * approval reads as a bare "Do you want to proceed?" with nothing to judge.
 *
 * One component for every card that shows a prompt. The context was ported to
 * the Agents card alone, and the pane's own card went on showing the bare
 * question to anyone who opened an approval from a notification or a row
 * (pre-release bug hunt); a copy per screen is how that happened.
 *
 * Bounded, and scrolled both ways inside its own box. An edit approval carries
 * its whole diff, and unbounded it filled the card and pushed "1. Yes … 3. No"
 * out of sight; wrapped to the phone, a rule became three lines of dashes and
 * a line of code broke after its comma (first-task test of build 32, October
 * 2026). The lines stay as the terminal drew them, rules aside: see
 * `shownContext`. The web client's `.asked__context` is the same box.
 */
import { ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { shownContext } from "@shahi/shared";
import { Text } from "@/components/text";
import { monoWidth, theme } from "@/lib/theme";

const FONT = 12;
const LINE = 17;
/**
 * About eight lines at the default size — a short diff or a command whole —
 * and fixed, not grown with the text: at the largest sizes the question and
 * its answers need the room more than the ninth line of a diff does.
 */
const MAX_HEIGHT = 8 * LINE + 16;

export function PromptContext({ context }: { context: string[] | undefined }) {
  const { fontScale } = useWindowDimensions();
  const entries = shownContext(context);
  if (entries.length === 0) return null;
  const longest = Math.max(...entries.flatMap((entry) => entry.split("\n").map((line) => line.length)));
  const width = monoWidth(longest, FONT, fontScale);
  return (
    <ScrollView testID="prompt-context" style={styles.box} nestedScrollEnabled keyboardShouldPersistTaps="handled">
      <ScrollView horizontal nestedScrollEnabled contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.entries}>
          {entries.map((entry, i) => (
            <Text style={[styles.line, { width }]} key={i}>
              {entry}
            </Text>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  box: { flexGrow: 0, maxHeight: MAX_HEIGHT, marginBottom: 12, borderRadius: 8, borderCurve: "continuous", backgroundColor: theme.void },
  body: { padding: 8 },
  entries: { gap: 4 },
  line: { color: theme.dim, fontFamily: theme.mono, fontSize: FONT, lineHeight: LINE },
});
