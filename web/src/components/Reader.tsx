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
import { Markdown } from "./Markdown";

/** How often to pull while the tab is open. The server caches on file size. */
const POLL_MS = 2_500;
const PAGE = 60;

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
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  /** What is on screen, so a poll can diff against it without re-rendering. */
  const shown = useRef<LogMessage[]>([]);

  const load = useCallback(async () => {
    try {
      const log = await api.sessionLog(paneId, { limit: PAGE });
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
    shown.current = [];
    setMessages([]);
    setLoading(true);
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

    case "image":
      // Fetched rather than inlined: one transcript here holds 3.3MB of base64
      // across 28 images, which would land in every reader response.
      return (
        <img
          className="msg__image"
          src={`/api/panes/${encodeURIComponent(paneId)}/image?ref=${encodeURIComponent(block.ref)}`}
          alt={`Image (${block.mediaType})`}
          loading="lazy"
        />
      );

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
                <img
                  key={ref}
                  className="msg__image"
                  src={`/api/panes/${encodeURIComponent(paneId)}/image?ref=${encodeURIComponent(ref)}`}
                  alt="Tool output image"
                  loading="lazy"
                />
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
