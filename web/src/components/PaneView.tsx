import { browserConnection } from "../connection";
import { draftOwner, webDraft, notifyWebDraft } from "../drafts";
import type { SetStateAction } from "react";
import { UiIcon } from "./UiIcon";
import { useComputerControl } from "./ComputerUpdate";
import { supports } from "@shahi/shared";
/**
 * A single pane: its prompt, its live screen, its recorded history, and a way
 * to type into it.
 *
 * The key bar exists because a phone keyboard cannot produce Esc, Ctrl-C, Tab
 * or shift+Tab, and agents ask for all four. Those go through herdr's
 * `pane.send_keys`, which names keys rather than sending bytes.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { lazyChunk } from "../lazy-chunk";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  GAP_MARKER,
  ApiError,
  IncompatibleServerError,
  UnauthorizedError,
  useApi,
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
const Terminal = lazyChunk(() => import("./Terminal"));

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

/**
 * Counts the times another program has taken this pane id while it was open.
 *
 * herdr reuses pane ids, so the id in the address can come to name a new
 * conversation under an open view (see `DashboardPane.instanceId`). What the
 * view drew from the previous one — its reader, its detail — starts over when
 * this changes. Learning the occupant for the first time is not a change: a
 * view opened before the list loaded would otherwise reload for nothing.
 */
function useOccupancy(instanceId: string | undefined): number {
  const seen = useRef<{ instanceId?: string; generation: number }>({ generation: 0 });
  if (instanceId && seen.current.instanceId && instanceId !== seen.current.instanceId) seen.current.generation++;
  if (instanceId) seen.current.instanceId = instanceId;
  return seen.current.generation;
}

export function PaneView({ session, frames, prompts, onWatch, onAnswer, onToast }: Props) {
  const api = useApi();
  const control = useComputerControl();
  const { paneId = "" } = useParams();
  const navigate = useNavigate();
  /**
   * The occupant a notification was about. Tapped after herdr gave the pane id
   * to another program, it opened the new conversation with no notice
   * (pre-release bug hunt), so the view says the conversation has ended
   * instead, until the person asks for what runs there now.
   */
  const [searchParams] = useSearchParams();
  const notifiedFor = searchParams.get("instance");
  const [openAnyway, setOpenAnyway] = useState(false);

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const retryPane = useRef<() => void>(() => {});
  // Reader is the default where it exists: on a phone the conversation is what
  // you came for, and the terminal is for when you need to see the real screen.
  // `readable` flips to false the moment the server says there is no transcript
  // — for example a newly started agent — and the view falls back to Screen.
  // Keep Read available so a transcript created later can be opened.
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
  const mounted = useRef(true);
  const actionInFlight = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const savedDraft = useRef(webDraft(draftOwner(browserConnection().identity), paneId)).current;
  const pending = useRef(savedDraft.pending);
  const [echo, setEcho] = useState<{ text: string; at: number } | null>(null);
  const [draft, setDraftState] = useState(savedDraft.text);
  function setDraft(value: SetStateAction<string>) {
    savedDraft.text = typeof value === "function" ? value(savedDraft.text) : value;
    setDraftState(savedDraft.text);
    notifyWebDraft(savedDraft);
  }
  const [sending, setSending] = useState(savedDraft.inFlight);
  const [attachments, setAttachmentsState] = useState<Attachment[]>(savedDraft.attachments);
  function setAttachments(value: SetStateAction<Attachment[]>) {
    savedDraft.attachments = typeof value === "function" ? value(savedDraft.attachments) : value;
    setAttachmentsState(savedDraft.attachments);
    notifyWebDraft(savedDraft);
  }
  useEffect(() => {
    const update = () => { setDraftState(savedDraft.text); setAttachmentsState(savedDraft.attachments); setSending(savedDraft.inFlight); pending.current = savedDraft.pending; };
    savedDraft.listeners.add(update);
    return () => { savedDraft.listeners.delete(update); };
  }, [savedDraft]);
  const [attaching, setAttaching] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // What the list already knew when you tapped it. Waiting for `api.pane` to
  // come back before drawing a header meant every pane opened on a blank bar,
  // however fast the request was.
  const known = session?.panes.find((pane) => pane.paneId === paneId) ?? null;
  const reportedPresent = known !== null;
  const instanceId = known?.instanceId ?? detail?.instanceId;
  const occupancy = useOccupancy(instanceId);
  const frame = frames[paneId] ?? detail?.frame ?? null;
  const prompt = prompts[paneId] ?? frame?.prompt ?? null;

  useEffect(() => {
    onWatch(paneId);
    return () => onWatch(null);
  }, [paneId, onWatch]);

  useEffect(() => {
    let live = true;
    let loading = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setGone(false);
    setDetail(null);
    setLoadError(null);
    const load = async () => {
      if (!live || loading) return;
      clearTimeout(retry);
      loading = true;
      try {
        const next = await api.pane(paneId);
        if (live) { setDetail(next); setLoadError(null); setGone(false); }
      } catch (err) {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) { setGone(true); return; }
        // The API already signals expired sessions to App. Do not turn that
        // into an unhandled promise rejection or a claim the pane was closed.
        if (err instanceof UnauthorizedError) { setLoadError("Please reconnect to your computer."); return; }
        // Retrying cannot help a version refusal; its words say what will.
        if (err instanceof IncompatibleServerError) { setLoadError(err.message); return; }
        setLoadError("Could not load this conversation. Reconnecting…");
        // Browser online can precede the relay reconnect. Keep recovering even
        // if that first online request still fails, without discarding the pane.
        retry = setTimeout(() => void load(), 2_000);
      } finally { loading = false; }
    };
    const reconnect = () => void load();
    retryPane.current = reconnect;
    window.addEventListener("online", reconnect);
    void load();
    return () => {
      live = false;
      clearTimeout(retry);
      window.removeEventListener("online", reconnect);
    };
  // Newly created panes may reach the live dashboard after an initial 404.
  // Retry on that membership transition, not on every dashboard refresh, and
  // when another program takes the pane id.
  }, [paneId, api, reportedPresent, occupancy]);

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
      if (actionInFlight.current || !mounted.current) return;
      actionInFlight.current = true;
      setSending(true);
      try {
        await action();
      } catch (err) {
        if (mounted.current) onToast(err instanceof Error ? err.message : failure);
      } finally {
        actionInFlight.current = false;
        if (mounted.current) setSending(false);
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

    if (actionInFlight.current || savedDraft.inFlight || !mounted.current) return;
    // The occupant rides with the operation id, so a retry is refused (409
    // pane_replaced) rather than typed into whatever took the pane id since.
    if (pending.current?.body !== body) pending.current = { body, id: requestId(), ...(instanceId ? { instanceId } : {}) };
    savedDraft.pending = pending.current;
    savedDraft.inFlight = true;
    notifyWebDraft(savedDraft);
    await send(async () => {
      try {
        await api.send(paneId, body, savedDraft.pending!.id, savedDraft.pending!.instanceId);
        savedDraft.pending = null;
        if (savedDraft.text === draft) savedDraft.text = "";
        savedDraft.attachments = savedDraft.attachments.filter(file => !attachments.some(sent => sent.path === file.path));
        if (mounted.current) setEcho({ text: body, at: Date.now() });
      } finally {
        savedDraft.inFlight = false;
        notifyWebDraft(savedDraft);
      }
    }, "Message not sent");
  }

  if (notifiedFor && instanceId && notifiedFor !== instanceId && !openAnyway) {
    return (
      <div className="detail">
        <header className="topbar">
          <button className="topbar__back" onClick={() => navigate("/")} aria-label="Back">
            ‹
          </button>
          <div className="detail__where">{paneId}</div>
        </header>
        <div className="empty" role="status">
          <span className="empty__mark">○</span>
          The conversation this notification was about has ended. Another
          program now runs in {paneId}.
          <button className="empty__action" onClick={() => setOpenAnyway(true)}>
            Open what runs there now
          </button>
          <button className="empty__action" onClick={() => navigate("/")}>
            Back to agents
          </button>
        </div>
      </div>
    );
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

  // Chosen by what runs in the pane, as the native app does, not by the tab
  // alone: herdr can bring an agent's pane back as a plain shell, and "Reply to
  // this agent…" over it had a reply typed into the shell as a command
  // (pre-release bug hunt).
  const shell = known ? !known.isAgent : detail ? !detail.agent : false;
  const placeholder = tab === "screen" ? "Send text to terminal…" : shell ? "Run a command…" : "Reply to this agent…";

  return (
    <div className={`detail${focused && tab === "screen" ? " detail--focused" : ""}`} data-screen={tab === "screen"} data-update-blocked={Boolean(draft || attachments.length || sending || attaching)}>
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

      {loadError && <div className="empty" role="status">
        {loadError}
        <button className="empty__action" onClick={() => retryPane.current()}>Try again</button>
      </div>}
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
        <button
            className="tab"
            role="tab"
            aria-selected={tab === "read"}
            onClick={() => { setReadable(true); setTab("read"); }}
          >
            <UiIcon name="read" size={17} /> Read
          </button>
        <button
          className="tab"
          role="tab"
          aria-selected={tab === "screen"}
          onClick={() => setTab("screen")}
        >
          <UiIcon name="screen" size={17} /> Screen
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
        <Reader key={`${paneId}#${occupancy}`} paneId={paneId} agent={known?.agent} activity={frame?.activity ?? null} echo={echo} onUnavailable={fallBack} />
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
              aria-label={({ esc: "Escape", "^C": "Interrupt (Control C)", "⇥": "Tab", "⇧⇥": "Shift Tab", "↑": "Up arrow", "↓": "Down arrow", "⏎": "Enter" }[label] ?? label)}
              className={tab === "screen" && label === "^C" ? "keys__interrupt" : undefined}
              title={label === "^C" ? "Interrupt the running process" : undefined}
              onClick={() => void send(() => api.sendKeys(paneId, keys, instanceId), `${label} not sent`)}
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
            hidden={!supports(control?.handshake ?? null, "attachments")}
            className="compose__attach"
            onClick={() => setAttaching(true)}
            aria-label="Attach a file"
          >
            +
          </button>
          {/* The wrapper repeats the draft, or the placeholder, in a hidden
              copy that sizes the box when the composer is narrow (see
              .compose__field in session.css). */}
          <div className="compose__field" data-value={draft || placeholder}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              rows={1}
              aria-label="Message"
            />
          </div>
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
