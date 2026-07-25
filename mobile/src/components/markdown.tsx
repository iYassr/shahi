/**
 * Markdown for agent prose, rendered as React Native elements.
 *
 * A port of the web renderer's approach rather than its code: same block
 * grammar, same deliberate smallness, but `<Text>` and `<View>` instead of DOM.
 * It returns elements rather than HTML for the same reason there — transcript
 * text quotes arbitrary web pages and file contents, and should never be able
 * to inject anything.
 *
 * Handles fenced code, headings, bullet and numbered lists, blockquotes,
 * horizontal rules, tables, and inline bold / italic / code / links. Anything
 * else falls through as plain text, which is the correct failure.
 */
import { Fragment, type ReactNode } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "@/lib/theme";

export function Markdown({ text }: { text: string }) {
  return <View>{renderBlocks(text)}</View>;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|[\s:|-]*\|\s*$/;

const splitRow = (line: string) =>
  line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flush = () => {
    if (paragraph.length === 0) return;
    out.push(
      <Text style={styles.p} key={key++}>
        {inline(paragraph.join("\n"))}
      </Text>,
    );
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code runs to its closing fence, or to the end if the agent is
    // still mid-stream and has not written one yet.
    if (/^\s*```/.test(line)) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      out.push(
        <ScrollView horizontal style={styles.codeBox} key={key++}>
          <Text style={styles.code}>{body.join("\n")}</Text>
        </ScrollView>,
      );
      continue;
    }

    // A header row followed by a delimiter of dashes. The delimiter is what
    // distinguishes a table from prose that merely contains pipes.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      flush();
      const header = splitRow(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) body.push(splitRow(lines[i++]!));
      i--;
      out.push(
        <ScrollView horizontal style={styles.table} key={key++}>
          <View>
            <View style={[styles.tr, styles.trHead]}>
              {header.map((cell, c) => (
                <Text style={[styles.cell, styles.th]} key={c}>
                  {cell}
                </Text>
              ))}
            </View>
            {body.map((row, r) => (
              <View style={styles.tr} key={r}>
                {row.map((cell, c) => (
                  <Text style={styles.cell} key={c}>
                    {inline(cell)}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      out.push(
        <Text style={[styles.h, heading[1]!.length > 2 && styles.hSmall]} key={key++}>
          {inline(heading[2]!)}
        </Text>,
      );
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push(<View style={styles.hr} key={key++} />);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flush();
      out.push(
        <View style={styles.li} key={key++}>
          <Text style={styles.bullet}>{numbered ? `${numbered[1]}.` : "•"}</Text>
          <Text style={styles.liText}>{inline((bullet ? bullet[1] : numbered![2])!)}</Text>
        </View>,
      );
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flush();
      out.push(
        <View style={styles.quote} key={key++}>
          <Text style={styles.quoteText}>{inline(quote[1]!)}</Text>
        </View>,
      );
      continue;
    }

    if (line.trim() === "") flush();
    else paragraph.push(line);
  }

  flush();
  return out;
}

/**
 * Inline spans, in precedence order: code wins over emphasis, so backticks
 * containing asterisks stay literal.
 */
const INLINE: { re: RegExp; wrap: (m: RegExpMatchArray, k: number) => ReactNode }[] = [
  { re: /`([^`]+)`/, wrap: (m, k) => <Text style={styles.inlineCode} key={k}>{m[1]}</Text> },
  {
    re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
    wrap: (m, k) => (
      <Text style={styles.link} key={k} onPress={() => void Linking.openURL(m[2]!)}>
        {m[1]}
      </Text>
    ),
  },
  { re: /\*\*([^*]+)\*\*/, wrap: (m, k) => <Text style={styles.bold} key={k}>{m[1]}</Text> },
  { re: /(?<!\w)_([^_]+)_(?!\w)/, wrap: (m, k) => <Text style={styles.italic} key={k}>{m[1]}</Text> },
  { re: /(?<![*\w])\*([^*]+)\*(?!\w)/, wrap: (m, k) => <Text style={styles.italic} key={k}>{m[1]}</Text> },
];

/**
 * Scans a line left to right, taking whichever marker comes first.
 *
 * Not the recursive shape the web renderer started with: matching one span and
 * recursing on the text either side spent a recursion guard per *span*, so a
 * paragraph with seven of them kept its `**` markers from the seventh on. Seen
 * on a real transcript, then fixed in both renderers.
 */
function inline(text: string): ReactNode {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    let best:
      | { at: number; match: RegExpMatchArray; wrap: (m: RegExpMatchArray, k: number) => ReactNode }
      | null = null;
    for (const { re, wrap } of INLINE) {
      const match = rest.match(re);
      if (match?.index === undefined) continue;
      if (!best || match.index < best.at) best = { at: match.index, match, wrap };
    }

    if (!best) {
      out.push(rest);
      break;
    }
    if (best.at > 0) out.push(rest.slice(0, best.at));
    out.push(best.wrap(best.match, key++));
    rest = rest.slice(best.at + best.match[0].length);
  }

  return <Fragment>{out}</Fragment>;
}

const styles = StyleSheet.create({
  p: { color: theme.fg, fontSize: 15, lineHeight: 22, marginBottom: 8 },
  h: { color: theme.fg, fontSize: 17, fontWeight: "600", marginTop: 10, marginBottom: 6 },
  hSmall: { fontSize: 15, color: theme.dim },
  hr: { height: 1, backgroundColor: theme.line, marginVertical: 12 },

  li: { flexDirection: "row", gap: 8, marginBottom: 4 },
  bullet: { color: theme.dim, fontFamily: theme.mono, fontSize: 13, minWidth: 18 },
  liText: { color: theme.fg, fontSize: 15, lineHeight: 22, flex: 1 },

  quote: { borderLeftWidth: 2, borderLeftColor: theme.lineBright, paddingLeft: 10, marginBottom: 8 },
  quoteText: { color: theme.dim, fontSize: 15, lineHeight: 22 },

  // Code keeps its own formatting and scrolls rather than being rewrapped.
  codeBox: { backgroundColor: theme.surface, borderRadius: 8, marginVertical: 6, padding: 10 },
  code: { color: theme.fg, fontFamily: theme.mono, fontSize: 12, lineHeight: 18 },
  inlineCode: { fontFamily: theme.mono, fontSize: 13, color: theme.fg, backgroundColor: theme.raised },

  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  link: { color: theme.peach, textDecorationLine: "underline" },

  table: { borderWidth: 1, borderColor: theme.line, borderRadius: 8, marginVertical: 8 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: theme.line },
  trHead: { backgroundColor: theme.surface },
  cell: { color: theme.fg, fontSize: 13, padding: 8, minWidth: 110, maxWidth: 220 },
  th: { color: theme.dim, fontFamily: theme.mono, fontSize: 11, fontWeight: "600" },
});
