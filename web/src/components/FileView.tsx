/**
 * Opening a file the agent touched.
 *
 * The reader shows tool calls, and most of them name a path — Read, Write,
 * Edit. Knowing that `src/api.ts` was rewritten is useful; being able to look
 * at it without leaving the phone is the difference between reading about the
 * work and following it.
 *
 * Images and text open here, full screen. Everything else downloads, because a
 * spreadsheet is more use in Files than in a viewer this app would have to
 * write. Both go through the same endpoint; only the disposition differs.
 */
import { useEffect, useState } from "react";
import { api } from "../api";

interface Props {
  /** What to call it. The extension decides how it is shown. */
  name: string;
  /** Where to read it from. */
  url: string;
  /** Where to get a copy — usually the same bytes with a different disposition. */
  downloadUrl: string;
  onClose: () => void;
}

/** What the viewer can show rather than hand to the operating system. */
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const TEXTUAL =
  /\.(txt|md|log|json|ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|c|h|cpp|sh|bash|zsh|toml|ya?ml|css|scss|html?|xml|csv|sql|ini|conf|env|lock|diff|patch|svg)$/i;

export function FileView({ name, url, downloadUrl, onClose }: Props) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isImage = IMAGE.test(name);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  useEffect(() => {
    setError(null);
    if (isImage || !TEXTUAL.test(name)) return;
    let live = true;
    void api
      .textAt(url)
      .then((body) => live && setText(body))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [url, name, isImage]);

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={name}>
      <header className="viewer__bar">
        <button className="viewer__close" onClick={onClose} aria-label="Close">
          ‹
        </button>
        <span className="viewer__name">{name}</span>
        {/* A plain link, so the browser does the downloading — a fetch would
            mean holding the whole file in memory to hand it back to the same
            browser. */}
        <a className="viewer__get" href={downloadUrl} download={name}>
          Download
        </a>
      </header>

      <div className="viewer__body">
        {isImage && !error ? (
          <img
            className="viewer__image"
            src={url}
            alt={name}
            /* A broken image icon says nothing. The server's refusal does, so
               ask it why — this only ever runs on failure. */
            onError={() => {
              void api
                .textAt(url)
                .then(() => setError("That image could not be displayed."))
                .catch((err: Error) => setError(err.message));
            }}
          />
        ) : error ? (
          <div className="empty">
            <span className="empty__mark">○</span>
            {error}
            <a className="empty__action" href={downloadUrl} download={name}>
              Download it instead
            </a>
          </div>
        ) : text === null && TEXTUAL.test(name) ? (
          <div className="empty">
            <span className="empty__mark">⟳</span>
            Reading {name}…
          </div>
        ) : text !== null ? (
          <pre className="viewer__text">{text}</pre>
        ) : (
          <div className="empty">
            <span className="empty__mark">↓</span>
            Nothing here can show a {name.slice(name.lastIndexOf(".") + 1)} file. Download it and
            open it where it belongs.
          </div>
        )}
      </div>
    </div>
  );
}
