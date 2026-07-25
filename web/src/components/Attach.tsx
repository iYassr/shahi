/**
 * Attaching a file to a message.
 *
 * Both sources end in the same place — an absolute path in the message text —
 * because that is what an agent can actually act on. A photo from the phone is
 * uploaded to the server first and then referenced by path; a file already on
 * the server is referenced directly. Claude Code reads either with the same
 * tool, images included.
 *
 * The phone path is the one that matters day to day: photographing a whiteboard
 * or a screen and handing it to an agent is the thing you cannot do from a
 * laptop across the room.
 */
import { useEffect, useRef, useState } from "react";
import { api, type DirEntry, type DirListing } from "../api";
import { Sheet } from "./Sheet";

export interface Attachment {
  name: string;
  path: string;
  size?: number;
}

interface Props {
  /** Where to start browsing the server, usually the pane's own directory. */
  startPath: string;
  onClose: () => void;
  onAttach: (attachment: Attachment) => void;
  onToast: (message: string) => void;
}

type Source = "phone" | "server";

export function Attach({ startPath, onClose, onAttach, onToast }: Props) {
  const [source, setSource] = useState<Source>("phone");
  const [uploading, setUploading] = useState(false);
  const [path, setPath] = useState(startPath);
  const [listing, setListing] = useState<DirListing | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (source !== "server") return;
    let live = true;
    void api
      .dirs(path, { files: true })
      .then((d) => live && setListing(d))
      .catch(() => live && onToast("Cannot open that folder"));
    return () => {
      live = false;
    };
  }, [source, path, onToast]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const stored = await api.upload(file);
        onAttach({ name: stored.name, path: stored.path, size: stored.size });
      }
      onClose();
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Sheet title="Attach a file" onClose={onClose}>
      <div className="kinds" style={{ marginBottom: 16 }}>
        <button className="kind" data-active={source === "phone"} onClick={() => setSource("phone")}>
          From this phone
        </button>
        <button
          className="kind"
          data-active={source === "server"}
          onClick={() => setSource("server")}
        >
          On the server
        </button>
      </div>

      {source === "phone" ? (
        <>
          {/*
            * Two separate inputs rather than one: `capture` opens the camera
            * directly, which is the point of attaching from a phone, while the
            * plain input reaches the photo library and Files.
            */}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => void upload(e.target.files)}
          />
          <input
            id="herdrui-camera"
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => void upload(e.target.files)}
          />

          <button
            className="sheet__go"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            {uploading ? "Uploading…" : "Choose photo or file"}
          </button>

          <label className="bigaction" htmlFor="herdrui-camera" style={{ margin: "10px 0 0" }}>
            Take a photo
          </label>

          <p className="sheet__note">
            Uploaded to the server, then referenced by path so the agent can read it.
          </p>
        </>
      ) : (
        <>
          <div className="picker__current">
            <span className="picker__path">{listing?.display ?? path}</span>
          </div>

          <div className="picker__browser" style={{ maxHeight: 320 }}>
            {listing?.parent && (
              <button className="picker__row" onClick={() => setPath(listing.parent!)}>
                <span className="picker__glyph">↰</span> {listing.parent}
              </button>
            )}

            {listing?.entries.length === 0 && <p className="picker__empty">Nothing in here.</p>}

            {listing?.entries.map((entry) => (
              <EntryRow
                key={entry.path}
                entry={entry}
                onEnter={() => setPath(entry.display)}
                onPick={() => {
                  onAttach({ name: entry.name, path: entry.path, size: entry.size });
                  onClose();
                }}
              />
            ))}
          </div>

          <p className="sheet__note">Tap a file to attach it. Folders open.</p>
        </>
      )}
    </Sheet>
  );
}

function EntryRow({
  entry,
  onEnter,
  onPick,
}: {
  entry: DirEntry;
  onEnter: () => void;
  onPick: () => void;
}) {
  return (
    <button className="picker__row" onClick={entry.isDirectory ? onEnter : onPick}>
      <span className="picker__glyph">{entry.isDirectory ? "/" : "·"}</span>
      <span className="picker__rowname">{entry.name}</span>
      {!entry.isDirectory && entry.size !== undefined && (
        <span className="picker__size">{formatSize(entry.size)}</span>
      )}
    </button>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
