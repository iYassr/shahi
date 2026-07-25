/**
 * Picks a working directory by browsing rather than typing.
 *
 * A path is the one field a new space really needs and the one thing a phone
 * keyboard is worst at. Directories you already have a space in are offered
 * first, since a new space is usually a sibling of an existing one.
 *
 * The value carried around is the **absolute** path, with `~` shown only for
 * display. herdr does not expand `~`; it silently substitutes $HOME instead, so
 * handing it a display path would put every new space in the wrong folder
 * without so much as an error.
 */
import { useEffect, useState } from "react";
import { api, type DirListing } from "../api";

export interface DirChoice {
  /** Absolute — this is what goes to herdr. */
  path: string;
  /** Collapsed to `~` — this is what the user reads. */
  display: string;
}

interface Props {
  value: DirChoice;
  onChange: (choice: DirChoice) => void;
  /** Places already in use, offered as one-tap shortcuts. */
  suggestions?: DirChoice[];
}

export function DirPicker({ value, onChange, suggestions = [] }: Props) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  // Resolve a shorthand value to its absolute form straight away, even if the
  // user never opens the browser. Without this the default `~` would reach
  // herdr unexpanded and quietly land the new space in the wrong folder.
  useEffect(() => {
    if (value.path.startsWith("/")) return;
    let live = true;
    void api
      .dirs(value.path)
      .then((d) => live && onChange({ path: d.path, display: d.display }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [value.path, onChange]);

  useEffect(() => {
    if (!browsing) return;
    let live = true;
    setError(null);
    void api
      .dirs(value.path)
      .then((d) => live && setListing(d))
      .catch(() => live && setError("Cannot open that folder"));
    return () => {
      live = false;
    };
  }, [value.path, browsing]);

  return (
    <div className="picker">
      <div className="picker__current">
        <span className="picker__path">{value.display}</span>
        <button className="picker__toggle" onClick={() => setBrowsing((b) => !b)}>
          {browsing ? "Done" : "Change"}
        </button>
      </div>

      {!browsing && suggestions.length > 0 && (
        <div className="picker__chips">
          {suggestions.slice(0, 6).map((choice) => (
            <button
              key={choice.path}
              className="picker__chip"
              data-active={choice.path === value.path}
              onClick={() => onChange(choice)}
            >
              {choice.display}
            </button>
          ))}
        </div>
      )}

      {browsing && (
        <div className="picker__browser">
          {error && <p className="picker__error">{error}</p>}

          {listing && listing.parent !== null && (
            <button
              className="picker__row"
              onClick={() =>
                onChange({
                  // The listing's own path minus its last segment, so the
                  // absolute form stays authoritative while climbing.
                  path: listing.path.slice(0, listing.path.lastIndexOf("/")) || "/",
                  display: listing.parent!,
                })
              }
            >
              <span className="picker__glyph">↰</span> {listing.parent}
            </button>
          )}

          {listing?.entries.length === 0 && (
            <p className="picker__empty">No folders in here. Use it as it is.</p>
          )}

          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              className="picker__row"
              onClick={() => onChange({ path: entry.path, display: entry.display })}
            >
              <span className="picker__glyph">/</span> {entry.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
