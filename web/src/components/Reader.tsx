/**
 * Reader view: the agent's conversation, reflowed for a phone.
 *
 * Fed by Claude Code's own JSONL transcript rather than the terminal, which is
 * what makes reflowing possible at all — terminal output arrives pre-wrapped at
 * the server's width and cannot be rewrapped without mangling every diff and
 * table in it. Here the text is just text.
 *
 * Tool calls collapse to one tappable line. In a real transcript they are the
 * overwhelming majority of the traffic, and almost none of it is what you came
 * to read; burying it behind a tap is the difference between a readable
 * conversation and a wall of command output.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Activity, type LogBlock, type LogMessage } from "../api";
import { FileView } from "./FileView";
import { Markdown } from "./Markdown";

/** How often to pull while the tab is open. The server caches on file size. */
const POLL_MS = 2_500;

/** What a first look at a conversation is worth. */
const PAGE = 60;

/**
 * What a poll is worth.
 *
 * Only the tail of a conversation can change — an agent appends, and rewrites
 * at most the message it is still writing. Re-fetching all 60 messages every
 * 2.5 seconds to learn about the last one cost about 15KB a poll on a busy
 * pane; this asks for the tail and lets `merge` keep the rest.
 */
const TAIL = 12;

/**
 * The last conversation seen for each pane.
 *
 * Reopening a pane you were reading a minute ago should show it, not a spinner:
 * the poll will correct anything stale within 2.5 seconds, and starting from
 * the right place is worth far more than starting from nothing. Bounded,
 * because transcripts are not small.
 */
const remembered = new Map<string, LogMessage[]>();
const REMEMBER_PANES = 4;

interface Props {
  paneId: string;
  /** Live status from the pane's screen; null when the agent is not mid-turn. */
  activity: Activity | null;
  /** Called when this pane has no transcript, so the caller can fall back. */
  onUnavailable: () => void;
}

/**
 * The frames Claude Code cycles through in the terminal.
 *
 * Reused rather than substituted with a generic spinner: the reader should feel
 * like the same session you would see over SSH, and this is the shape that
 * session is already drawing.
 */
const SPINNER = ["✻", "✽", "✳", "✶", "✢", "·"];

/**
 * Folds a freshly polled page into what is already on screen.
 *
 * Anything the page does not mention is older than it and stays where it is;
 * everything the page does mention comes from the page, because the newest
 * message is still being written and its earlier version is stale.
 */
export function merge(current: LogMessage[], page: LogMessage[]): LogMessage[] {
  if (current.length === 0) return page;
  const fresh = new Set(page.map((m) => m.id));
  const older = current.filter((m) => !fresh.has(m.id));
  return older.length === 0 ? page : [...older, ...page];
}

/** Cheap identity for a rendered list: ids, shape, and how much text is in it. */
export function signature(messages: LogMessage[]): string {
  return messages
    .map((m) => `${m.id}:${m.blocks.length}:${textLength(m)}`)
    .join("|");
}

function textLength(message: LogMessage): number {
  let length = 0;
  for (const block of message.blocks) {
    if (block.kind === "text" || block.kind === "thinking") length += block.text.length;
    else if (block.kind === "tool") length += (block.result?.text.length ?? 0) + block.summary.length;
  }
  return length;
}

export function Reader({ paneId, activity, onUnavailable }: Props) {
  const [messages, setMessages] = useState<LogMessage[]>(() => remembered.get(paneId) ?? []);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(() => !remembered.has(paneId));
  const [loadingOlder, setLoadingOlder] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  /** What is on screen, so a poll can diff against it without re-rendering. */
  const shown = useRef<LogMessage[]>(remembered.get(paneId) ?? []);
  /** Mirrors `total` for the poll, which must not close over a stale value. */
  const knownTotal = useRef(0);

  const load = useCallback(async () => {
    try {
      // A full page when there is nothing on screen, the tail when there is.
      // If more arrived than the tail can bridge — a long silence, or a burst —
      // fall back to a full page rather than leaving a hole in the middle.
      const held = shown.current.length;
      const behind = knownTotal.current - held;
      const limit = held === 0 || behind > TAIL - 2 ? PAGE : TAIL;
      const log = await api.sessionLog(paneId, { limit });
      // Merged, not replaced. Replacing threw away everything "Load earlier"
      // had fetched — scroll up through a long conversation and 2.5 seconds
      // later you were back at the last page, with the view yanked along with
      // it. The poll only ever knows about the newest page; what came before it
      // is the reader's to keep.
      const next = merge(shown.current, log.messages);

      // And nothing re-renders unless something actually changed. A quiet
      // session polled every 2.5s otherwise rebuilt the entire conversation on
      // a timer, images and all, which is most of what made this feel unsteady
      // on a phone.
      if (signature(next) !== signature(shown.current)) {
        shown.current = next;
        setMessages(next);
      }
      if (remembered.size >= REMEMBER_PANES && !remembered.has(paneId)) {
        remembered.delete(remembered.keys().next().value!);
      }
      remembered.set(paneId, shown.current);
      knownTotal.current = log.total;
      setTotal(log.total);
      setLoading(false);
    } catch {
      onUnavailable();
    }
  }, [paneId, onUnavailable]);

  // Starting on a different pane is the only reason to throw away what is on
  // screen. Deliberately not part of the polling effect below: tying them
  // together meant any change in the poll's identity also wiped the view.
  useEffect(() => {
    const seed = remembered.get(paneId) ?? [];
    shown.current = seed;
    setMessages(seed);
    setLoading(seed.length === 0);
    pinnedToBottom.current = true;
  }, [paneId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Follow the conversation, but only while the reader is already at the
  // bottom — yanking the view away from something being read is worse than
  // missing the newest message.
  useEffect(() => {
    if (pinnedToBottom.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  async function loadOlder() {
    const oldest = messages[0];
    if (!oldest || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const index = total - messages.length;
      const older = await api.sessionLog(paneId, { limit: PAGE, before: index });
      shown.current = [...older.messages, ...shown.current];
      setMessages(shown.current);
    } catch {
      // Leave what is already loaded alone.
    } finally {
      setLoadingOlder(false);
    }
  }

  if (loading) {
    return (
      <div className="empty">
        <span className="empty__mark">⟳</span>
        Reading the conversation…
      </div>
    );
  }

  const hasOlder = total > messages.length;

  return (
    <div
      className="reader"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {hasOlder && (
        <button className="reader__more" onClick={() => void loadOlder()} disabled={loadingOlder}>
          {loadingOlder ? "Loading…" : `Load earlier (${total - messages.length} more)`}
        </button>
      )}

      {messages.map((message) => (
        <article key={message.id} className={`msg msg--${message.role}`}>
          <div className="msg__who">{message.role === "agent" ? "Agent" : "You"}</div>
          {message.blocks.map((block, index) => (
            <BlockView key={index} block={block} paneId={paneId} />
          ))}
        </article>
      ))}

      {activity && <Working activity={activity} />}

      <div ref={bottomRef} />
    </div>
  );
}

/** An image a tool returned — a screenshot, usually, and worth opening. */
function ResultImage({ paneId, imageRef }: { paneId: string; imageRef: string }) {
  const [viewing, setViewing] = useState(false);
  const src = api.imageUrl(paneId, imageRef);
  return (
    <>
      <button className="msg__zoom" onClick={() => setViewing(true)} aria-label="Open image">
        <img className="msg__image" src={src} alt="Tool output image" loading="lazy" />
      </button>
      {viewing && (
        <FileView name="image.png" url={src} downloadUrl={src} onClose={() => setViewing(false)} />
      )}
    </>
  );
}

/**
 * The live footer: what the agent is doing, while it is doing it.
 *
 * Sits below the last completed message because that is where the next one will
 * appear — it stands in for the message still being written.
 */
function Working({ activity }: { activity: Activity }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    // Matches the terminal's own cadence closely enough to read as the same
    // animation. Honours reduced motion by simply not advancing.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 220);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="working" role="status" aria-live="polite">
      <span className="working__spin" aria-hidden="true">
        {SPINNER[frame]}
      </span>
      <span className="working__verb">{activity.verb}</span>
      <span className="working__meta">
        {activity.elapsed}
        {activity.detail && ` · ${activity.detail}`}
      </span>
    </div>
  );
}

function BlockView({ block, paneId }: { block: LogBlock; paneId: string }) {
  const [open, setOpen] = useState(false);
  /** The file this block named, once you have asked to see it. */
  const [viewing, setViewing] = useState(false);

  switch (block.kind) {
    case "text":
      return (
        <div className="msg__text">
          <Markdown text={block.text} />
        </div>
      );

    case "thinking":
      // Collapsed by default: interesting when you want it, noise when you do not.
      return (
        <details className="msg__thinking">
          <summary>Thinking</summary>
          <p>{block.text}</p>
        </details>
      );

    case "image": {
      // Fetched rather than inlined: one transcript here holds 3.3MB of base64
      // across 28 images, which would land in every reader response.
      const src = api.imageUrl(paneId, block.ref);
      const name = `image.${block.mediaType.split("/")[1] ?? "png"}`;
      return (
        <>
          {/*
            * A button, not an image with a click handler.
            *
            * iOS Safari does not reliably deliver taps to non-interactive
            * elements — an `onClick` on an `<img>` fires in every desktop
            * browser and, on a phone, sometimes not at all. So the image that
            * was supposed to open full screen simply did nothing, and the only
            * way to see a screenshot was to download it. A real button has no
            * such ambiguity.
            */}
          <button className="msg__zoom" onClick={() => setViewing(true)} aria-label="Open image">
            <img
              className="msg__image"
              src={src}
              alt={`Image (${block.mediaType})`}
              loading="lazy"
            />
          </button>
          {viewing && (
            <FileView
              name={name}
              url={src}
              downloadUrl={src}
              onClose={() => setViewing(false)}
            />
          )}
        </>
      );
    }

    case "tool":
      return (
        <div className="tool">
          <button className="tool__head" onClick={() => setOpen((o) => !o)}>
            <span className="tool__caret" aria-hidden="true">
              {open ? "▾" : "▸"}
            </span>
            <span className="tool__name">{block.name}</span>
            <span className="tool__summary">{block.summary}</span>
            {block.result?.isError && <span className="tool__err">failed</span>}
          </button>

          {/*
            * A question the agent asked, shown in full and never collapsed.
            *
            * This is the agent talking to you, not a tool call: it showed as a
            * bare `AskUserQuestion` row with the choices thrown away, so from a
            * phone there was nothing to read and nothing to answer. Answering
            * still happens on the prompt card at the top — the terminal is what
            * the keystroke goes to — but at least the question is legible now.
            */}
          {block.questions?.map((question, i) => (
            <div className="asked" key={i}>
              <p className="asked__q">{question.text}</p>
              <ol className="asked__options">
                {question.options.map((option, n) => (
                  <li className="asked__option" key={n}>
                    {/* The number is in the markup rather than a CSS counter:
                        it is what you would press in the terminal, so it should
                        be selectable, readable aloud, and visible to a test. */}
                    <span className="asked__label">
                      <span className="asked__n">{n + 1}.</span> {option.label}
                    </span>
                    {option.description && (
                      <span className="asked__why">{option.description}</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ))}

          {/* The file the call named, if it named one. Outside the collapsed
              section deliberately: on a phone this is usually the part you
              wanted, and burying it behind a second tap defeats the point. */}
          {block.file && (
            <div className="tool__file">
              <button className="tool__open" onClick={() => setViewing(true)}>
                {block.file.name}
              </button>
              {/* The summary line above already carries the path; repeating it
                  here just crowded the row. */}
              <span className="tool__path" aria-hidden="true" />
              <a
                className="tool__get"
                href={api.fileUrl(block.file.path, { download: true })}
                download={block.file.name}
                aria-label={`Download ${block.file.name}`}
              >
                ↓
              </a>
            </div>
          )}

          {viewing && block.file && (
            <FileView
              name={block.file.name}
              url={api.fileUrl(block.file.path)}
              downloadUrl={api.fileUrl(block.file.path, { download: true })}
              onClose={() => setViewing(false)}
            />
          )}
          {open && block.result && (
            <>
              {block.result.text.trim() && (
                <pre className="tool__out" data-error={block.result.isError}>
                  {block.result.text}
                  {block.result.truncated && "\n… truncated"}
                </pre>
              )}
              {/* Reading a screenshot returns the image here rather than as a
                  block of the message, and it is usually the whole point of
                  having expanded the tool. */}
              {block.result.images.map((ref) => (
                <ResultImage key={ref} paneId={paneId} imageRef={ref} />
              ))}
              {!block.result.text.trim() && block.result.images.length === 0 && (
                <pre className="tool__out">(no output)</pre>
              )}
            </>
          )}
          {open && !block.result && <p className="msg__aside">Still running.</p>}
        </div>
      );
  }
}
