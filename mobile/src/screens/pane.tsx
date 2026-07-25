/**
 * A single pane: what the agent said, what it is asking, and a way to reply.
 *
 * Reader-first, like the web client, and for the same reason — the transcript
 * is the readable thing and the terminal is for when you need the real screen.
 * The terminal itself is not here yet; xterm.js has no React Native port and
 * would have to run inside a WebView.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { Activity, LogBlock, LogMessage, ParsedPrompt } from "@herdrui/shared";
import { api, connection } from "@/lib/api";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";
import { Markdown } from "@/components/markdown";

/** How often to pull while open. The server caches on file size. */
const POLL_MS = 2_500;

/**
 * How many columns to fit across the screen.
 *
 * 146 is what herdr is actually rendering at, so it is the only one that shows
 * a whole line without scrolling — hence "fit". The narrower ones trade the
 * right-hand side for readable text.
 */
const TERMINAL_SIZES = [60, 100, 146];
const WIDEST = 146;
/** Big enough to read a prompt at arm's length, small enough to stay a terminal. */
const MAX_TERMINAL_FONT = 20;
/** Long enough to average out rounding, short enough never to wrap. */
const PROBE_CHARS = 40;
const PROBE_FONT = 12;
/**
 * Starting guess for the monospace advance, replaced by a measurement.
 *
 * Guessing does not work here. Terminal output is full of box drawing, and if
 * the font in use has no glyph for `─` the fallback font's advance is not the
 * one the nominal 0.6em predicts — the estimate comes out narrow, every line
 * wraps, and each box folds in half. So the width is measured once from a probe
 * of the exact character that causes the trouble.
 */
const CHAR_ASPECT_GUESS = 0.6;
const PROBE = "─".repeat(PROBE_CHARS);

/** Keys a touch keyboard cannot produce but agents routinely ask for. */
const KEY_BAR: { label: string; keys: string[] }[] = [
  { label: "esc", keys: ["Escape"] },
  { label: "⇥", keys: ["Tab"] },
  { label: "⇧⇥", keys: ["S-Tab"] },
  { label: "^C", keys: ["C-c"] },
  { label: "↑", keys: ["Up"] },
  { label: "↓", keys: ["Down"] },
  { label: "⏎", keys: ["Enter"] },
];

interface Props {
  paneId: string;
  onBack: () => void;
}

export function Pane({ paneId, onBack }: Props) {
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [prompt, setPrompt] = useState<ParsedPrompt | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [readable, setReadable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  /**
   * Reader or raw screen.
   *
   * The reader is the point of the app, but it only exists for agents that keep
   * a transcript. A plain shell has none, and without the screen there would be
   * nothing to look at while typing into it.
   */
  const [view, setView] = useState<"reader" | "screen">("reader");
  const [columns, setColumns] = useState(TERMINAL_SIZES[1]!);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<LogMessage>>(null);
  /**
   * Whether to follow new output.
   *
   * The list re-measures on every poll, and snapping to the end each time would
   * drag the reader back down mid-paragraph — the one thing that makes a long
   * transcript unreadable. So it follows only while already at the bottom, and
   * lets go the moment you scroll away.
   */
  const following = useRef(true);
  const { watch, session } = useSession();
  // What this pane is, as far as the dashboard knows. A plain shell is not an
  // agent, and asking someone to "reply" to their own bash prompt is nonsense.
  const pane = session?.panes.find((p) => p.paneId === paneId);

  // Back should close the attachment sheet before it leaves the pane.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!attaching) return false;
      setAttaching(false);
      return true;
    });
    return () => sub.remove();
  }, [attaching]);

  // Tell the server this pane is being looked at: it drops from the 2s
  // background interval to 400ms, and sorts first, for as long as we are here.
  useEffect(() => {
    watch(paneId);
    return () => watch(null);
  }, [paneId, watch]);

  const load = useCallback(async () => {
    try {
      const log = await api.sessionLog(paneId, 60);
      setMessages(log.messages);
      setReadable(true);
      setLoading(false);
    } catch {
      // No transcript *yet*. A just-started agent has not written one, so this
      // keeps polling rather than latching — the reader fills in by itself the
      // moment the agent says something.
      setReadable(false);
      setLoading(false);
    }
    try {
      const detail = await api.pane(paneId);
      setPrompt(detail.frame?.prompt ?? null);
      setActivity(detail.frame?.activity ?? null);
      setScreen(detail.frame?.text ?? null);
    } catch {
      // Transient; the next poll will catch up.
    }
  }, [paneId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function answer(index: number) {
    try {
      await api.answerPrompt(paneId, index);
      setPrompt(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try {
      await api.send(paneId, text);
      setDraft("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      // "padding" on Android too, not just iOS. Under edge-to-edge — the
      // default since SDK 54 — the window no longer resizes when the keyboard
      // opens, so leaving Android on the default meant the composer stayed
      // where it was and the keyboard covered it. Verified on the emulator:
      // taps meant for Send were landing on the keyboard's own Enter key.
      behavior="padding"
    >
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={styles.back}>‹</Text>
        </Pressable>
        <View style={styles.heading}>
          <Text style={styles.title} numberOfLines={1}>
            {pane?.title ?? paneId}
          </Text>
          {pane?.title && <Text style={styles.subtitle}>{pane.agent ?? "shell"} · {paneId}</Text>}
        </View>
        <View style={{ flex: 1 }} />
        {error && <Text style={styles.error} numberOfLines={1}>{error}</Text>}
        <View style={styles.toggle}>
          <Pressable
            style={[styles.toggleItem, view === "reader" && styles.toggleOn]}
            onPress={() => setView("reader")}
          >
            <Text style={[styles.toggleText, view === "reader" && styles.toggleTextOn]}>read</Text>
          </Pressable>
          <Pressable
            style={[styles.toggleItem, view === "screen" && styles.toggleOn]}
            onPress={() => setView("screen")}
          >
            <Text style={[styles.toggleText, view === "screen" && styles.toggleTextOn]}>screen</Text>
          </Pressable>
        </View>
      </View>

      {prompt && <Prompt prompt={prompt} onAnswer={answer} />}

      {view === "screen" ? (
        <Screen text={screen} columns={columns} onColumns={setColumns} />
      ) : loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.peach} />
          <Text style={styles.dim}>Reading the conversation…</Text>
        </View>
      ) : !readable ? (
        <View style={styles.centered}>
          <Text style={styles.dim}>
            Nothing to read yet.
          </Text>
          <Text style={styles.dim}>
            Claude and codex sessions appear here once the agent has said
            something. A plain shell keeps none at all.
          </Text>
          <Pressable style={styles.ghost} onPress={() => setView("screen")}>
            <Text style={styles.ghostText}>Show the screen instead</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          // Without this, the first tap anywhere in a scrollable only dismisses
          // the keyboard and is swallowed — so expanding a tool call or
          // pressing a key takes two taps while the composer has focus.
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => <Message message={item} paneId={paneId} />}
          onScroll={({ nativeEvent: e }) => {
            const fromBottom =
              e.contentSize.height - e.layoutMeasurement.height - e.contentOffset.y;
            following.current = fromBottom < 80;
          }}
          scrollEventThrottle={200}
          onContentSizeChange={() => {
            if (following.current) listRef.current?.scrollToEnd({ animated: false });
          }}
          ListFooterComponent={activity ? <Working activity={activity} /> : null}
        />
      )}

      <View style={styles.compose}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.keys}
          keyboardShouldPersistTaps="handled"
        >
          {KEY_BAR.map(({ label, keys }) => (
            <Pressable
              key={label}
              style={styles.key}
              onPress={() => void api.sendKeys(paneId, keys).catch(() => {})}
            >
              <Text style={styles.keyText}>{label}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.composeRow}>
          <Pressable style={styles.attach} onPress={() => setAttaching(true)}>
            <Text style={styles.attachText}>+</Text>
          </Pressable>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={pane && !pane.isAgent ? "Run a command…" : "Reply to this agent…"}
            placeholderTextColor={theme.dim}
            multiline
          />
          <Pressable
            style={[styles.send, (sending || !draft.trim()) && styles.sendOff]}
            disabled={sending || !draft.trim()}
            onPress={() => void submit()}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </View>

      {attaching && (
        <FilePicker
          onClose={() => setAttaching(false)}
          onPick={(path) => {
            // Attachments become paths on their own line, the same as the web
            // client — an agent cannot receive a file over a terminal, but it
            // can read one off disk.
            setDraft((d) => (d ? `${path}\n${d}` : `${path}\n`));
            setAttaching(false);
          }}
        />
      )}
    </KeyboardAvoidingView>
  );
}

/**
 * The answer list, rebuilt from the terminal's own — same numbering, same
 * cursor, sized for a thumb.
 */
function Prompt({
  prompt,
  onAnswer,
}: {
  prompt: ParsedPrompt;
  onAnswer: (index: number) => Promise<void>;
}) {
  const [armed, setArmed] = useState<number | null>(null);
  return (
    <View style={styles.promptCard}>
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
              void onAnswer(option.index).catch(() => setArmed(null));
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
    </View>
  );
}

function Message({ message, paneId }: { message: LogMessage; paneId: string }) {
  const mine = message.role === "you";
  return (
    <View style={[styles.msg, mine && styles.msgYou]}>
      <Text style={[styles.who, mine && styles.whoYou]}>{mine ? "YOU" : "AGENT"}</Text>
      {message.blocks.map((block, i) => (
        <Block key={i} block={block} paneId={paneId} />
      ))}
    </View>
  );
}

function Block({ block, paneId }: { block: LogBlock; paneId: string }) {
  const [open, setOpen] = useState(false);

  if (block.kind === "text") return <Markdown text={block.text} />;

  if (block.kind === "thinking") {
    return (
      <Pressable onPress={() => setOpen((o) => !o)}>
        <Text style={styles.thinkingLabel}>{open ? "▾ Thinking" : "▸ Thinking"}</Text>
        {open && <Text style={styles.thinking}>{block.text}</Text>}
      </Pressable>
    );
  }

  if (block.kind === "image") return <TranscriptImage paneId={paneId} imageRef={block.ref} />;

  // Tool calls dominate a real transcript; collapsed, they stop drowning it.
  return (
    <View style={styles.tool}>
      <Pressable style={styles.toolHead} onPress={() => setOpen((o) => !o)}>
        <Text style={styles.toolCaret}>{open ? "▾" : "▸"}</Text>
        <Text style={styles.toolName}>{block.name}</Text>
        <Text style={styles.toolSummary} numberOfLines={1}>{block.summary}</Text>
        {block.result?.isError && <Text style={styles.toolErr}>failed</Text>}
      </Pressable>
      {open && block.result && (
        <>
          {block.result.text.trim().length > 0 && (
            <ScrollView horizontal style={styles.toolOut}>
              <Text style={styles.toolOutText}>{block.result.text}</Text>
            </ScrollView>
          )}
          {block.result.images.map((ref) => (
            <TranscriptImage key={ref} paneId={paneId} imageRef={ref} />
          ))}
        </>
      )}
    </View>
  );
}

/** Images come from the server rather than the transcript payload. */
function TranscriptImage({ paneId, imageRef }: { paneId: string; imageRef: string }) {
  const uri = `${connection.baseUrl}/api/panes/${encodeURIComponent(paneId)}/image?ref=${encodeURIComponent(imageRef)}`;
  return (
    <Image
      source={{ uri, headers: connection.cookie ? { cookie: connection.cookie } : undefined }}
      style={styles.image}
      resizeMode="contain"
    />
  );
}

/**
 * The pane's actual screen, as characters.
 *
 * herdr renders at a fixed width — 146 columns here — and refuses to reflow it,
 * so the only honest options are to scroll or to shrink. This does both: the
 * text scrolls in one direction and the width control picks a font size that
 * fits a chosen number of columns across the phone, so "all of it" is one tap
 * away even when that means small.
 *
 * Colour is dropped. Reproducing ANSI attributes would mean an emulator in a
 * WebView, and the thing worth seeing on a phone is the words.
 */
function Screen({
  text,
  columns,
  onColumns,
}: {
  text: string | null;
  columns: number;
  onColumns: (columns: number) => void;
}) {
  const width = useWindowDimensions().width;
  const [aspect, setAspect] = useState(CHAR_ASPECT_GUESS);
  const fontSize = Math.max(6, Math.min(MAX_TERMINAL_FONT, (width - 24) / (columns * aspect)));

  const body = text ?? "Waiting for the pane…";
  // The text has to be given a width, or it wraps to the viewport. Sizing it to
  // the longest line is also what makes the horizontal scroll mean anything.
  const longest = body.split("\n").reduce((most, line) => Math.max(most, line.length), 0);

  return (
    <View style={styles.screenWrap}>
      {/* Off-screen, one line, measured once — see CHAR_ASPECT_GUESS. */}
      <Text
        style={[styles.screenText, styles.probe, { fontSize: PROBE_FONT }]}
        onLayout={(e) => setAspect(e.nativeEvent.layout.width / PROBE_CHARS / PROBE_FONT)}
      >
        {PROBE}
      </Text>
      <ScrollView horizontal>
        <ScrollView>
          <Text
            style={[
              styles.screenText,
              {
                fontSize,
                lineHeight: fontSize * 1.25,
                width: longest * fontSize * aspect + 24,
              },
            ]}
          >
            {body}
          </Text>
        </ScrollView>
      </ScrollView>
      <View style={styles.widths}>
        {TERMINAL_SIZES.map((size) => (
          <Pressable
            key={size}
            style={[styles.width, size === columns && styles.widthOn]}
            onPress={() => onColumns(size)}
          >
            <Text style={[styles.widthText, size === columns && styles.widthTextOn]}>
              {size === WIDEST ? "fit" : `${size}c`}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** Stands in for the message still being written. */
function Working({ activity }: { activity: Activity }) {
  return (
    <View style={styles.working}>
      <Text style={styles.workingSpin}>✳</Text>
      <Text style={styles.workingVerb}>{activity.verb}</Text>
      <Text style={styles.workingMeta} numberOfLines={1}>
        {activity.elapsed}
        {activity.detail ? ` · ${activity.detail}` : ""}
      </Text>
    </View>
  );
}

/**
 * Attaching a file — from the phone, or from the server it is going to.
 *
 * Both ends matter. A photo of a whiteboard is on the phone; the log the agent
 * needs is already on the server, and making that round-trip through the phone
 * would be absurd. Either way what reaches the agent is a path: a terminal
 * cannot receive a file, but an agent can read one off disk.
 */
function FilePicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [path, setPath] = useState("~");
  const [entries, setEntries] = useState<
    { name: string; path: string; display: string; isDirectory: boolean }[]
  >([]);
  const [parent, setParent] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .dirs(path, true)
      .then((d) => {
        setEntries(d.entries);
        setParent(d.parent);
      })
      .catch(() => setEntries([]));
  }, [path]);

  /** Uploads to the server, then hands back where it landed. */
  async function upload(file: { uri: string; name: string; type: string }) {
    setUploading(true);
    setError(null);
    try {
      const stored = await api.upload(file);
      onPick(stored.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function fromPhotos() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError("Photo access was declined.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 1 });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;
    await upload({
      uri: asset.uri,
      name: asset.fileName ?? `photo.${asset.uri.split(".").pop() ?? "jpg"}`,
      type: asset.mimeType ?? "image/jpeg",
    });
  }

  async function fromFiles() {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    const asset = result.assets?.[0];
    if (result.canceled || !asset) return;
    await upload({
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? "application/octet-stream",
    });
  }

  return (
    <View style={styles.sheet}>
      <View style={styles.sheetHead}>
        <Text style={styles.sheetTitle}>Attach a file</Text>
        <Pressable onPress={onClose} hitSlop={12}>
          <Text style={styles.sheetClose}>Done</Text>
        </Pressable>
      </View>

      <View style={styles.fromPhone}>
        <Pressable style={styles.phoneButton} disabled={uploading} onPress={() => void fromPhotos()}>
          <Text style={styles.phoneButtonText}>Photo</Text>
        </Pressable>
        <Pressable style={styles.phoneButton} disabled={uploading} onPress={() => void fromFiles()}>
          <Text style={styles.phoneButtonText}>File on phone</Text>
        </Pressable>
      </View>
      {uploading && <Text style={styles.sheetNote}>Uploading…</Text>}
      {error && <Text style={styles.uploadErr}>{error}</Text>}

      <Text style={styles.sheetPath} numberOfLines={1}>{path}</Text>
      <FlatList
        data={parent ? [{ name: parent, path: parent, display: parent, isDirectory: true }, ...entries] : entries}
        keyExtractor={(e) => e.path}
        style={{ maxHeight: 320 }}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }) => (
          <Pressable
            style={styles.fileRow}
            onPress={() => (item.isDirectory ? setPath(item.display) : onPick(item.path))}
          >
            <Text style={styles.fileGlyph}>
              {parent && index === 0 ? "↰" : item.isDirectory ? "/" : "·"}
            </Text>
            <Text style={styles.fileName} numberOfLines={1}>{item.name}</Text>
          </Pressable>
        )}
      />
      <Text style={styles.sheetNote}>Tap a file on the server to attach it. Folders open.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  dim: { color: theme.dim, textAlign: "center" },
  error: { color: theme.rose, fontSize: 11, maxWidth: 160 },

  topbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.line,
  },
  back: { color: theme.dim, fontSize: 26, lineHeight: 26 },
  heading: { flexShrink: 1 },
  title: { color: theme.fg, fontFamily: theme.mono, fontSize: 14 },
  subtitle: { color: theme.dim, fontFamily: theme.mono, fontSize: 10, marginTop: 1 },
  toggle: { flexDirection: "row", borderWidth: 1, borderColor: theme.line, borderRadius: 7 },
  toggleItem: { paddingHorizontal: 10, minHeight: 32, justifyContent: "center" },
  toggleOn: { backgroundColor: theme.raised },
  toggleText: { color: theme.dim, fontFamily: theme.mono, fontSize: 11 },
  toggleTextOn: { color: theme.peach },

  screenWrap: { flex: 1 },
  probe: { position: "absolute", opacity: 0, left: 0, top: 0 },
  screenText: { color: theme.fg, fontFamily: theme.mono, padding: 12 },
  widths: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.line,
  },
  width: {
    minHeight: 34,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 7,
  },
  widthOn: { borderColor: theme.peach },
  widthText: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  widthTextOn: { color: theme.peach },
  ghost: {
    marginTop: 6,
    minHeight: 44,
    paddingHorizontal: 16,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8,
  },
  ghostText: { color: theme.peach, fontFamily: theme.mono, fontSize: 13 },

  list: { padding: 16 },
  msg: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.line },
  msgYou: {
    backgroundColor: theme.surface,
    borderLeftWidth: 2,
    borderLeftColor: theme.peach,
    borderBottomWidth: 0,
    borderRadius: 8,
    paddingHorizontal: 12,
    marginVertical: 8,
  },
  who: { color: theme.dim, fontFamily: theme.mono, fontSize: 10, letterSpacing: 1.2, marginBottom: 6 },
  whoYou: { color: theme.peach },

  thinkingLabel: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, letterSpacing: 1, paddingVertical: 6 },
  thinking: { color: theme.dim, fontSize: 13, lineHeight: 19, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: theme.lineBright },

  tool: { marginBottom: 6 },
  toolHead: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 7 },
  toolCaret: { color: theme.lineBright, fontFamily: theme.mono, fontSize: 12 },
  toolName: { color: theme.mint, fontFamily: theme.mono, fontSize: 12 },
  toolSummary: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, flex: 1 },
  toolErr: { color: theme.rose, fontFamily: theme.mono, fontSize: 11 },
  toolOut: { backgroundColor: theme.surface, borderRadius: 8, padding: 10, marginBottom: 8, maxHeight: 260 },
  toolOutText: { color: theme.fg, fontFamily: theme.mono, fontSize: 11, lineHeight: 17 },

  image: {
    width: "100%",
    height: 220,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: 8,
    marginVertical: 6,
    backgroundColor: theme.surface,
  },

  promptCard: {
    margin: 16,
    borderWidth: 1,
    borderColor: theme.peach,
    borderRadius: 10,
    backgroundColor: theme.surface,
    padding: 14,
  },
  question: { color: theme.fg, fontSize: 15, lineHeight: 21, marginBottom: 8 },
  choice: { flexDirection: "row", alignItems: "flex-start", gap: 8, minHeight: 44, paddingVertical: 10, borderRadius: 6 },
  choiceArmed: { backgroundColor: theme.raised },
  cursor: { color: theme.peach, fontFamily: theme.mono, fontSize: 14, width: 12 },
  choiceIndex: { color: theme.dim, fontFamily: theme.mono, fontSize: 14 },
  choiceLabel: { color: theme.fg, fontFamily: theme.mono, fontSize: 14, flex: 1, lineHeight: 19 },

  working: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 14 },
  workingSpin: { color: theme.peach, fontFamily: theme.mono, fontSize: 13 },
  workingVerb: { color: theme.fg, fontFamily: theme.mono, fontSize: 13 },
  workingMeta: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, flex: 1 },

  compose: { borderTopWidth: 1, borderTopColor: theme.line, padding: 10, gap: 8 },
  keys: { flexGrow: 0 },
  key: {
    minHeight: 36,
    paddingHorizontal: 12,
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 7,
    marginRight: 6,
  },
  keyText: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  composeRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  attach: {
    width: 44,
    minHeight: 44,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  attachText: { color: theme.dim, fontSize: 22, lineHeight: 24 },
  input: {
    flex: 1,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8,
    color: theme.fg,
    fontFamily: theme.mono,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
    maxHeight: 120,
  },
  send: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: theme.peach,
    alignItems: "center",
    justifyContent: "center",
  },
  sendOff: { opacity: 0.35 },
  sendText: { color: theme.void, fontWeight: "600" },

  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: theme.surface,
    borderTopWidth: 1,
    borderTopColor: theme.lineBright,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
  },
  sheetHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sheetTitle: { color: theme.fg, fontSize: 17, fontWeight: "600" },
  sheetClose: { color: theme.peach, fontSize: 15 },
  fromPhone: { flexDirection: "row", gap: 8 },
  phoneButton: {
    flex: 1,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.lineBright,
    borderRadius: 8,
  },
  phoneButtonText: { color: theme.peach, fontFamily: theme.mono, fontSize: 13 },
  uploadErr: { color: theme.rose, fontSize: 12 },
  sheetPath: { color: theme.dim, fontFamily: theme.mono, fontSize: 12 },
  sheetNote: { color: theme.dim, fontSize: 12, textAlign: "center" },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 4 },
  fileGlyph: { color: theme.dim, fontFamily: theme.mono, fontSize: 13 },
  fileName: { color: theme.fg, fontFamily: theme.mono, fontSize: 13, flex: 1 },
});
