/**
 * What the agent has changed in its folder, as Git sees it (capability
 * `changes`): the changed files, and a sheet with one file's diff. The third
 * view beside Read and Screen, laid over the reader as Screen is, so the
 * conversation underneath keeps its place. The browser's `Changes` is the
 * same view; both draw the shared `diffRows`.
 *
 * Read when opened, when pulled or Refresh is pressed, and when the agent
 * finishes a turn, which is when its edits are worth looking at again. Never
 * on a timer: each read runs Git several times on the computer.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { CHANGE_STATUS, changeSummary, diffRows, type ChangedFile, type ChangeStatus, type DiffRow, type FileDiff, type PaneChanges } from "@shahi/shared";
import { useFocusEffect } from "expo-router";
import { Text, useLargeText } from "@/components/text";
import { UnauthorizedError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { monoWidth, theme } from "@/lib/theme";

const FONT = 12;
const LINE = 18;
/** Two line-number columns of five and the sign: the gutter, in characters. */
const GUTTER = "00000 00000 + ".length;
/**
 * The widest a row's text is drawn, in points. iOS draws a text view into one
 * bitmap, and a minified line a thousand characters long, at triple scale and
 * the larger text sizes, would ask for one past the largest texture a phone
 * keeps. A precaution, not a measurement: past it a row ends in "…".
 */
const MAX_ROW_POINTS = 4000;

const STATUS_COLOR: Record<ChangeStatus, string> = {
  modified: theme.peach, renamed: theme.peach, added: theme.mint, untracked: theme.mint, deleted: theme.rose, conflicted: theme.rose,
};

export function ChangesView({ paneId, status }: { paneId: string; status?: string }) {
  const { api, unauthorized } = useSession();
  const largeText = useLargeText();
  const [changes, setChanges] = useState<PaneChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [open, setOpen] = useState<ChangedFile | null>(null);
  // Only the latest read may land: one from before a refresh, or from another
  // computer's API, must not replace what a newer one showed.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setReading(true);
    try {
      const next = await api.changes(paneId);
      if (mine === latest.current) { setChanges(next); setError(null); }
    } catch (e) {
      if (mine !== latest.current) return;
      if (e instanceof UnauthorizedError) { unauthorized(); return; }
      setError(e instanceof Error ? e.message : "The changes could not be read.");
    } finally {
      if (mine === latest.current) setReading(false);
    }
  }, [api, paneId, unauthorized]);

  useEffect(() => {
    void load();
    return () => { latest.current++; };
  }, [load]);

  const before = useRef(status);
  useEffect(() => {
    if (before.current === "working" && status !== "working") void load();
    before.current = status;
  }, [status, load]);

  const repository = changes?.repository;
  const header = (
    <View>
      <View style={[styles.head, largeText && styles.headStacked]}>
        <Text style={styles.repo} accessibilityRole="header">
          {repository ? repository.name : "Changes"}
          {repository && <Text style={styles.branch}>{"  "}{repository.branch ?? (repository.commit ? `detached at ${repository.commit}` : "detached")}</Text>}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh changes" accessibilityState={{ busy: reading }} disabled={reading} onPress={() => void load()} style={styles.refresh}>
          <Text style={styles.refreshText}>{reading ? "Reading…" : "Refresh"}</Text>
        </Pressable>
      </View>
      {error && <Text style={styles.error} accessibilityRole="alert" selectable>{error}</Text>}
      {repository && changes?.note && <Text style={styles.note}>{changes.note}</Text>}
    </View>
  );

  return (
    <>
      <FlatList
        testID="changes-list"
        data={repository ? changes!.files : []}
        keyExtractor={(file) => file.path}
        ListHeaderComponent={header}
        ListEmptyComponent={
          !changes ? (error ? null : <ActivityIndicator color={theme.dim} style={styles.wait} />)
            : <Text style={styles.empty}>{repository ? "No changes since the last commit." : changes.note}</Text>
        }
        ListFooterComponent={changes?.omitted ? <Text style={styles.note}>{`… ${changes.omitted.toLocaleString()} more ${changes.omitted === 1 ? "file" : "files"} not listed.`}</Text> : null}
        renderItem={({ item }) => <FileRow file={item} largeText={largeText} onOpen={setOpen} />}
        refreshControl={<RefreshControl refreshing={reading && !!changes} onRefresh={() => void load()} tintColor={theme.dim} />}
        keyboardShouldPersistTaps="handled"
      />
      {open && <DiffSheet paneId={paneId} file={open} onClose={() => setOpen(null)} />}
    </>
  );
}

const FileRow = memo(function FileRow({ file, largeText, onOpen }: { file: ChangedFile; largeText: boolean; onOpen: (file: ChangedFile) => void }) {
  const folder = folderOf(file.path);
  const counts = file.added !== null && (
    <Text style={styles.counts}>
      <Text style={styles.added}>+{file.added}</Text> <Text style={styles.removed}>−{file.removed}</Text>
    </Text>
  );
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={changeSummary(file)} onPress={() => onOpen(file)} style={styles.file}>
      <Text style={[styles.letter, { color: STATUS_COLOR[file.status] }]}>{CHANGE_STATUS[file.status].letter}</Text>
      {/* At the largest sizes the whole path, on as many lines as it takes,
          with the counts under it rather than taking its width; otherwise one
          line that keeps the file's name and gives up folders. */}
      <View style={styles.fileName}>
        <Text style={styles.path} numberOfLines={largeText ? undefined : 1} ellipsizeMode="head">
          <Text style={styles.folder}>{folder}</Text>
          {file.path.slice(folder.length)}
        </Text>
        {largeText && counts}
      </View>
      {!largeText && counts}
    </Pressable>
  );
});

function DiffSheet({ paneId, file, onClose }: { paneId: string; file: ChangedFile; onClose: () => void }) {
  const { api, unauthorized } = useSession();
  const { fontScale } = useWindowDimensions();
  const largeText = useLargeText();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The list scrolls down inside a view that scrolls sideways, and takes that
  // view's height, measured: a sideways scroll gives its content none.
  const [height, setHeight] = useState(0);
  const close = useRef(onClose);
  close.current = onClose;
  // A sheet left open over a screen the person navigated away from.
  useFocusEffect(useCallback(() => () => close.current(), []));

  useEffect(() => {
    let live = true;
    api.fileDiff(paneId, file.path).then(
      (next) => { if (live) setDiff(next); },
      (e: unknown) => {
        if (!live) return;
        if (e instanceof UnauthorizedError) { unauthorized(); return; }
        setError(e instanceof Error ? e.message : "This file's changes could not be read.");
      },
    );
    return () => { live = false; };
  }, [api, paneId, file.path, unauthorized]);

  const widest = Math.max(GUTTER + 1, Math.floor(MAX_ROW_POINTS / (FONT * 0.62 * fontScale)));
  const rows = useMemo(() => (diff ? diffRows(diff.lines).map((row) => fitted(row, widest - GUTTER)) : []), [diff, widest]);
  const width = monoWidth(Math.max(0, ...rows.map((row) => row.text.length)) + GUTTER, FONT, fontScale) + 16;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={styles.sheet}>
        <View style={styles.bar}>
          <Text style={[styles.letter, { color: STATUS_COLOR[file.status] }]} accessibilityLabel={CHANGE_STATUS[file.status].label}>{CHANGE_STATUS[file.status].letter}</Text>
          <Text style={styles.sheetTitle} accessibilityRole="header" numberOfLines={largeText ? undefined : 2} ellipsizeMode="middle">{file.path}</Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.done}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
        {file.from && <Text style={styles.from} selectable>Renamed from {file.from}</Text>}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert" selectable>{error}</Text>
        ) : !diff ? (
          <ActivityIndicator color={theme.dim} style={styles.wait} />
        ) : rows.length === 0 ? (
          <Text style={styles.empty}>{diff.note ?? "No lines changed."}</Text>
        ) : (
          // Sideways rather than wrapped: a diff is lines of code, and wrapped
          // they no longer line up with their numbers or with each other.
          <ScrollView horizontal style={styles.diff} contentContainerStyle={{ minWidth: "100%" }} onLayout={(e) => setHeight(e.nativeEvent.layout.height)}>
            <FlatList
              testID="diff-lines"
              style={{ width, height }}
              data={rows}
              keyExtractor={(_, i) => String(i)}
              initialNumToRender={40}
              renderItem={({ item }) => <DiffLine row={item} />}
              ListFooterComponent={diff.omitted > 0 ? (
                <Text style={styles.note}>{`… ${diff.omitted.toLocaleString()}${diff.incomplete ? "+" : ""} more ${diff.omitted === 1 ? "line" : "lines"}, too many to show here.`}</Text>
              ) : null}
            />
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const SIGN: Record<DiffRow["kind"], string> = { added: "+", removed: "−", context: " ", hunk: " ", note: " " };
const SPOKEN: Record<DiffRow["kind"], string> = { added: "Added", removed: "Removed", context: "Unchanged", hunk: "Section", note: "Note" };

/**
 * One row: a view for its colour, as wide as the list, and one text with the
 * numbers, the sign and the line, so a long diff costs two views a row.
 */
const DiffLine = memo(function DiffLine({ row }: { row: DiffRow }) {
  const number = row.newLine ?? row.oldLine;
  return (
    <View style={[styles.row, ROW_STYLE[row.kind]]} accessible accessibilityLabel={`${SPOKEN[row.kind]}${number === undefined ? "" : `, line ${number}`}: ${row.text}`}>
      <Text style={[styles.code, (row.kind === "hunk" || row.kind === "note") && styles.quiet]}>
        <Text style={styles.number}>{pad(row.oldLine)} {pad(row.newLine)} </Text>
        <Text style={row.kind === "added" ? styles.added : row.kind === "removed" ? styles.removed : undefined}>{SIGN[row.kind]} </Text>
        {row.text}
      </Text>
    </View>
  );
});

const pad = (n: number | undefined) => (n === undefined ? "" : String(n)).padStart(5);

function fitted(row: DiffRow, chars: number): DiffRow {
  return row.text.length <= chars ? row : { ...row, text: `${row.text.slice(0, Math.max(1, chars - 1))}…` };
}

const folderOf = (path: string) => {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/") + 1) : "";
};

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: theme.line },
  headStacked: { flexDirection: "column", alignItems: "flex-start" },
  repo: { flexGrow: 1, flexShrink: 1, color: theme.fg, fontSize: 15, fontWeight: "600" },
  branch: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, fontWeight: "400" },
  refresh: { minHeight: 44, minWidth: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 8, borderWidth: 1, borderColor: theme.lineBright },
  refreshText: { color: theme.fg, fontSize: 14 },
  note: { color: theme.dim, fontSize: 13, paddingHorizontal: 16, paddingVertical: 10 },
  error: { color: theme.rose, fontSize: 13, padding: 16 },
  empty: { color: theme.dim, textAlign: "center", padding: 32 },
  wait: { padding: 32 },
  file: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.line },
  fileName: { flex: 1, gap: 2 },
  letter: { minWidth: 18, fontFamily: theme.mono, fontSize: 12, fontWeight: "700", textAlign: "center" },
  path: { color: theme.fg, fontFamily: theme.mono, fontSize: 13 },
  folder: { color: theme.dim },
  counts: { fontFamily: theme.mono, fontSize: 12 },
  added: { color: theme.mint },
  removed: { color: theme.rose },
  sheet: { flex: 1, backgroundColor: theme.void },
  bar: { flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 16, paddingRight: 8, paddingTop: 8 },
  sheetTitle: { flex: 1, color: theme.fg, fontFamily: theme.mono, fontSize: 14 },
  done: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: "center", alignItems: "center" },
  doneText: { color: theme.peach, fontSize: 16 },
  from: { color: theme.dim, fontFamily: theme.mono, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
  diff: { flex: 1, marginTop: 8, borderTopWidth: 1, borderTopColor: theme.line },
  row: { paddingHorizontal: 8 },
  code: { color: theme.fg, fontFamily: theme.mono, fontSize: FONT, lineHeight: LINE },
  quiet: { color: theme.dim },
  number: { color: theme.dim },
});

/** The success and danger colours at an eighth, as the browser's rows have them. */
const ROW_STYLE = StyleSheet.create({
  added: { backgroundColor: `${theme.mint}1F` },
  removed: { backgroundColor: `${theme.rose}1F` },
  hunk: { backgroundColor: theme.raised },
  note: { backgroundColor: theme.raised },
  context: {},
});
