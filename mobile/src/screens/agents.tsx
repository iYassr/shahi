/**
 * The Agents screen: which agent needs you, and what it is asking.
 *
 * Deliberately the same information architecture as the web client — blocked
 * agents pinned above everything, everything else collapsed to one line —
 * because that decision was the point of the product, not an artefact of the
 * platform. What differs is only how it is drawn.
 */
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { DashboardPane, ParsedPrompt, Session, SocketMessage } from "@herdrui/shared";
import { api, connection, SessionSocket, type LinkState } from "@/lib/api";
import { AGENT_COLORS, GLYPH, theme } from "@/lib/theme";

export function Agents() {
  const [session, setSession] = useState<Session | null>(null);
  const [prompts, setPrompts] = useState<Record<string, ParsedPrompt>>({});
  const [link, setLink] = useState<LinkState>("connecting");
  const [error, setError] = useState<string | null>(null);

  const onMessage = useCallback((msg: SocketMessage) => {
    if (msg.type === "session") {
      setSession(msg.session);
      // A prompt belongs to a blocked agent; once it moves on, drop it so the
      // list cannot offer answers to a question already answered.
      setPrompts((current) => {
        const next: Record<string, ParsedPrompt> = {};
        for (const pane of msg.session.panes) {
          if (pane.status !== "blocked") continue;
          const known = current[pane.paneId] ?? pane.prompt;
          if (known) next[pane.paneId] = known;
        }
        return next;
      });
    } else if (msg.type === "prompt") {
      setPrompts((current) => ({ ...current, [msg.paneId]: msg.prompt }));
    }
  }, []);

  useEffect(() => {
    if (!connection.cookie) return;
    void api.session().then(setSession).catch((e: Error) => setError(e.message));
    const socket = new SessionSocket(onMessage, setLink);
    socket.connect();
    return () => socket.close();
  }, [onMessage]);

  async function answer(paneId: string, index: number) {
    try {
      await api.answerPrompt(paneId, index);
      setPrompts((current) => {
        const next = { ...current };
        delete next[paneId];
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) return <Centered>{error}</Centered>;
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
              />
            ))}
            {rest.length > 0 && (
              <Text style={styles.groupLabel}>
                {blocked.length > 0 ? "EVERYTHING ELSE" : `${rest.length} AGENTS`}
              </Text>
            )}
          </>
        }
        renderItem={({ item }) => <Row pane={item} />}
        ListEmptyComponent={blocked.length ? null : <Centered>No agents running.</Centered>}
      />
    </View>
  );
}

function Row({ pane }: { pane: DashboardPane }) {
  return (
    <View style={styles.row}>
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
    </View>
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
}: {
  pane: DashboardPane;
  prompt: ParsedPrompt | undefined;
  onAnswer: (index: number) => void;
}) {
  const [armed, setArmed] = useState<number | null>(null);

  return (
    <View style={styles.blocked}>
      <Text style={styles.badge}>● WAITING ON YOU</Text>
      <Text style={styles.where}>{pane.workspaceLabel}</Text>
      <Text style={styles.task} numberOfLines={1}>
        {pane.agent ?? "agent"} · {pane.paneId} · {pane.title ?? "untitled"}
      </Text>

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
        <Text style={styles.question}>This one needs a typed reply.</Text>
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
