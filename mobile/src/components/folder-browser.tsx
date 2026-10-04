import { UiText } from "@/components/ui-text";
import { useI18n } from "@/lib/i18n";
/**
 * Browses the computer's folders, for choosing where something lives.
 *
 * A path is the one thing a new space really needs and the one thing a phone
 * keyboard is worst at: on build 28 the New space sheet was a free-text
 * absolute-path field and chips of folders already in use, so a first space
 * in any other folder meant typing "/Users/…/…" by hand (device audit,
 * October 2026). This lists the folder you are in, with a breadcrumb back to
 * home, an explicit "Up" row (the attach sheet's climb was a folder row named
 * "~", which reads as a folder), and the folders already used by other spaces
 * offered first, since a new space usually sits beside one.
 *
 * The computer lists only inside home (`server/lib/dirs.ts`), so home is the
 * top of the breadcrumb. The value handed back is the listing's absolute path:
 * herdr does not expand `~`, it silently substitutes $HOME, so a display path
 * would put a space in the wrong folder without an error.
 *
 * With `onPickFile`, files are listed too and tapping one picks it: the shape
 * the attach sheet's computer browser needs.
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { breadcrumb, type DirEntry, type DirListing } from "@shahi/shared";
import { Icon } from "@/components/icons";
import { Text, useLargeText } from "@/components/text";
import { useSession } from "@/lib/session";
import { theme } from "@/lib/theme";

export interface FolderChoice {
  /** Absolute: this is what goes to herdr. */
  path: string;
  /** With home shown as `~`: this is what a person reads. */
  display: string;
}

/** Recent folders listed before "Show all". */
const RECENT_SHOWN = 5;

export function FolderBrowser({
  start = "~",
  recent = [],
  onChoose,
  onPickFile,
  chooseLabel,
}: {
  /** Where to open, as the computer names it (`~`, `~/x`, or absolute inside home). */
  start?: string;
  /** Folders worth offering first, shown while browsing home. */
  recent?: FolderChoice[];
  /** Called with the folder being viewed when its button is tapped. */
  onChoose?: (choice: FolderChoice) => void;
  /** Lists files too, and picks one when tapped. */
  onPickFile?: (entry: DirEntry) => void;
  /** The choose button's words; by default it names the folder being viewed. */
  chooseLabel?: string;
}) {
  const { t: ui } = useI18n();
  const { api } = useSession();
  const largeText = useLargeText();
  const [at, setAt] = useState(start);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Another computer is another filesystem: start over from where it began.
  useEffect(() => setAt(start), [api, start]);

  useEffect(() => {
    let live = true;
    setListing(null);
    setError(null);
    api.dirs(at, !!onPickFile).then(
      (d) => live && setListing(d),
      () => live && setError("Couldn't open this folder. Check your connection and try again."),
    );
    return () => { live = false; };
  }, [api, at, attempt, onPickFile]);

  const lines = largeText ? 2 : 1;
  const crumbs = breadcrumb(listing?.display ?? at);
  const atHome = (listing?.display ?? at) === "~";
  const allRecent = atHome ? recent.filter((r) => r.display !== "~") : [];
  // Five, then "Show all": on a computer with thirteen spaces the recent
  // folders filled the screen and pushed browsing out of sight (build 29 on
  // a phone, October 2026).
  const [allShown, setAllShown] = useState(false);
  const shownRecent = allShown ? allRecent : allRecent.slice(0, RECENT_SHOWN);

  return (
    <View style={styles.browser} testID="folder-browser">
      {/* Each folder on the way home is a way back to it. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crumbs} accessibilityLabel={ui("Folder path")}>
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <View key={crumb.display} style={styles.crumbItem}>
              {i > 0 && <Text style={styles.crumbSep}>›</Text>}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={last ? ui("{value1}, current folder", {value1: crumb.label}) : ui("Go to {value1}", {value1: crumb.label})}
                accessibilityState={{ disabled: last }}
                disabled={last}
                style={styles.crumb}
                onPress={() => setAt(crumb.display)}
              >
                <Text style={[styles.crumbText, last && styles.crumbTextOn]}>{crumb.label}</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {shownRecent.length > 0 && <>
        <UiText style={styles.section}>RECENT</UiText>
        {shownRecent.map((choice) => (
          // A folder outside home cannot be listed, only chosen as it is.
          <Pressable accessibilityRole="button" accessibilityLabel={choice.display.startsWith("~") ? ui("Open {value1}", {value1: choice.display}) : ui("Use {value1}", {value1: choice.display})} key={choice.path} style={styles.row}
            onPress={() => (choice.display.startsWith("~") ? setAt(choice.display) : onChoose?.(choice))} testID={`recent-${choice.display}`}>
            <Icon name="folder" size={18} color={theme.peach} />
            <Text style={styles.rowText} numberOfLines={lines} ellipsizeMode="head">{choice.display}</Text>
          </Pressable>
        ))}
        {allRecent.length > shownRecent.length && (
          <Pressable accessibilityRole="button" accessibilityLabel={ui("Show all {value1} recent folders", {value1: allRecent.length})} style={styles.row} onPress={() => setAllShown(true)}>
            <Text style={styles.crumbText}>{ui("Show all" + " ")}{allRecent.length}</Text>
          </Pressable>
        )}
        <UiText style={styles.section}>IN HOME</UiText>
      </>}

      {error && <View style={styles.notice}>
        <UiText accessibilityRole="alert" style={styles.error}>{error}</UiText>
        <Pressable accessibilityRole="button" style={styles.retry} onPress={() => setAttempt((n) => n + 1)}>
          <UiText style={styles.retryText}>Try again</UiText>
        </Pressable>
      </View>}
      {!listing && !error && <UiText accessibilityRole="text" style={styles.dim}>Opening folder…</UiText>}

      {listing && listing.parent !== null && (
        <Pressable accessibilityRole="button" accessibilityLabel={ui("Up to {value1}", {value1: breadcrumb(listing.parent).at(-1)!.label})} style={styles.row} onPress={() => setAt(listing.parent!)} testID="folder-up">
          <Text style={styles.up}>↑</Text>
          <UiText style={styles.rowText}>Up</UiText>
        </Pressable>
      )}
      {listing?.entries.map((entry) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={entry.isDirectory ? ui("Open folder {value1}", {value1: entry.name}) : ui("Attach {value1}", {value1: entry.name})}
          key={entry.path}
          style={styles.row}
          onPress={() => (entry.isDirectory ? setAt(entry.display) : onPickFile?.(entry))}
          testID={`entry-${entry.name}`}
        >
          <Icon name={entry.isDirectory ? "folder" : "file-text"} size={18} color={theme.dim} />
          <Text style={styles.rowText} numberOfLines={lines}>{entry.name}</Text>
        </Pressable>
      ))}
      {listing?.entries.length === 0 && <UiText style={styles.dim}>{onPickFile ? "Nothing in here." : "No folders in here."}</UiText>}

      {/* Opening a folder is not choosing it. The button names the folder
          and is the one filled control, because "Use this folder" under a
          folder's contents read as already done (simulator run of build 32). */}
      {onChoose && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !listing }}
          disabled={!listing}
          style={[styles.choose, !listing && styles.chooseOff]}
          onPress={() => listing && onChoose({ path: listing.path, display: listing.display })}
          testID="use-folder"
        >
          <Text style={styles.chooseText} numberOfLines={lines}>{chooseLabel ?? (atHome ? ui("Use your home folder") : ui("Use {value1}", {value1: crumbs.at(-1)!.label}))}</Text>
          <Text style={styles.chooseWhere} numberOfLines={lines} ellipsizeMode="head">{listing?.display ?? at}</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  browser: { borderWidth: 1, borderColor: theme.line, borderRadius: 10, borderCurve: "continuous", overflow: "hidden" },
  crumbs: { paddingHorizontal: 8, alignItems: "center" },
  crumbItem: { flexDirection: "row", alignItems: "center" },
  crumb: { minHeight: 44, justifyContent: "center", paddingHorizontal: 6 },
  crumbText: { color: theme.peach, fontSize: 14 },
  crumbTextOn: { color: theme.fg, fontWeight: "600" },
  crumbSep: { color: theme.dim, fontSize: 14 },
  section: { color: theme.dim, fontSize: 11, letterSpacing: 1.2, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 4 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line },
  rowText: { color: theme.fg, fontFamily: theme.mono, fontSize: 14, flex: 1 },
  up: { color: theme.peach, fontSize: 18, width: 18, textAlign: "center" },
  dim: { color: theme.dim, fontSize: 13, padding: 12 },
  notice: { padding: 12, gap: 8 },
  error: { color: theme.rose, fontSize: 13 },
  retry: { minHeight: 44, justifyContent: "center" },
  retryText: { color: theme.peach, fontSize: 14 },
  choose: { margin: 10, minHeight: 48, backgroundColor: theme.peach, borderRadius: 10, borderCurve: "continuous", alignItems: "center", justifyContent: "center", paddingHorizontal: 12, paddingVertical: 6 },
  chooseOff: { opacity: 0.35 },
  chooseText: { color: theme.void, fontSize: 15, fontWeight: "600" },
  chooseWhere: { color: theme.void, opacity: 0.75, fontFamily: theme.mono, fontSize: 11, marginTop: 2 },
});
