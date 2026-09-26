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
import { useApi, type DirEntry, type DirListing } from "../api";
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
  const api = useApi();
  const [source, setSource] = useState<Source>("phone");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const [path, setPath] = useState(startPath);
  const [listing, setListing] = useState<DirListing | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [remaining, setRemaining] = useState<File[]>([]);
  const owner = useRef(0);
  const uploadBusy = useRef(false);
  useEffect(() => {
    owner.current++;
    uploadBusy.current = false;
    setUploading(false);
    setRemaining([]);
    return () => { owner.current++; uploadAbort.current?.abort(); };
  }, [api]);

  useEffect(() => {
    if (source !== "server") return;
    let live = true;
    setListing(null);
    setError("");
    void api
      .dirs(path, { files: true })
      .then((d) => live && setListing(d))
      .catch(() => live && setError("Couldn’t open this folder. Try again or choose your home folder."));
    return () => {
      live = false;
    };
  }, [api, source, path, attempt]);

  async function upload(files: FileList | File[] | null) {
    if (!files?.length || uploadBusy.current) return;
    const generation = owner.current;
    const active = () => generation === owner.current;
    const batch = Array.from(files);
    let completed = 0;
    uploadBusy.current = true;
    setRemaining([]);
    setUploading(true);
    setProgress(null);
    const controller = new AbortController(); uploadAbort.current = controller;
    try {
      for (const file of batch) {
        if (!active()) return;
        const stored = await api.upload(file, { signal: controller.signal, onProgress: (sent, total) => { if (active()) setProgress(total ? Math.floor(sent / total * 100) : 100); } });
        if (!active()) return;
        onAttach({ name: stored.name, path: stored.path, size: stored.size });
        completed++;
      }
      if (active()) onClose();
    } catch (err) {
      if (active()) {
        setRemaining(batch.slice(completed));
        onToast(err instanceof Error ? err.message : "Upload failed");
      }
    } finally {
      if (active()) { uploadBusy.current = false; setUploading(false); }
    }
  }

  return (
    <Sheet title="Attach a file" onClose={onClose}>
      <div className="kinds" role="group" aria-label="Attach from" style={{ marginBottom: 16 }}>
        <button className="kind" data-active={source === "phone"} aria-pressed={source === "phone"} onClick={() => setSource("phone")}>
          From this device
        </button>
        <button
          className="kind"
          data-active={source === "server"}
          aria-pressed={source === "server"}
          onClick={() => setSource("server")}
        >
          On your computer
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
            disabled={uploading}
            onChange={(e) => { void upload(e.target.files); e.target.value = ""; }}
          />
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            disabled={uploading}
            onChange={(e) => { void upload(e.target.files); e.target.value = ""; }}
          />

          <button
            className="sheet__go"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            {uploading ? (progress === null ? "Uploading…" : `Uploading ${progress}%`) : "Choose photo or file"}
          </button>

          {/* A button, not a label for the hidden input: a label is not a
              control, so Tab skipped it and a screen reader read it as plain
              text (pre-release bug hunt). */}
          <button className="bigaction" style={{ margin: "10px 0 0" }} disabled={uploading} onClick={() => cameraInput.current?.click()}>
            Take a photo
          </button>

          {uploading && <button className="sheet__go" onClick={() => uploadAbort.current?.abort()}>Cancel upload</button>}
          {remaining.length > 0 && <button className="sheet__go" disabled={uploading} onClick={() => void upload(remaining)}>Retry remaining {remaining.length === 1 ? "file" : `${remaining.length} files`}</button>}
          <p className="sheet__note">
            Files are copied to your computer so the agent can read them.
          </p>
        </>
      ) : (
        <>
          <div className="picker__current">
            <span className="picker__path">{listing?.display ?? path}</span>
            <button className="picker__toggle" onClick={() => { setPath("~"); setAttempt(n => n + 1); }}>Home folder</button>
          </div>

          <div className="picker__browser" style={{ maxHeight: 320 }}>
            {error && <p className="picker__error" role="alert">{error} <button onClick={() => setAttempt(n => n + 1)}>Try again</button></p>}
            {!listing && !error && <p className="picker__empty" role="status">Opening folder…</p>}
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
