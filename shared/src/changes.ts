/**
 * What an agent has changed in its folder, as Git sees it: the Changes view
 * beside Read and Screen (capability `changes`). `GET /api/panes/:id/changes`
 * lists the files, `GET /api/panes/:id/diff?path=…` shows one of them.
 *
 * Everything is compared with the last commit, staged or not: staging is how
 * a person prepares a commit, and an agent's work is reviewed as a whole.
 * Read-only by design; nothing here commits, stages or discards.
 */

/**
 * How a file differs from the last commit. A copy, a change of type (a file
 * that became a symbolic link) and anything else Git reports are "modified".
 */
export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface ChangedFile {
  /** Relative to the repository's top folder, as Git names it; ends in `/` for a nested repository. */
  path: string;
  /** Where a renamed file was before. */
  from?: string;
  status: ChangeStatus;
  /** Lines added and removed; null where Git counts none (binary, too large to read, a folder). */
  added: number | null;
  removed: number | null;
}

export interface PaneChanges {
  /**
   * The repository holding the pane's folder: its top folder's name and path
   * (`~/…`), its branch, and the last commit's short id. Null when there is
   * none Shahi will read, with `note` saying why in words.
   */
  repository: { name: string; path: string; branch: string | null; commit: string | null } | null;
  /** A sentence to show as it stands: why there is no repository, or why the list is incomplete. */
  note?: string;
  files: ChangedFile[];
  /** Changed files past the length of the list, not sent. */
  omitted: number;
}

export interface FileDiff {
  path: string;
  from?: string;
  status: ChangeStatus;
  /**
   * The unified diff from its first hunk on, one entry per line as Git wrote
   * it: `@@ …`, then `+`, `-`, ` ` and `\` lines. A line too long to send is
   * cut, and says so at its end.
   */
  lines: string[];
  /** Lines of the diff after the last one sent. */
  omitted: number;
  /** Git stopped before the end of the diff, so there are at least `omitted` more. */
  incomplete?: boolean;
  /** Why there are no lines to show (binary, a folder, a rename alone), as a sentence. */
  note?: string;
}

export const CHANGE_STATUS: Record<ChangeStatus, { letter: string; label: string }> = {
  modified: { letter: "M", label: "Modified" },
  added: { letter: "A", label: "Added" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  untracked: { letter: "U", label: "Untracked" },
  conflicted: { letter: "C", label: "Conflicted" },
};

/** One file as a screen reader says it: the letters and signs alone mean nothing aloud. */
export function changeSummary(file: ChangedFile): string {
  const counts = file.added === null || file.removed === null
    ? ""
    : `, ${file.added} ${file.added === 1 ? "line" : "lines"} added, ${file.removed} removed`;
  return `${file.path}, ${CHANGE_STATUS[file.status].label.toLowerCase()}${file.from ? ` from ${file.from}` : ""}${counts}`;
}

export interface DiffRow {
  kind: "hunk" | "added" | "removed" | "context" | "note";
  /** As shown, without its `+`/`-`/space marker; see `shownText`. */
  text: string;
  /** Its line number in the last commit's file and in the working file, where it has one. */
  oldLine?: number;
  newLine?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * A diff's lines as rows to draw, numbered from their hunk headers. Shared so
 * the phone and the browser number and colour a diff alike.
 */
export function diffRows(lines: readonly string[]): DiffRow[] {
  let oldLine = 0;
  let newLine = 0;
  return lines.map((line): DiffRow => {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: "hunk", text: shownText(line) };
    }
    const text = shownText(line.slice(1));
    switch (line[0]) {
      case "+": return { kind: "added", text, newLine: newLine++ };
      case "-": return { kind: "removed", text, oldLine: oldLine++ };
      case " ": return { kind: "context", text, oldLine: oldLine++, newLine: newLine++ };
      // "\ No newline at end of file", and anything Git adds that is not a line.
      default: return { kind: "note", text: shownText(line.replace(/^\\\s*/, "")) };
    }
  });
}

/** Tab stops every four columns: a phone has no width for a terminal's eight. */
const TAB = 4;

/**
 * A line's text with its tabs as spaces and any other control character as
 * its visible symbol. Neither client can be told where a tab stops or that a
 * carriage return is not a line break, and a stray `\r` broke one row in two;
 * the line itself is never re-wrapped.
 */
export function shownText(text: string): string {
  if (!/[\x00-\x1f\x7f]/.test(text)) return text;
  let out = "";
  for (const char of text) {
    if (char === "\t") out += " ".repeat(TAB - (out.length % TAB));
    else if (char === "\x7f") out += "␡";
    else if (char < " ") out += String.fromCharCode(0x2400 + char.charCodeAt(0));
    else out += char;
  }
  return out;
}
