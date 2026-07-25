/**
 * A single pane: its prompt, its live screen, its recorded history, and a way
 * to type into it.
 *
 * The key bar exists because a phone keyboard cannot produce Esc, Ctrl-C, Tab
 * or shift+Tab, and agents ask for all four. Those go through herdr's
 * `pane.send_keys`, which names keys rather than sending bytes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  GAP_MARKER,
  api,
  type PaneDetail,
  type PaneFrame,
  type ParsedPrompt,
  type TranscriptLine,
} from "../api";
import { AgentIcon } from "./AgentIcon";
import { Attach, formatSize, type Attachment } from "./Attach";
import { Prompt } from "./Prompt";
import { Reader } from "./Reader";
import { Terminal, fitScale } from "./Terminal";

type Tab = "read" | "screen" | "history";

interface Props {
  frames: Record<string, PaneFrame>;
  prompts: Record<string, ParsedPrompt>;
  onWatch: (paneId: string | null) => void;
  onAnswer: (paneId: string, optionIndex: number) => Promise<void>;
  onToast: (message: string) => void;
}

/** Keys a touch keyboard cannot produce but agents routinely ask for. */
const KEY_BAR: Array<{ label: string; keys: string[] }> = [
  { label: "esc", keys: ["Escape"] },
  { label: "⇥", keys: ["Tab"] },
  { label: "⇧⇥", keys: ["S-Tab"] },
  { label: "^C", keys: ["C-c"] },
  { label: "^D", keys: ["C-d"] },
  { label: "↑", keys: ["Up"] },
  { label: "↓", keys: ["Down"] },
  { label: "⏎", keys: ["Enter"] },
];

export function PaneView({ frames, prompts, onWatch, onAnswer, onToast }: Props) {
  const { paneId = "" } = useParams();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<PaneDetail | null>(null);
  // Reader is the default where it exists: on a phone the conversation is what
  // you came for, and the terminal is for when you need to see the real screen.
  // `readable` flips to false the moment the server says there is no transcript
  // — shells and non-Claude agents — and the view falls back for good.
  const [tab, setTab] = useState<Tab>("read");
  const [readable, setReadable] = useState(true);
  const [history, setHistory] = useState<TranscriptLine[]>([]);
  const [fitWidth, setFitWidth] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const frame = frames[paneId] ?? detail?.frame ?? null;
  const prompt = prompts[paneId] ?? frame?.prompt ?? null;

  useEffect(() => {
    onWatch(paneId);
    return () => onWatch(null);
  }, [paneId, onWatch]);

  useEffect(() => {
    let live = true;
    void api
      .pane(paneId)
      .then((d) => live && setDetail(d))
      .catch(() => live && onToast("Could not load that pane"));
    return () => {
      live = false;
    };
  }, [paneId, onToast]);

  useEffect(() => {
    if (tab !== "history") return;
    void api
      .transcript(paneId)
      .then((d) => setHistory(d.lines))
      .catch(() => onToast("Could not load history"));
  }, [tab, paneId, onToast]);

  const cols = detail?.layout?.area.width ?? 146;
  const rows = detail?.layout?.area.height ?? 42;

  // Measured rather than read off the ref during render: on first paint the ref
  // is still null, so a direct read silently fell back to the window width and
  // "Fit width" did nothing. An observer also keeps it honest through rotation
  // and the iOS keyboard opening.
  const [wrapWidth, setWrapWidth] = useState(0);
  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWrapWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWrapWidth(node.clientWidth);
    return () => observer.disconnect();
  }, [tab]);

  const scale = fitWidth && wrapWidth > 0 ? fitScale(cols, wrapWidth) : 1;

  const send = useCallback(
    async (action: () => Promise<unknown>, failure: string) => {
      setSending(true);
      try {
        await action();
      } catch {
        onToast(failure);
      } finally {
        setSending(false);
      }
    },
    [onToast],
  );

  async function submit() {
    const text = draft.trim();
    if (!text && attachments.length === 0) return;

    // Attachments become paths on their own lines. An agent cannot receive a
    // file over a terminal, but it can read one off disk, and a bare absolute
    // path is the least ambiguous way to point at it.
    const body = [...attachments.map((a) => a.path), text].filter(Boolean).join("\n");

    // Text and Enter are separate calls: sending them together would race the
    // agent's own input handling on a slow pane.
    await send(async () => {
      await api.sendText(paneId, body);
      await api.sendKeys(paneId, ["Enter"]);
      setDraft("");
      setAttachments([]);
    }, "Message not sent");
  }

  return (
    <div className="detail">
      <header className="topbar">
        <button className="topbar__back" onClick={() => navigate("/")} aria-label="Back">
          ‹
        </button>
        <div>
          <div className="detail__where">
            {detail?.pane?.cwd?.replace(/^\/home\/[^/]+/, "~") ?? paneId}
          </div>
          <div className="detail__task">
            {detail?.pane?.agent && <AgentIcon kind={detail.pane.agent} />}
            {frame?.prompt ? "Waiting on you" : paneId}
          </div>
        </div>
      </header>

      {prompt && (
        <section className="blocked" style={{ marginBottom: 0 }}>
          <p className="blocked__question" style={{ borderTop: "none", paddingTop: 14 }}>
            {prompt.question}
          </p>
          <Prompt
            prompt={prompt}
            disabled={sending}
            onAnswer={(index) => onAnswer(paneId, index)}
          />
        </section>
      )}

      <div className="tabs" role="tablist">
        {readable && (
          <button
            className="tab"
            role="tab"
            aria-selected={tab === "read"}
            onClick={() => setTab("read")}
          >
            Read
          </button>
        )}
        <button
          className="tab"
          role="tab"
          aria-selected={tab === "screen"}
          onClick={() => setTab("screen")}
        >
          Screen
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={tab === "history"}
          onClick={() => setTab("history")}
        >
          History
        </button>
      </div>

      {tab === "read" && readable ? (
        <Reader
          paneId={paneId}
          onUnavailable={() => {
            setReadable(false);
            setTab("screen");
          }}
        />
      ) : tab === "screen" ? (
        <>
          <div className="termwrap" ref={wrapRef}>
            {frame ? (
              <Terminal ansi={frame.ansi} cols={cols} rows={rows} scale={scale} />
            ) : (
              <div className="empty">
                <span className="empty__mark">⟳</span>
                Reading the pane…
              </div>
            )}
          </div>
          <div className="zoombar">
            <button aria-pressed={fitWidth} onClick={() => setFitWidth(true)}>
              Fit width
            </button>
            <button aria-pressed={!fitWidth} onClick={() => setFitWidth(false)}>
              Full size
            </button>
            <span>
              {cols}×{rows}
            </span>
          </div>
        </>
      ) : (
        <div className="transcript">
          {history.length === 0 ? (
            <div className="empty">
              <span className="empty__mark">○</span>
              No history recorded yet. Lines are captured as they scroll off the
              screen while the app is open.
            </div>
          ) : (
            history.map((line) =>
              line.text === GAP_MARKER ? (
                <span className="transcript__gap" key={line.seq}>
                  {GAP_MARKER} — this agent produced more than one screen between
                  reads
                </span>
              ) : (
                <span className="transcript__line" key={line.seq}>
                  {line.text || " "}
                </span>
              ),
            )
          )}
        </div>
      )}

      <div className="compose">
        <div className="keys">
          {KEY_BAR.map(({ label, keys }) => (
            <button
              key={label}
              onClick={() => void send(() => api.sendKeys(paneId, keys), `${label} not sent`)}
            >
              {label}
            </button>
          ))}
        </div>
        {attachments.length > 0 && (
          <div className="attached">
            {attachments.map((a) => (
              <span className="attached__chip" key={a.path}>
                <span className="attached__name">{a.name}</span>
                {a.size !== undefined && (
                  <span className="attached__size">{formatSize(a.size)}</span>
                )}
                <button
                  className="attached__x"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((c) => c.filter((x) => x.path !== a.path))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="compose__row">
          <button
            className="compose__attach"
            onClick={() => setAttaching(true)}
            aria-label="Attach a file"
          >
            +
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Reply to this agent…"
            rows={1}
            aria-label="Message"
          />
          <button
            className="compose__send"
            onClick={() => void submit()}
            disabled={sending || (draft.trim() === "" && attachments.length === 0)}
          >
            Send
          </button>
        </div>
      </div>

      {attaching && (
        <Attach
          startPath={detail?.pane?.cwd ?? "~"}
          onClose={() => setAttaching(false)}
          onAttach={(a) =>
            setAttachments((current) =>
              current.some((x) => x.path === a.path) ? current : [...current, a],
            )
          }
          onToast={onToast}
        />
      )}
    </div>
  );
}
