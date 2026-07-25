/**
 * The Agents screen: which agent needs you, and what it is asking.
 *
 * Deliberately the same information architecture as the web client — blocked
 * agents pinned above everything, everything else collapsed to one line —
 * because that decision was the point of the product, not an artefact of the
 * platform. What differs is only how it is drawn.
 */
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { DashboardPane, ParsedPrompt } from "@herdrui/shared";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";
import { AGENT_COLORS, GLYPH, theme } from "@/lib/theme";

export function Agents({ onOpenPane }: { onOpenPane: (paneId: string) => void }) {
  const { session, prompts, link, error, clearPrompt } = useSession();
  const [failure, setFailure] = useState<string | null>(null);

  async function answer(paneId: string, index: number) {
    try {
      await api.answerPrompt(paneId, index);
      clearPrompt(paneId);
    } catch (e) {
      setFailure((e as Error).message);
    }
  }

  if (error ?? failure) return <Centered>{error ?? failure}</Centered>;
  if (!session) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={theme.peach} />
        <Text style={styles.dim}>Connecting to herdr…</Text>
      </View>
    );
  }

  const agents = session.panes.filter((p) => p.isAgent);
  const blocked = agents.filter((p) => p.status === "blocked");
  const rest = agents.filter((p) => p.status !== "blocked");

  return (
    <View style={styles.screen}>
      <View style={styles.topbar}>
        <Text style={styles.title}>Agents</Text>
        <View style={{ flex: 1 }} />
        {blocked.length > 0 && (
          <Text style={[styles.link, { color: theme.peach }]}>{blocked.length} WAITING</Text>
        )}
        <Text style={[styles.link, { color: link === "live" ? theme.mint : theme.dim }]}>
          {link === "live" ? "LIVE" : link === "lost" ? "OFFLINE" : "…"}
        </Text>
      </View>

      <FlatList
        data={rest}
        keyExtractor={(p) => p.paneId}
        ListHeaderComponent={
          <>
            {blocked.map((pane) => (
              <BlockedCard
                key={pane.paneId}
                pane={pane}
                prompt={prompts[pane.paneId]}
                onAnswer={(i) => void answer(pane.paneId, i)}
                onOpen={() => onOpenPane(pane.paneId)}
              />
            ))}
            {rest.length > 0 && (
              <Text style={styles.groupLabel}>
                {blocked.length > 0 ? "EVERYTHING ELSE" : `${rest.length} AGENTS`}
              </Text>
            )}
          </>
        }
        renderItem={({ item }) => (
          <Row pane={item} onPress={() => onOpenPane(item.paneId)} />
        )}
        ListEmptyComponent={blocked.length ? null : <Centered>No agents running.</Centered>}
      />
    </View>
  );
}

function Row({ pane, onPress }: { pane: DashboardPane; onPress: () => void }) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Text style={[styles.glyph, { color: statusColor(pane.status) }]}>
        {GLYPH[pane.status] ?? "·"}
      </Text>
      <Text style={[styles.mark, { color: AGENT_COLORS[pane.agent ?? ""] ?? theme.dim }]}>✳</Text>
      <Text style={styles.rowTitle} numberOfLines={1}>
        {pane.title ?? pane.paneId}
      </Text>
      <Text style={styles.rowMeta} numberOfLines={1}>
        {pane.workspaceLabel}
      </Text>
    </Pressable>
  );
}

/**
 * The answer list, rebuilt from the terminal's own — same numbering, same
 * cursor, sized for a thumb.
 */
function BlockedCard({
  pane,
  prompt,
  onAnswer,
  onOpen,
}: {
  pane: DashboardPane;
  prompt: ParsedPrompt | undefined;
  onAnswer: (index: number) => void;
  onOpen: () => void;
}) {
  const [armed, setArmed] = useState<number | null>(null);

  return (
    <View style={styles.blocked}>
      <Pressable onPress={onOpen}>
        <Text style={styles.badge}>● WAITING ON YOU</Text>
        <Text style={styles.where}>{pane.workspaceLabel}</Text>
        <Text style={styles.task} numberOfLines={1}>
          {pane.agent ?? "agent"} · {pane.paneId} · {pane.title ?? "untitled"}
        </Text>
      </Pressable>

      {prompt ? (
        <>
          <Text style={styles.question}>{prompt.question}</Text>
          {prompt.options.map((option) => {
            const isArmed = armed === option.index;
            return (
              <Pressable
                key={option.index}
                style={[styles.choice, isArmed && styles.choiceArmed]}
                disabled={armed !== null}
                onPress={() => {
                  setArmed(option.index);
                  onAnswer(option.index);
                }}
              >
                <Text style={styles.cursor}>
                  {isArmed || (armed === null && option.selected) ? "❯" : " "}
                </Text>
                <Text style={styles.choiceIndex}>{option.index}.</Text>
                <Text style={styles.choiceLabel}>{option.label}</Text>
              </Pressable>
            );
          })}
        </>
      ) : (
        <Pressable onPress={onOpen}>
          <Text style={styles.question}>This one needs a typed reply. Open it →</Text>
        </Pressable>
      )}
    </View>
  );
}

const Centered = ({ children }: { children: React.ReactNode }) => (
  <View style={styles.centered}>
    <Text style={styles.dim}>{children}</Text>
  </View>
);

const statusColor = (status: string) =>
  status === "working" ? theme.mint : status === "blocked" ? theme.peach : theme.dim;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 32 },
  dim: { color: theme.dim, textAlign: "center" },

  topbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.line,
  },
  title: { color: theme.fg, fontFamily: theme.mono, fontSize: 15, fontWeight: "600" },
  link: { fontFamily: theme.mono, fontSize: 11, letterSpacing: 1 },

  groupLabel: {
    color: theme.dim,
    fontFamily: theme.mono,
    fontSize: 11,
    letterSpacing: 1.2,
    paddingHorizontal: 16,
    paddingTop: 22,
    paddingBottom: 8,
  },

  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 11 },
  glyph: { fontFamily: theme.mono, fontSize: 13, width: 14 },
  mark: { fontFamily: theme.mono, fontSize: 13 },
  rowTitle: { color: theme.fg, fontFamily: theme.mono, fontSize: 13, flex: 1 },
  rowMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 11 },

  blocked: {
    margin: 16,
    borderWidth: 1,
    borderColor: theme.peach,
    borderRadius: 10,
    backgroundColor: theme.surface,
    padding: 16,
  },
  badge: { color: theme.peach, fontFamily: theme.mono, fontSize: 11, letterSpacing: 1.4, fontWeight: "600" },
  where: { color: theme.fg, fontSize: 17, fontWeight: "600", marginTop: 8 },
  task: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, marginTop: 2 },
  question: {
    color: theme.fg,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: theme.line,
  },

  choice: { flexDirection: "row", alignItems: "flex-start", gap: 8, minHeight: 44, paddingVertical: 11, paddingHorizontal: 4, borderRadius: 6 },
  choiceArmed: { backgroundColor: theme.raised },
  cursor: { color: theme.peach, fontFamily: theme.mono, fontSize: 14, width: 12 },
  choiceIndex: { color: theme.dim, fontFamily: theme.mono, fontSize: 14 },
  choiceLabel: { color: theme.fg, fontFamily: theme.mono, fontSize: 14, flex: 1, lineHeight: 19 },
});
