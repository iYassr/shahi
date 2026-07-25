/**
 * A small markdown renderer for agent prose.
 *
 * Agents write markdown constantly — bold, inline code, fenced blocks, bullets,
 * headings — and shown raw it reads as `**asterisks**` and stray backticks.
 *
 * Deliberately hand-rolled and deliberately small. It returns React elements
 * rather than HTML, so there is no `dangerouslySetInnerHTML` and no escaping
 * question: transcript text is model output that quotes arbitrary web content
 * and file contents, and it should never be able to inject markup. A full
 * CommonMark implementation would be a dependency and an XSS surface in
 * exchange for syntax that rarely appears in this context.
 *
 * Handles: fenced code, headings, bullet and numbered lists, blockquotes,
 * horizontal rules, tables, and inline bold / italic / code / links. Anything
 * else falls through as plain text, which is the correct failure.
 *
 * Tables earn their place: agents produce them constantly, and without support
 * a comparison table arrives as a stack of raw pipe-delimited lines — the
 * single worst-looking thing in the reader.
 */
import { Fragment, type ReactNode } from "react";

export function Markdown({ text }: { text: string }) {
  return <>{renderBlocks(text)}</>;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let key = 0;

  const flush = () => {
    if (paragraph.length === 0) return;
    out.push(
      <p className="md__p" key={key++}>
        {inline(paragraph.join("\n"))}
      </p>,
    );
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code runs to its closing fence, or to the end if the agent is
    // still mid-stream and has not written one yet.
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      out.push(
        <pre className="md__code" key={key++}>
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    // A table is a header row, a delimiter row of dashes, then body rows.
    // The delimiter is what distinguishes it from prose that happens to contain
    // pipes, so both rows must be present before this commits.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!)) {
      flush();
      const header = splitRow(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) body.push(splitRow(lines[i++]!));
      i--;
      out.push(
        <div className="md__table" key={key++} role="table">
          <div className="md__tr md__tr--head" role="row">
            {header.map((cell, c) => (
              <span className="md__th" role="columnheader" key={c}>
                {inline(cell)}
              </span>
            ))}
          </div>
          {body.map((row, r) => (
            <div className="md__tr" role="row" key={r}>
              {row.map((cell, c) => (
                <span className="md__td" role="cell" key={c}>
                  {inline(cell)}
                </span>
              ))}
            </div>
          ))}
        </div>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      out.push(
        <p className="md__h" data-level={heading[1]!.length} key={key++}>
          {inline(heading[2]!)}
        </p>,
      );
      continue;
    }

    // Three or more of the same rule character, and nothing else on the line.
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push(<hr className="md__hr" key={key++} />);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flush();
      out.push(
        <p className="md__li" key={key++}>
          <span className="md__bullet">{numbered ? `${numbered[1]}.` : "•"}</span>
          <span>{inline((bullet ? bullet[1] : numbered![2])!)}</span>
        </p>,
      );
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flush();
      out.push(
        <p className="md__quote" key={key++}>
          {inline(quote[1]!)}
        </p>,
      );
      continue;
    }

    if (line.trim() === "") flush();
    else paragraph.push(line);
  }

  flush();
  return out;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|[\s:|-]*\|\s*$/;

/** Splits `| a | b |` into its cells, dropping the outer pipes. */
function splitRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

/**
 * Inline spans, in precedence order: code wins over emphasis, so backticks
 * containing asterisks stay literal.
 */
const INLINE: { re: RegExp; render: (m: RegExpMatchArray, k: number) => ReactNode }[] = [
  { re: /`([^`]+)`/, render: (m, k) => <code className="md__c" key={k}>{m[1]}</code> },
  {
    re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
    render: (m, k) => (
      <a className="md__a" href={m[2]} target="_blank" rel="noreferrer noopener" key={k}>
        {m[1]}
      </a>
    ),
  },
  { re: /\*\*([^*]+)\*\*/, render: (m, k) => <strong key={k}>{m[1]}</strong> },
  { re: /(?<!\w)_([^_]+)_(?!\w)/, render: (m, k) => <em key={k}>{m[1]}</em> },
  { re: /(?<![*\w])\*([^*]+)\*(?!\w)/, render: (m, k) => <em key={k}>{m[1]}</em> },
];

/**
 * Scans a line left to right, taking whichever marker comes first.
 *
 * The obvious shape — match one span, then recurse on the text either side —
 * was wrong in a way that only showed on real output: a paragraph with seven
 * inline spans exhausted the recursion guard partway along, and the rest of the
 * line kept its `**` markers. Nesting depth and span count are different
 * things — and a span's content is never re-scanned anyway, so a guard on the
 * scan was guarding nothing.
 */
export function inline(text: string): ReactNode {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    let best: { at: number; match: RegExpMatchArray; render: (m: RegExpMatchArray, k: number) => ReactNode } | null = null;
    for (const { re, render } of INLINE) {
      const match = rest.match(re);
      if (match?.index === undefined) continue;
      if (!best || match.index < best.at) best = { at: match.index, match, render };
    }

    if (!best) {
      out.push(rest);
      break;
    }
    if (best.at > 0) out.push(rest.slice(0, best.at));
    out.push(best.render(best.match, key++));
    rest = rest.slice(best.at + best.match[0].length);
  }

  return <Fragment>{out}</Fragment>;
}
