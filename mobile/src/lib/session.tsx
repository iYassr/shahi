/**
 * One live connection for the whole app.
 *
 * The web client can afford a socket per screen — a browser tab is one screen.
 * A native app stacks them, and Agents, Spaces and an open pane are all mounted
 * at once; three sockets would mean three snapshots and three reconnect loops
 * fighting over the same server. So the mirror lives here, above the router,
 * and every screen reads it.
 *
 * It also remembers where the server is. Retyping a tailnet address and a
 * passcode on a phone keyboard at every cold start is the kind of friction that
 * stops an app being opened at all. The address and the session cookie both go
 * into the keychain rather than plain storage, because the cookie *is* the
 * credential — it grants full control of the herdr session.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { ParsedPrompt, Session, SocketMessage } from "@shahi/shared";
import { api, connection, SessionSocket, UnauthorizedError, type LinkState } from "@/lib/api";
import { closeTunnel, openTunnel } from "@/lib/tunnel";
import type { SshProfile } from "@/lib/ssh";

const KEY = "shahi.connection";

/**
 * What is kept in the keychain between launches.
 *
 * A direct connection remembers its address and cookie — the cookie *is* the
 * credential. An SSH connection remembers the whole profile instead: the local
 * tunnel port changes every launch, so the old base URL is worthless, and the
 * profile's passcode lets us re-open the tunnel and sign in fresh without
 * asking again. Both shapes live at the same key; `kind` tells them apart, and
 * an entry written before SSH existed has no `kind` and reads as direct.
 */
type Stored =
  | { kind?: "direct"; baseUrl: string; cookie: string }
  | { kind: "ssh"; ssh: SshProfile };

interface SessionValue {
  /** Null until the keychain has been read, so nothing flashes the wrong screen. */
  ready: boolean;
  connected: boolean;
  session: Session | null;
  prompts: Record<string, ParsedPrompt>;
  link: LinkState;
  /**
   * Why the session could not be read, when it could not. An `UnreachableError`
   * from `lib/api` when the server was never reached; the object rather than
   * its message, so a screen can tell that apart from a server that answered
   * with a failure.
   */
  error: Error | null;
  /** Called by Connect once `api.login` has succeeded on a direct connection. */
  signIn: () => void;
  /** Called by Connect after an SSH tunnel is open and login has succeeded. */
  signInSsh: (profile: SshProfile) => void;
  signOut: () => void;
  /**
   * Ask the server for a fresh snapshot — after creating a space or a tab.
   * Settles once the answer, or the failure, has been applied.
   */
  refresh: () => Promise<void>;
  /**
   * Reconnects the socket if it is down and re-reads the session. What coming
   * back to the app does, and what "Try again" does when the server could not
   * be reached — one path, so they cannot drift.
   */
  reconnect: () => Promise<void>;
  /** Puts a pane on the fast poll interval while it is on screen. */
  watch: (paneId: string | null) => void;
  /**
   * Fires whenever the server says a pane has something new: a pushed frame
   * (the screen changed) or a `log_changed` (the transcript file grew). The
   * reader treats both as "refresh now" rather than waiting for its own poll
   * tick — the second is what makes a reply appear as soon as the agent writes
   * it, not when the terminal happens to repaint.
   */
  onPaneFrame: (paneId: string, cb: () => void) => () => void;
  /** Drops a remembered prompt once it has been answered. */
  clearPrompt: (paneId: string) => void;
  /** Conversations kept on top of the list, by pane id, per device. */
  pins: Set<string>;
  togglePin: (paneId: string) => void;
  clearPins: () => void;
  /** Columns a pane's terminal opens at, before the fit buttons say otherwise. */
  terminalWidth: number;
  setTerminalWidth: (columns: number) => void;
  /**
   * The server address, as state rather than a read of the connection
   * module — a component render races the async restore, and a mutable
   * module field never tells React it changed. The pins bug, resisted.
   */
  server: string;
}

/** Pins live beside the connection in the keychain: same storage, same life. */
const PINS_KEY = "shahi.pins";
const WIDTH_KEY = "shahi.terminal-width";

/**
 * Preserves object identity across session snapshots.
 *
 * herdr's mirror is pushed whole every couple of seconds, so a naive
 * `setSession(next)` makes every pane, tab and space a new reference — and the
 * memoised rows, which compare props by reference, re-render regardless of
 * whether anything actually changed. This reuses the previous object for any
 * entry whose content is byte-for-byte the same (JSON is the cheap, correct
 * equality here — the wire types are plain data), so:
 *
 *  - a row whose pane is unchanged keeps its identity and its memo skips it;
 *  - a snapshot identical to the last returns the *previous* Session, so
 *    `setSession` sees the same reference and does not re-render at all.
 */
export function reconcileArray<T>(prev: T[], next: T[], key: (t: T) => string): T[] {
  const prevByKey = new Map(prev.map((t) => [key(t), t] as const));
  // Reuse the previous object for any entry with byte-identical content,
  // wherever it now sits. Then keep the previous array only when the result is
  // element-for-element the same (same refs, same order) — that catches
  // insertions, removals and reorders without ever indexing prev out of
  // bounds, which is what crashed when `next` was longer than `prev`.
  const out = next.map((n) => {
    const old = prevByKey.get(key(n));
    return old && JSON.stringify(old) === JSON.stringify(n) ? old : n;
  });
  const unchanged = out.length === prev.length && out.every((v, i) => v === prev[i]);
  return unchanged ? prev : out;
}

function reconcileSession(prev: Session | null, next: Session): Session {
  if (!prev) return next;
  const panes = reconcileArray(prev.panes, next.panes, (p) => p.paneId);
  const tabs = reconcileArray(prev.tabs, next.tabs, (t) => t.tabId);
  const workspaces = reconcileArray(prev.workspaces, next.workspaces, (w) => w.workspaceId);
  // Scalar fields (version, protocol, grouping, focus) rarely move; compare them
  // together, and if they and all three lists are unchanged, keep the previous
  // Session so nothing downstream re-renders.
  const scalarsSame =
    prev.version === next.version &&
    prev.protocol === next.protocol &&
    prev.defaultGrouping === next.defaultGrouping &&
    prev.focusedPaneId === next.focusedPaneId;
  if (scalarsSame && panes === prev.panes && tabs === prev.tabs && workspaces === prev.workspaces) {
    return prev;
  }
  return { ...next, panes, tabs, workspaces };
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

/**
 * The last-update clock, as an external store rather than context state.
 *
 * It ticks on every socket message (every ~2.5s), and only one screen reads it
 * (Settings, for its "updated N seconds ago" line). Kept in context, that tick
 * recreated the context value and re-rendered every screen on a timer — which
 * is what RN's VirtualizedList "slow to update" warning was reacting to. As a
 * store, only `useLastUpdate` subscribers wake.
 */
const lastUpdate = { at: null as number | null, listeners: new Set<() => void>() };
function markUpdated() {
  lastUpdate.at = Date.now();
  lastUpdate.listeners.forEach((fn) => fn());
}
export function useLastUpdate(): number | null {
  return useSyncExternalStore(
    (cb) => {
      lastUpdate.listeners.add(cb);
      return () => lastUpdate.listeners.delete(cb);
    },
    () => lastUpdate.at,
  );
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [prompts, setPrompts] = useState<Record<string, ParsedPrompt>>({});
  const [link, setLink] = useState<LinkState>("connecting");
  const [error, setError] = useState<Error | null>(null);
  const [pins, setPins] = useState<Set<string>>(new Set());
  // 100 columns: readable text that still shows most of a real line.
  const [terminalWidth, setWidth] = useState(100);
  const [server, setServer] = useState("");
  const socketRef = useRef<SessionSocket | null>(null);
  // Per-pane frame subscribers. A ref so `onMessage` (deps []) can reach them
  // without being recreated, which would tear the socket down every time.
  const frameListeners = useRef(new Map<string, Set<() => void>>());
  // The active SSH profile, when the connection is tunnelled — kept so sign-out
  // can tear the tunnel down and restore knows to re-open it.
  const sshProfile = useRef<SshProfile | null>(null);

  // Restore before first paint of anything that depends on being signed in.
  useEffect(() => {
    void (async () => {
      try {
        const raw = await SecureStore.getItemAsync(KEY);
        if (raw) {
          const stored = JSON.parse(raw) as Stored;
          if (stored.kind === "ssh") {
            // The tunnel's local port is gone with the last process, so re-open
            // it and sign in again from the remembered passcode. A failure here
            // (box down, key changed) surfaces on the Connect screen rather
            // than pretending to be signed in.
            sshProfile.current = stored.ssh;
            connection.baseUrl = await openTunnel(stored.ssh);
            connection.cookie = null;
            await api.login(stored.ssh.passcode);
            setServer(`ssh://${stored.ssh.username}@${stored.ssh.host}`);
            setConnected(true);
          } else {
            connection.baseUrl = stored.baseUrl;
            connection.cookie = stored.cookie;
            setServer(stored.baseUrl);
            setConnected(true);
          }
        }
      } catch {
        // A corrupt entry, a dead box or a rejected key all mean the same
        // thing to a cold start: show Connect. The tunnel, if it half-opened,
        // is closed so a retry starts clean.
        void closeTunnel();
      }
      try {
        const pinned = await SecureStore.getItemAsync(PINS_KEY);
        if (pinned) setPins(new Set(JSON.parse(pinned) as string[]));
        const width = await SecureStore.getItemAsync(WIDTH_KEY);
        if (width) setWidth(Number(width) || 100);
      } catch {
        // Lost pins are re-pinnable; nothing to surface.
      }
      setReady(true);
    })();
  }, []);

  const togglePin = useCallback((paneId: string) => {
    setPins((current) => {
      const next = new Set(current);
      if (next.has(paneId)) next.delete(paneId);
      else next.add(paneId);
      void SecureStore.setItemAsync(PINS_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const clearPins = useCallback(() => {
    setPins(new Set());
    void SecureStore.deleteItemAsync(PINS_KEY);
  }, []);

  const setTerminalWidth = useCallback((columns: number) => {
    setWidth(columns);
    void SecureStore.setItemAsync(WIDTH_KEY, String(columns));
  }, []);

  const onMessage = useCallback((msg: SocketMessage) => {
    // The freshness clock is an external store, not context state, so ticking
    // it on every socket message does not recreate the context value and
    // re-render every screen 2.5s — which RN's VirtualizedList "slow to update"
    // warning was pointing at. Only `useLastUpdate` consumers (Settings) wake.
    markUpdated();
    if (msg.type === "session") {
      // Reconcile against the last snapshot so unchanged panes/tabs/spaces keep
      // their object identity — the server sends a fresh JSON every ~2.5s, and
      // without this every row is a new reference and the memoised rows re-render
      // regardless. When nothing changed at all, reconcile returns the previous
      // Session unchanged and setSession bails out entirely (no re-render).
      setSession((prev) => reconcileSession(prev, msg.session));
      // A prompt belongs to a blocked agent; once it moves on, drop it so no
      // screen can offer answers to a question already answered.
      setPrompts((current) => {
        const next: Record<string, ParsedPrompt> = {};
        for (const pane of msg.session.panes) {
          if (pane.status !== "blocked") continue;
          const known = current[pane.paneId] ?? pane.prompt;
          if (known) next[pane.paneId] = known;
        }
        return next;
      });
    } else if (msg.type === "prompt") {
      setPrompts((current) => ({ ...current, [msg.paneId]: msg.prompt }));
    } else if (msg.type === "frame") {
      // A content change on some pane. Wake whoever is watching that exact pane
      // — the reader turns this into an immediate refresh, so a reply appears as
      // fast as the server sees it rather than on the next client tick.
      frameListeners.current.get(msg.frame.paneId)?.forEach((fn) => fn());
    } else if (msg.type === "log_changed") {
      // The transcript itself grew — the signal the reader actually wants,
      // since it is fed by the transcript and not the screen. Same wake-up.
      frameListeners.current.get(msg.paneId)?.forEach((fn) => fn());
    }
  }, []);

  const onPaneFrame = useCallback((paneId: string, cb: () => void) => {
    let set = frameListeners.current.get(paneId);
    if (!set) {
      set = new Set();
      frameListeners.current.set(paneId, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) frameListeners.current.delete(paneId);
    };
  }, []);

  const signOut = useCallback(() => {
    void SecureStore.deleteItemAsync(KEY);
    connection.cookie = null;
    setConnected(false);
    setSession(null);
    // Drop the SSH session with the app session — a live tunnel to a box you
    // signed out of is exactly what you did not ask to keep.
    if (sshProfile.current) {
      sshProfile.current = null;
      void closeTunnel();
    }
  }, []);

  const refresh = useCallback(() => {
    return api
      .session()
      .then((s) => {
        setSession((prev) => reconcileSession(prev, s));
        // A poll that succeeds clears a prior transient error, so one blip does
        // not leave the whole screen showing failure until the next unrelated
        // event — the "sticky error" this review flagged.
        setError(null);
      })
      .catch((e: Error) => {
        // An expired cookie is not an error to display; it is a sign-out.
        if (e instanceof UnauthorizedError) signOut();
        else setError(e);
      });
  }, [signOut]);

  const reconnect = useCallback(() => {
    socketRef.current?.ensureConnected();
    return refresh();
  }, [refresh]);

  useEffect(() => {
    if (!connected) return;
    setError(null);
    void refresh();
    const socket = new SessionSocket(onMessage, setLink);
    socket.connect();
    socketRef.current = socket;
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [connected, onMessage, refresh]);

  // Coming back from the background: the socket may have died while the app was
  // suspended, and iOS will not necessarily say so. Reconnect and re-read
  // rather than show hours-old agents as though they were current.
  useEffect(() => {
    if (!connected) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      void reconnect();
    });
    return () => sub.remove();
  }, [connected, reconnect]);

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      connected,
      session,
      prompts,
      link,
      error,
      refresh,
      reconnect,
      signOut,
      signIn: () => {
        sshProfile.current = null;
        void SecureStore.setItemAsync(
          KEY,
          JSON.stringify({ kind: "direct", baseUrl: connection.baseUrl, cookie: connection.cookie ?? "" }),
        );
        setServer(connection.baseUrl);
        setConnected(true);
      },
      // The SSH tunnel is already open and login has already succeeded by the
      // time Connect calls this — same contract as signIn, but it remembers the
      // profile (not a base URL, which is a throwaway local port) so a cold
      // start can rebuild the tunnel.
      signInSsh: (profile: SshProfile) => {
        sshProfile.current = profile;
        void SecureStore.setItemAsync(KEY, JSON.stringify({ kind: "ssh", ssh: profile }));
        setServer(`ssh://${profile.username}@${profile.host}`);
        setConnected(true);
      },
      watch: (paneId) => socketRef.current?.watch(paneId),
      onPaneFrame,
      clearPrompt: (paneId) =>
        setPrompts((current) => {
          const next = { ...current };
          delete next[paneId];
          return next;
        }),
      pins,
      togglePin,
      clearPins,
      terminalWidth,
      setTerminalWidth,
      server,
    }),
    [ready, connected, session, prompts, link, error, refresh, reconnect, signOut, onPaneFrame, pins, togglePin, clearPins, terminalWidth, setTerminalWidth, server],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
