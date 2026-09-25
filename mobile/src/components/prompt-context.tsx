/**
 * What the agent put above its question — the tool and the command it wants to
 * run, a codex approval's reason, an `AskUserQuestion` header. Without it an
 * approval reads as a bare "Do you want to proceed?" with nothing to judge.
 *
 * One component for every card that shows a prompt. The context was ported to
 * the Agents card alone, and the pane's own card went on showing the bare
 * question to anyone who opened an approval from a notification or a row
 * (pre-release bug hunt); a copy per screen is how that happened.
 */
import { StyleSheet, View } from "react-native";
import { Text } from "@/components/text";
import { theme } from "@/lib/theme";

export function PromptContext({ context }: { context: string[] | undefined }) {
  if (!context?.length) return null;
  return (
    <View style={styles.context} testID="prompt-context">
      {context.map((line, i) => (
        <Text style={styles.line} key={i}>
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  context: { borderLeftWidth: 1, borderLeftColor: theme.line, paddingLeft: 10, marginBottom: 12, gap: 4 },
  line: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, lineHeight: 17 },
});
