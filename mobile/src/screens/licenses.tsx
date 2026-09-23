/**
 * Open-source licenses: the notices the app's own binary has to carry.
 *
 * Reached from Settings, because that is where iOS apps keep acknowledgements
 * and where a reviewer looks for them, and from the Connect screen, because
 * someone who never connects a computer has the app too. Each notice is shown
 * whole and selectable, never summarised or linked: the licenses ask for
 * their text.
 *
 * Four kinds, each with its own source: the SSH libraries and Lucide's icons
 * are kept by hand in licenses-text.ts, the native libraries CocoaPods builds
 * in from outside node_modules in native-notices.ts, the agent marks' notices
 * in @shahi/shared (both clients draw them), and every npm package in the
 * build is generated into third-party-notices.json by scripts/app-notices.ts.
 *
 * About 100 entries and 120 KB of text, so a virtualised list of short rows
 * rather than one scroll view of whole texts: iOS draws each Text into a
 * backing store the size of the text, and at accessibility sizes the Apache
 * License alone would be one view tens of thousands of points tall. Each
 * paragraph, and each dozen lines of a long one, is its own row, and rows off
 * screen are not drawn at all. (A design reason, not a measured failure.)
 */
import { useMemo } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { ARTWORK_NOTICES } from "@shahi/shared/artwork-notices";
import { Text } from "@/components/text";
import { theme } from "@/lib/theme";
import { LUCIDE_LICENSE, NOTICES } from "./licenses-text";
import { NATIVE_NOTICES } from "./native-notices";
import generated from "./third-party-notices.json";

/** One entry of the generated file; see scripts/third-party-notices.ts. */
interface PackageNotice {
  name: string;
  version: string;
  license: string;
  text: number | null;
  note?: string;
}

export const PACKAGES: { packages: PackageNotice[]; texts: string[] } = generated;

/** Lucide first: the interface icons are everywhere; the marks name agents. */
export const ARTWORK = [
  { name: "Lucide", license: "ISC", covers: "The interface icons", text: LUCIDE_LICENSE },
  ...ARTWORK_NOTICES,
];

export type Row =
  | { kind: "intro"; key: string }
  | { kind: "section"; key: string; testID: string; title: string }
  | { kind: "title"; key: string; testID: string; title: string; meta: string[] }
  | { kind: "text"; key: string; text: string; mono: boolean; paragraph: boolean };

const LINES_PER_ROW = 12;

/** A text as rows: paragraphs, and long paragraphs a dozen lines at a time. */
export function textRows(key: string, text: string): Row[] {
  const rows: Row[] = [];
  // Blank lines end a paragraph; the next line keeps its indentation.
  text.replace(/^\s*\n/, "").trimEnd().split(/\n(?:[ \t]*\n)+/).forEach((paragraph, p) => {
    const lines = paragraph.split("\n");
    for (let at = 0; at < lines.length; at += LINES_PER_ROW) {
      rows.push({ kind: "text", key: `${key}:${p}:${at}`, text: lines.slice(at, at + LINES_PER_ROW).join("\n"), mono: true, paragraph: at === 0 });
    }
  });
  return rows;
}

/** Packages sharing one text are listed once, above it. */
function packageRows(): Row[] {
  const groups = new Map<number | string, PackageNotice[]>();
  for (const pkg of PACKAGES.packages) {
    const key = pkg.text ?? `${pkg.name}@${pkg.version}`;
    groups.set(key, [...groups.get(key) ?? [], pkg]);
  }
  return [...groups.entries()].flatMap(([key, packages]) => {
    const first = packages[0]!;
    const licenses = [...new Set(packages.map((pkg) => pkg.license))].join(", ");
    return [
      {
        kind: "title" as const, key: `package:${key}`, testID: `license-${first.name}`,
        title: packages.length > 1 ? `${first.name} and ${packages.length - 1} more` : first.name,
        meta: [packages.map((pkg) => `${pkg.name} ${pkg.version}`).join(", "), licenses],
      },
      ...typeof key === "number"
        ? textRows(`package:${key}`, PACKAGES.texts[key]!)
        : [{ kind: "text" as const, key: `package:${key}:note`, text: first.note ?? "", mono: false, paragraph: true }],
    ];
  });
}

/** Everything the screen shows, in order: pure, so a test can read all of it. */
export function licenseRows(): Row[] {
  return [
    { kind: "intro", key: "intro" },
    { kind: "section", key: "section:ssh", testID: "licenses-ssh", title: "Built into the SSH connection" },
    ...NOTICES.flatMap((notice): Row[] => [
      { kind: "title", key: `ssh:${notice.name}`, testID: `license-${notice.name}`, title: `${notice.name} ${notice.version}`,
        meta: [notice.license, ...notice.copyright ? [notice.copyright] : []] },
      ...textRows(`ssh:${notice.name}`, notice.text),
    ]),
    { kind: "section", key: "section:native", testID: "licenses-native", title: "Native libraries React Native and Expo build in" },
    ...NATIVE_NOTICES.flatMap((notice): Row[] => [
      { kind: "title", key: `native:${notice.name}`, testID: `license-${notice.name}`, title: `${notice.name} ${notice.version}`,
        meta: [notice.license, notice.in, `${notice.repository} at ${notice.tag}`] },
      // Which upstream file each text is, above it: Hermes carries six.
      ...notice.files.flatMap((file, index): Row[] => [
        { kind: "text", key: `native-file:${notice.name}:${index}`, text: file.path, mono: false, paragraph: true },
        ...textRows(`native:${notice.name}:${index}`, file.text),
      ]),
    ]),
    { kind: "section", key: "section:artwork", testID: "licenses-artwork", title: "Icons and marks" },
    ...ARTWORK.flatMap((notice): Row[] => [
      { kind: "title", key: `art:${notice.name}`, testID: `license-${notice.name}`, title: notice.name, meta: [notice.covers, notice.license] },
      ...textRows(`art:${notice.name}`, notice.text),
    ]),
    { kind: "section", key: "section:packages", testID: "licenses-packages", title: `JavaScript and native modules from npm (${PACKAGES.packages.length})` },
    ...packageRows(),
  ];
}

function LicenseRow({ row }: { row: Row }) {
  switch (row.kind) {
    case "intro":
      return <Text style={styles.intro}>
        Shahi is built on open-source software. These are the notices its licenses ask to travel with the app: the libraries compiled into it, the icons it draws, and the modules it bundles.
      </Text>;
    case "section":
      return <Text style={styles.section} accessibilityRole="header" testID={row.testID}>{row.title}</Text>;
    case "title":
      return <View style={styles.title} testID={row.testID}>
        <Text style={styles.name} accessibilityRole="header">{row.title}</Text>
        {row.meta.map((line, index) => <Text key={index} style={styles.meta}>{line}</Text>)}
      </View>;
    case "text":
      return <Text style={[row.mono ? styles.text : styles.note, row.paragraph && styles.paragraph]} selectable>{row.text}</Text>;
  }
}

export function Licenses() {
  const rows = useMemo(licenseRows, []);
  return (
    <>
      <Stack.Screen options={{ title: "Open-source licenses" }} />
      <FlatList
        testID="licenses-list"
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={({ item }) => <LicenseRow row={item} />}
        contentInsetAdjustmentBehavior="automatic"
        style={styles.screen}
        contentContainerStyle={styles.content}
        initialNumToRender={24}
      />
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.void },
  // Past the home indicator; this screen sits above the tabs, not beside them.
  content: { padding: 16, paddingBottom: 48 },
  intro: { color: theme.dim, fontSize: 14, lineHeight: 20 },
  section: { color: theme.fg, fontSize: 20, fontWeight: "700", marginTop: 32 },
  title: { marginTop: 24, gap: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.line, paddingTop: 12 },
  name: { color: theme.fg, fontSize: 17, fontWeight: "600" },
  meta: { color: theme.dim, fontSize: 13 },
  text: { color: theme.fg, fontFamily: theme.mono, fontSize: 11, lineHeight: 16 },
  note: { color: theme.dim, fontSize: 14, lineHeight: 20 },
  paragraph: { marginTop: 12 },
});
