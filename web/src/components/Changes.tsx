import { useCallback, useEffect, useRef, useState } from "react";
import { CHANGE_STATUS, changeSummary, diffRows, type ChangedFile, type FileDiff, type PaneChanges } from "@shahi/shared";
import { useApi } from "../api";

/**
 * What the agent has changed in its folder, as Git sees it (capability
 * `changes`): the changed files, and one file's diff when it is chosen. The
 * phone's `ChangesView` is the same view; both draw the shared `diffRows`.
 *
 * Read on opening, on Refresh, and when the agent finishes a turn, which is
 * when its edits are worth looking at again. Never on a timer: each read runs
 * Git several times on the computer.
 */
export function Changes({ paneId, status }: { paneId: string; status?: string }) {
  const api = useApi();
  const [changes, setChanges] = useState<PaneChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<ChangedFile | null>(null);
  // Only the latest read may land: a slow one from before a refresh, or from
  // a pane left since, must not replace what a newer one showed.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const next = await api.changes(paneId);
      if (mine === latest.current) { setChanges(next); setError(null); }
    } catch (err) {
      if (mine === latest.current && !aborted(err)) setError(err instanceof Error ? err.message : "The changes could not be read.");
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [api, paneId]);

  useEffect(() => {
    void load();
    return () => { latest.current++; };
  }, [load]);

  const before = useRef(status);
  useEffect(() => {
    if (before.current === "working" && status !== "working") void load();
    before.current = status;
  }, [status, load]);

  if (open) return <FileChanges paneId={paneId} file={open} onBack={() => setOpen(null)} />;

  const repository = changes?.repository;
  return (
    <div className="changes">
      <div className="changes__head">
        <p className="changes__repo">
          {repository ? (
            <>
              <strong>{repository.name}</strong>{" "}
              <span className="changes__branch">{repository.branch ?? (repository.commit ? `detached at ${repository.commit}` : "detached")}</span>
            </>
          ) : "Changes"}
        </p>
        <button className="changes__refresh" onClick={() => void load()} disabled={loading}>
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      {error && <p className="changes__note" role="alert">{error}</p>}
      {!changes ? (
        !error && <div className="empty" role="status"><span className="empty__mark">⟳</span>Reading the changes…</div>
      ) : !repository ? (
        // Not a repository, or not one Shahi reads: said, not alarmed about.
        <div className="empty"><span className="empty__mark">○</span>{changes.note}</div>
      ) : changes.files.length === 0 ? (
        <div className="empty"><span className="empty__mark">○</span>No changes since the last commit.</div>
      ) : (
        <ul className="changes__files" aria-label="Changed files">
          {changes.note && <li className="changes__note">{changes.note}</li>}
          {changes.files.map((file) => (
            <li key={file.path}>
              <button className="changes__file" aria-label={changeSummary(file)} onClick={() => setOpen(file)}>
                <span className="changes__status" data-status={file.status} aria-hidden="true">{CHANGE_STATUS[file.status].letter}</span>
                <span className="changes__path" aria-hidden="true">
                  <span className="changes__dir">{folderOf(file.path)}</span><span className="changes__base">{nameOf(file.path)}</span>
                </span>
                {file.added !== null && (
                  <span className="changes__counts" aria-hidden="true">
                    <span className="changes__added">+{file.added}</span> <span className="changes__removed">−{file.removed}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!!changes?.omitted && <p className="changes__note">{`… ${changes.omitted.toLocaleString()} more ${changes.omitted === 1 ? "file" : "files"} not listed.`}</p>}
    </div>
  );
}

function FileChanges({ paneId, file, onBack }: { paneId: string; file: ChangedFile; onBack: () => void }) {
  const api = useApi();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);

  useEffect(() => {
    let live = true;
    setDiff(null);
    setError(null);
    api.fileDiff(paneId, file.path).then(
      (next) => { if (live) setDiff(next); },
      (err: unknown) => { if (live && !aborted(err)) setError(err instanceof Error ? err.message : "This file's changes could not be read."); },
    );
    return () => { live = false; };
  }, [api, paneId, file.path]);

  const rows = diff ? diffRows(diff.lines) : [];
  return (
    <div className="changes">
      <div className="changes__head">
        <button ref={back} className="changes__back" onClick={onBack}>‹ All changes</button>
      </div>
      <p className="changes__title">
        <span className="changes__status" data-status={file.status}>{CHANGE_STATUS[file.status].letter}</span>
        <span className="visually-hidden">{CHANGE_STATUS[file.status].label}: </span>
        <span className="changes__name">{file.path}</span>
        {file.from && <span className="changes__from"> from {file.from}</span>}
      </p>
      {error ? (
        <p className="changes__note" role="alert">{error}</p>
      ) : !diff ? (
        <div className="empty" role="status"><span className="empty__mark">⟳</span>Reading the diff…</div>
      ) : diff.note && rows.length === 0 ? (
        <div className="empty">{diff.note}</div>
      ) : (
        // Scrolls sideways rather than wrapping: a diff is lines of code, and
        // wrapped they no longer line up with their numbers or each other.
        <>
        <div className="diff" role="region" aria-label={`Changes to ${file.path}`} tabIndex={0}>
          {/* As wide as the longest line, so every row's colour reaches it. */}
          <div className="diff__lines">
            {rows.map((row, i) => (
              <div className="diff__row" data-kind={row.kind} key={i}>
                <span className="diff__num" aria-hidden="true">{row.oldLine ?? ""}</span>
                <span className="diff__num" aria-hidden="true">{row.newLine ?? ""}</span>
                <span className="diff__sign" aria-hidden="true">{SIGN[row.kind]}</span>
                {SPOKEN[row.kind] && <span className="visually-hidden">{SPOKEN[row.kind]}</span>}
                <span className="diff__text">{row.text || " "}</span>
              </div>
            ))}
          </div>
        </div>
        {diff.omitted > 0 && (
          <p className="changes__note">{`… ${diff.omitted.toLocaleString()}${diff.incomplete ? "+" : ""} more ${diff.omitted === 1 ? "line" : "lines"}, too many to show here.`}</p>
        )}
        </>
      )}
    </div>
  );
}

const SIGN: Record<string, string> = { added: "+", removed: "−", context: "", hunk: "", note: "" };
const SPOKEN: Record<string, string> = { added: "Added: ", removed: "Removed: ", note: "Note: " };

const folderOf = (path: string) => {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.includes("/") ? trimmed.slice(0, trimmed.lastIndexOf("/") + 1) : "";
};
const nameOf = (path: string) => path.slice(folderOf(path).length);

/** A request the connection itself abandoned, on a switch of computer: nothing to report. */
const aborted = (err: unknown) => err instanceof DOMException && err.name === "AbortError";
