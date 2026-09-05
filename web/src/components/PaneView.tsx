/**
 * A single pane: its prompt, its live screen, its recorded history, and a way
 * to type into it.
 *
 * The key bar exists because a phone keyboard cannot produce Esc, Ctrl-C, Tab
 * or shift+Tab, and agents ask for all four. Those go through herdr's
 * `pane.send_keys`, which names keys rather than sending bytes.
 */
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  GAP_MARKER,
  UnauthorizedError,
  api,
  requestId,
  type Session,
  type PaneDetail,
  type PaneFrame,
  type ParsedPrompt,
  type TranscriptLine,
} from "../api";
import { AgentAvatar } from "./AgentAvatar";
import { Attach, formatSize, type Attachment } from "./Attach";
import { Prompt } from "./Prompt";
import { Reader } from "./Reader";
import { fitScale } from "../termfit";

/**
 * On demand, with the rest of xterm.js behind it: 170KB of the app's 240KB,
 * for a tab most visits never open.
 */
const Terminal = lazy(() => import("./Terminal"));

type Tab = "read" | "screen" | "history";

/** Gap between inserting text and pressing Enter. See `submit`. */


interface Props {
  /** The dashboard's own view of this pane, so the header can paint at once. */
  session: Session | null;
  frames: Record<string, PaneFrame>;
  prompts: Record<string, ParsedPrompt>;
  onWatch: (paneId: string | null) => void;
  onAnswer: (paneId: string, optionIndex: number) => Promise<void>;
  onToast: (message: string) => void;
}

/**
 * Keys a touch keyboard cannot produce but agents routinely ask for.
 *
 * The names are herdr's, and it is strict about them: `shift+tab` is accepted
 * and `S-Tab` is not — it answers `invalid_key`, which the key bar swallowed, so
 * the one key Claude Code uses for its permission modes silently did nothing.
 * Every name here has been sent to a live pane and accepted.
 */
const KEY_BAR: Array<{ label: string; keys: string[]; everywhere?: boolean }> = [
  // `everywhere` marks the two that earn their place in the reader. The rest
  // drive a terminal UI, and in the reader a menu is already a card with
  // tappable options — so they only appear on the Screen tab, where there is a
  // terminal to drive.
  { label: "esc", keys: ["Escape"], everywhere: true },
  { label: "^C", keys: ["C-c"], everywhere: true },
  { label: "⇥", keys: ["Tab"] },
  { label: "⇧⇥", keys: ["shift+tab"] },
  { label: "↑", keys: ["Up"] },
  { label: "↓", keys: ["Down"] },
  { label: "⏎", keys: ["Enter"] },
];

/*
 * `^D` was here and is not any more.
 *
 * It sends EOF: on a phone a mis-tap between `^C` and `↑` ends the pane's
 * shell, with no confirmation and nothing to undo. Anything it was good for can
 * be typed as `exit` in the composer, which at least requires meaning it.
 */

export function PaneView({ session, frames, prompts, onWatch, onAnswer, onToast }: Props) {
  const { paneId = "" } = useParams();
  const navigate = useNavigate();

  const [detail, setDetail] = useState<PaneDetail | null>(null);
  /**
   * Set when the server says this pane is not there.
   *
   * Which happens more than it sounds: a notification opens a pane that has
   * since been closed, or you return to a bookmarked one after the agent
   * finished. Before this, the view sat on "Reading the pane…" forever, with a
   * key bar and a composer aimed at nothing.
   */
  const [gone, setGone] = useState(false);
  // Reader is the default where it exists: on a phone the conversation is what
  // you came for, and the terminal is for when you need to see the real screen.
  // `readable` flips to false the moment the server says there is no transcript
  // — shells and non-Claude agents — and the view falls back for good.
  const [tab, setTab] = useState<Tab>("read");
  const [readable, setReadable] = useState(true);
  const [history, setHistory] = useState<TranscriptLine[]>([]);
  const [fitWidth, setFitWidth] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [focused, setFocused] = useState(false);
  const focusButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focused) return;
    const exit = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setFocused(false); focusButton.current?.focus(); }
    };
    window.addEventListener("keydown", exit);
    return () => window.removeEventListener("keydown", exit);
  }, [focused]);
  const pending = useRef<{ body: string; id: string } | null>(null);
  const [echo, setEcho] = useState<{ text: string; at: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attaching, setAttaching] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // What the list already knew when you tapped it. Waiting for `api.pane` to
  // come back before drawing a header meant every pane opened on a blank bar,
  // however fast the request was.
  const known = session?.panes.find((pane) => pane.paneId === paneId) ?? null;
  const frame = frames[paneId] ?? detail?.frame ?? null;
  const prompt = prompts[paneId] ?? frame?.prompt ?? null;

  useEffect(() => {
    onWatch(paneId);
    return () => onWatch(null);
  }, [paneId, onWatch]);

  useEffect(() => {
    let live = true;
    setGone(false);
    void api
      .pane(paneId)
      .then((d) => live && setDetail(d))
      .catch((err: unknown) => {
        // An expired session is not a missing pane. Rethrowing puts it in front
        // of the global handler, which returns to the passcode screen; treating
        // it as "gone" would have told you the pane had been closed when in
        // fact the app had simply been open for a fortnight.
        if (err instanceof UnauthorizedError) throw err;
        if (live) setGone(true);
      });
    return () => {
      live = false;
    };
  }, [paneId]);

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

  const scale = fitWidth && wrapWidth > 0 ? fitScale(cols, wrapWidth) : zoom;
  function adjustZoom(delta: number) {
    setZoom(Math.min(2, Math.max(0.25, Math.round((scale + delta) * 100) / 100)));
    setFitWidth(false);
  }

  /**
   * Stable, and that matters more than it looks.
   *
   * Passed inline, this was a new function on every render of this component —
   * and this component re-renders on every frame that arrives for the pane it
   * is watching, which is every 400ms. The reader's polling effect depends on
   * it, so the effect was being torn down and rebuilt continuously: the poll
   * restarted, and anything the reader was keeping went with it.
   */
  const fallBack = useCallback(() => {
    setReadable(false);
    setTab("screen");
  }, []);

  const send = useCallback(
    async (action: () => Promise<unknown>, failure: string) => {
      setSending(true);
      try {
        await action();
      } catch (err) {
        onToast(err instanceof Error ? err.message : failure);
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

    if (sending) return;
    if (pending.current?.body !== body) pending.current = { body, id: requestId() };
    await send(async () => {
      await api.send(paneId, body, pending.current!.id);
      setEcho({ text: body, at: Date.now() });
      pending.current = null;
      setDraft("");
      setAttachments([]);
    }, "Message not sent");
  }

  if (gone) {
    return (
      <div className={`detail${focused && tab === "screen" ? " detail--focused" : ""}`} data-screen={tab === "screen"}>
        <header className="topbar">
          <button className="topbar__back" onClick={() => navigate("/")} aria-label="Back">
            ‹
          </button>
          <div className="detail__where">{paneId}</div>
        </header>
        <div className="empty">
          <span className="empty__mark">○</span>
          This pane is gone. It was closed, or the agent in it finished and the
          tab went with it.
          <button className="empty__action" onClick={() => navigate("/")}>
            Back to agents
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`detail${focused && tab === "screen" ? " detail--focused" : ""}`} data-screen={tab === "screen"}>
      {/*
        * One line, and prose set as prose.
        *
        * The title was monospace at 14px, which wrapped to two lines and — with
        * the cwd above it and the tab row below — spent about a quarter of the
        * screen before any content, on the view you opened in order to read.
        * A task name is a sentence, not machine output; the path beside it is
        * the thing that wants a monospace face, and it is on the Screen tab
        * anyway, so it gets what is left over.
        */}
      <header className="topbar">
        <button className="topbar__back" onClick={() => navigate("/")} aria-label="Back">
          ‹
        </button>
        <h1 className="detail__task">
          {(detail?.pane?.agent ?? known?.agent) && (
            <AgentAvatar kind={detail?.pane?.agent ?? known?.agent} status={detail?.pane?.agent_status ?? known?.status ?? "unknown"} isAgent />
          )}
          <span className="detail__title">
            {frame?.prompt ? "Waiting on you" : (known?.title ?? paneId)}
          </span>
        </h1>
        <span className="detail__where">
          {detail?.pane?.cwd?.replace(/^\/home\/[^/]+/, "~") ?? known?.cwd ?? ""}
        </span>
      </header>

      {prompt && (
        <section className="blocked" style={{ marginBottom: 0 }}>
          <p className="blocked__question" style={{ borderTop: "none", paddingTop: 14 }}>
            {prompt.question}
          </p>
          {/* The command and the reason behind it: monospace, because it is a
              command, and scrollable rather than wrapped across the screen. */}
          {prompt.context && prompt.context.length > 0 && (
            <div className="asked__context">
              {prompt.context.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
            </div>
          )}
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
        <Reader key={paneId} paneId={paneId} activity={frame?.activity ?? null} echo={echo} onUnavailable={fallBack} />
      ) : tab === "screen" ? (
        <>
          <div className="termwrap" ref={wrapRef}>
            {frame ? (
              <Suspense
                fallback={
                  <div className="empty">
                    <span className="empty__mark">⟳</span>
                    Loading the terminal…
                  </div>
                }
              >
                <Terminal ansi={frame.ansi} cols={cols} rows={rows} scale={scale} />
              </Suspense>
            ) : (
              <div className="empty">
                <span className="empty__mark">⟳</span>
                Reading the pane…
              </div>
            )}
          </div>
          <div className="zoombar" role="group" aria-label="Terminal view controls">
            <button aria-label="Zoom out" title="Zoom out" disabled={scale <= 0.25} onClick={() => adjustZoom(-0.1)}>−</button>
            <button className="zoombar__percent" aria-label="Full size" title="Reset to 100%" aria-pressed={!fitWidth && zoom === 1} onClick={() => { setZoom(1); setFitWidth(false); }}>{Math.round(scale * 100)}%</button>
            <button aria-label="Zoom in" title="Zoom in" disabled={scale >= 2} onClick={() => adjustZoom(0.1)}>+</button>
            <button aria-pressed={fitWidth} onClick={() => setFitWidth(true)}>Fit width</button>
            <span className="zoombar__geometry" title="Terminal columns × rows">{cols}×{rows}</span>
            <button ref={focusButton} className="zoombar__focus" aria-label={focused ? "Exit focus view" : "Focus terminal"} title={focused ? "Exit focus view (Escape)" : "Focus terminal"} aria-pressed={focused} onClick={() => setFocused((value) => !value)}>
              {focused ? "Exit focus" : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></svg>}
            </button>
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
          {KEY_BAR.filter((key) => tab === "screen" || key.everywhere).map(({ label, keys }) => (
            <button
              key={label}
              className={tab === "screen" && label === "^C" ? "keys__interrupt" : undefined}
              title={label === "^C" ? "Interrupt the running process" : undefined}
              onClick={() => void send(() => api.sendKeys(paneId, keys), `${label} not sent`)}
            >
              {tab === "screen" ? ({ esc: "Esc", "^C": "Ctrl+C", "⇥": "Tab", "⇧⇥": "Shift+Tab", "⏎": "Enter" }[label] ?? label) : label}
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
            placeholder={tab === "screen" ? "Send text to terminal…" : "Reply to this agent…"}
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
