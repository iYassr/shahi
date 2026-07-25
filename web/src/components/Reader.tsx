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
import { api, type LogBlock, type LogMessage } from "../api";
import { Markdown } from "./Markdown";

/** How often to pull while the tab is open. The server caches on file size. */
const POLL_MS = 2_500;
const PAGE = 60;

interface Props {
  paneId: string;
  /** Called when this pane has no transcript, so the caller can fall back. */
  onUnavailable: () => void;
}

export function Reader({ paneId, onUnavailable }: Props) {
  const [messages, setMessages] = useState<LogMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const log = await api.sessionLog(paneId, { limit: PAGE });
      setMessages(log.messages);
      setTotal(log.total);
      setLoading(false);
    } catch {
      onUnavailable();
    }
  }, [paneId, onUnavailable]);

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
      setMessages((current) => [...older.messages, ...current]);
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
            <BlockView key={index} block={block} />
          ))}
        </article>
      ))}

      <div ref={bottomRef} />
    </div>
  );
}

function BlockView({ block }: { block: LogBlock }) {
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
      return <p className="msg__aside">[{block.mediaType}]</p>;

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
            <pre className="tool__out" data-error={block.result.isError}>
              {block.result.text || "(no output)"}
              {block.result.truncated && "\n… truncated"}
            </pre>
          )}
          {open && !block.result && <p className="msg__aside">Still running.</p>}
        </div>
      );
  }
}
