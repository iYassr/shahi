/**
 * The composer's two shortcuts: the slash-command picker and the quick-reply
 * chips. Both only put text where the person's own typing goes — the picker
 * into the composer, a chip through the same send as the Send button — so
 * everything the send path guarantees (operation ids, receipts, refusals
 * while a menu is open) holds for them unchanged. The web client's
 * `ComposerShortcuts` is the same pair.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { builtinCommands, matchCommands, QUICK_REPLIES, type PaneCommands, type SlashCommand } from "@shahi/shared";
import { Text } from "@/components/text";
import { UnauthorizedError } from "@/lib/api";
import { theme } from "@/lib/theme";

/** The picker takes at most this share of the window, so the conversation keeps some of it. */
const PICKER_SHARE = 0.3;

/**
 * The commands to offer: the agent's built-ins at once, and the computer's
 * list — which adds the person's own — once it answers. Asked each time the
 * picker opens, so a command written on the computer a minute ago is there;
 * a computer without the `commands` capability is not asked at all. A failure
 * leaves the built-ins: this is a convenience, and the person can still type.
 */
export function usePaneCommands(
  api: { paneCommands: (paneId: string) => Promise<PaneCommands> },
  paneId: string,
  agent: string | null | undefined,
  { capable, open, onUnauthorized }: { capable: boolean; open: boolean; onUnauthorized: () => void },
): SlashCommand[] {
  const builtins = useMemo(() => builtinCommands(agent), [agent]);
  const key = `${paneId}\n${agent ?? ""}`;
  const [fetched, setFetched] = useState<{ key: string; commands: SlashCommand[] } | null>(null);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  useEffect(() => {
    if (!capable || !open || !agent) return;
    let live = true;
    api.paneCommands(paneId).then(
      ({ commands }) => {
        if (!live || !Array.isArray(commands)) return;
        setFetched({ key, commands: commands.filter((c) => typeof c?.name === "string" && typeof c.description === "string") });
      },
      (e: unknown) => { if (live && e instanceof UnauthorizedError) unauthorized.current(); },
    );
    return () => { live = false; };
  }, [api, paneId, agent, capable, open, key]);
  return fetched?.key === key ? fetched.commands : builtins;
}

const SOURCE_LABEL = { user: "personal", project: "project" } as const;

/**
 * The commands matching what follows the `/`, nearest the composer. Choosing
 * one puts `/name ` in the composer — with the space, since many take
 * arguments — and sends nothing. Nothing matching shows nothing: a draft
 * that is a path, `/Users/…`, is not a command being looked for.
 */
export function CommandPicker({ commands, query, onPick }: { commands: SlashCommand[]; query: string; onPick: (command: SlashCommand) => void }) {
  const { height } = useWindowDimensions();
  const matches = matchCommands(commands, query);
  if (matches.length === 0) return null;
  return (
    <ScrollView
      testID="command-picker"
      accessibilityLabel="Commands"
      style={[styles.picker, { maxHeight: Math.round(height * PICKER_SHARE) }]}
      // A tap on a command lands on the first touch while the keyboard is up.
      keyboardShouldPersistTaps="handled"
    >
      {matches.map((command) => (
        <Pressable
          key={command.name}
          accessibilityRole="button"
          accessibilityLabel={[`/${command.name}`, command.source !== "builtin" && SOURCE_LABEL[command.source], command.description].filter(Boolean).join(", ")}
          accessibilityHint="Puts the command in your reply"
          style={({ pressed }) => [styles.command, pressed && styles.pressed]}
          onPress={() => onPick(command)}
        >
          <View style={styles.commandHead}>
            <Text style={styles.commandName}>/{command.name}</Text>
            {command.source !== "builtin" && <Text style={styles.source}>{SOURCE_LABEL[command.source]}</Text>}
          </View>
          {!!command.description && <Text style={styles.commandDescription} numberOfLines={2}>{command.description}</Text>}
        </Pressable>
      ))}
    </ScrollView>
  );
}

/**
 * One row: `/` to open the picker, then the quick replies. One row that
 * scrolls sideways, at every text size: wrapped, four replies at the largest
 * size took the height of the conversation. It sits above the reply box,
 * whose place on screen does not change when the row comes and goes.
 */
export function ReplyChips({ slash, replies, onSlash, onReply }: {
  slash: boolean;
  replies: boolean;
  onSlash: () => void;
  onReply: (text: string) => void;
}) {
  if (!slash && !replies) return null;
  return (
    <ScrollView horizontal testID="reply-chips" showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.chips}>
      {slash && (
        <Pressable accessibilityRole="button" accessibilityLabel="Commands" accessibilityHint="Starts a slash command" style={({ pressed }) => [styles.chip, pressed && styles.pressed]} onPress={onSlash}>
          <Text style={[styles.chipText, styles.slash]}>/</Text>
        </Pressable>
      )}
      {replies && QUICK_REPLIES.map((reply) => (
        <Pressable key={reply} accessibilityRole="button" accessibilityLabel={reply} accessibilityHint="Sends this reply now" style={({ pressed }) => [styles.chip, pressed && styles.pressed]} onPress={() => onReply(reply)}>
          <Text style={styles.chipText}>{reply}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  picker: { flexGrow: 0, borderWidth: 1, borderColor: theme.lineBright, borderRadius: 12, borderCurve: "continuous", backgroundColor: theme.surface },
  command: { minHeight: 44, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.line },
  pressed: { backgroundColor: theme.raised },
  commandHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", columnGap: 8 },
  commandName: { color: theme.peach, fontFamily: theme.mono, fontSize: 14 },
  source: { color: theme.dim, fontSize: 12 },
  commandDescription: { color: theme.dim, fontSize: 12, lineHeight: 17, marginTop: 2 },
  chips: { gap: 8, alignItems: "center" },
  chip: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 999,
  },
  chipText: { color: theme.fg, fontSize: 14 },
  slash: { color: theme.peach, fontFamily: theme.mono, fontSize: 16 },
});
