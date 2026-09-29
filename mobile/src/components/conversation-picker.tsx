/**
 * Which saved Claude conversation runs in a pane herdr cannot identify.
 *
 * A Claude started before herdr's integration was installed reports no
 * session, so Reader cannot know which transcript is its own
 * (server/lib/claude-choice.ts). The person can: the computer lists the
 * conversations saved for the folder Claude runs in, with the one Claude's
 * process record names marked likely, and nothing is chosen for them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { relativeTime, type ConversationChoice } from "@shahi/shared";
import { Text } from "@/components/text";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

interface Props {
  paneId: string;
  /** Who held the pane when the list was asked for; a choice for another is refused. */
  instanceId?: string;
  onChosen: () => void;
  onClose: () => void;
}

export function ConversationPicker({ paneId, instanceId, onChosen, onClose }: Props) {
  const { api } = useSession();
  const [choices, setChoices] = useState<ConversationChoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const close = useRef(onClose);
  close.current = onClose;
  // A sheet left open over a screen the person navigated away from.
  useFocusEffect(useCallback(() => () => close.current(), []));

  useEffect(() => {
    let live = true;
    api.conversationChoices(paneId).then(
      (found) => { if (live) setChoices(found.choices); },
      (e: unknown) => { if (live) setError(e instanceof Error ? e.message : "The conversations could not be listed."); },
    );
    return () => { live = false; };
  }, [api, paneId]);

  const choose = async (sessionId: string) => {
    setChoosing(true);
    setError(null);
    try {
      await api.chooseConversation(paneId, sessionId, instanceId);
      onChosen();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That conversation could not be chosen.");
      setChoosing(false);
    }
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={styles.sheet}>
        <View style={styles.bar}>
          <Text style={styles.title} accessibilityRole="header">Which conversation is this?</Text>
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={12} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
        <Text style={styles.dim}>
          Claude started here before Shahi could identify it. Choose the conversation it is running, and Reader will show it.
        </Text>
        {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
        {!choices && !error ? (
          <ActivityIndicator color={theme.dim} style={styles.wait} />
        ) : choices?.length === 0 ? (
          <Text style={styles.dim}>No saved Claude conversations were found for this folder.</Text>
        ) : (
          <FlatList
            data={choices ?? []}
            keyExtractor={(choice) => choice.sessionId}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <Pressable accessibilityRole="button" disabled={choosing} onPress={() => void choose(item.sessionId)} style={[styles.item, choosing && styles.itemBusy]}>
                <View style={styles.itemTop}>
                  <Text style={styles.itemTitle}>{item.firstPrompt ?? "Untitled conversation"}</Text>
                  {item.likely && <Text style={styles.likely}>Likely</Text>}
                </View>
                {item.lastMessage && <Text style={styles.dim} numberOfLines={2}>{item.lastMessage}</Text>}
                <Text style={styles.when}>{relativeTime(item.updatedAt)}</Text>
              </Pressable>
            )}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: theme.void, padding: 16, gap: 10 },
  bar: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: { flex: 1, color: theme.fg, fontSize: 17, fontWeight: "600" },
  cancel: { minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "flex-end" },
  cancelText: { color: theme.peach, fontSize: 16 },
  dim: { color: theme.dim, fontSize: 14, lineHeight: 20 },
  error: { color: theme.rose, fontSize: 14 },
  wait: { marginTop: 24 },
  list: { gap: 8, paddingBottom: 32 },
  item: { minHeight: 44, gap: 4, padding: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.line },
  itemBusy: { opacity: 0.6 },
  itemTop: { flexDirection: "row", alignItems: "flex-start", gap: 8, flexWrap: "wrap" },
  itemTitle: { flexShrink: 1, color: theme.fg, fontSize: 15 },
  likely: { color: theme.mint, fontFamily: theme.mono, fontSize: 11 },
  when: { color: theme.dim, fontFamily: theme.mono, fontSize: 11 },
});
