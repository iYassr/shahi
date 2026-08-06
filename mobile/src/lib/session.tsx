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
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { ParsedPrompt, Session, SocketMessage } from "@shahi/shared";
import { api, connection, SessionSocket, UnauthorizedError, type LinkState } from "@/lib/api";

const KEY = "shahi.connection";

interface Stored {
  baseUrl: string;
  cookie: string;
}

interface SessionValue {
  /** Null until the keychain has been read, so nothing flashes the wrong screen. */
  ready: boolean;
  connected: boolean;
  session: Session | null;
  prompts: Record<string, ParsedPrompt>;
  link: LinkState;
  error: string | null;
  /** Called by Connect once `api.login` has succeeded. */
  signIn: () => void;
  signOut: () => void;
  /** Ask the server for a fresh snapshot — after creating a space or a tab. */
  refresh: () => void;
  /** Puts a pane on the fast poll interval while it is on screen. */
  watch: (paneId: string | null) => void;
  /** Drops a remembered prompt once it has been answered. */
  clearPrompt: (paneId: string) => void;
  /** Conversations kept on top of the list, by pane id, per device. */
  pins: Set<string>;
  togglePin: (paneId: string) => void;
}

/** Pins live beside the connection in the keychain: same storage, same life. */
const PINS_KEY = "shahi.pins";

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [connected, setConnected] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [prompts, setPrompts] = useState<Record<string, ParsedPrompt>>({});
  const [link, setLink] = useState<LinkState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [pins, setPins] = useState<Set<string>>(new Set());
  const socketRef = useRef<SessionSocket | null>(null);

  // Restore before first paint of anything that depends on being signed in.
  useEffect(() => {
    void (async () => {
      try {
        const raw = await SecureStore.getItemAsync(KEY);
        if (raw) {
          const stored = JSON.parse(raw) as Stored;
          connection.baseUrl = stored.baseUrl;
          connection.cookie = stored.cookie;
          setConnected(true);
        }
      } catch {
        // A corrupt or unreadable entry just means signing in again.
      }
      try {
        const pinned = await SecureStore.getItemAsync(PINS_KEY);
        if (pinned) setPins(new Set(JSON.parse(pinned) as string[]));
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

  const onMessage = useCallback((msg: SocketMessage) => {
    if (msg.type === "session") {
      setSession(msg.session);
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
    }
  }, []);

  const signOut = useCallback(() => {
    void SecureStore.deleteItemAsync(KEY);
    connection.cookie = null;
    setConnected(false);
    setSession(null);
  }, []);

  const refresh = useCallback(() => {
    void api
      .session()
      .then(setSession)
      .catch((e: Error) => {
        // An expired cookie is not an error to display; it is a sign-out.
        if (e instanceof UnauthorizedError) signOut();
        else setError(e.message);
      });
  }, [signOut]);

  useEffect(() => {
    if (!connected) return;
    setError(null);
    refresh();
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
      socketRef.current?.ensureConnected();
      refresh();
    });
    return () => sub.remove();
  }, [connected, refresh]);

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      connected,
      session,
      prompts,
      link,
      error,
      refresh,
      signOut,
      signIn: () => {
        void SecureStore.setItemAsync(
          KEY,
          JSON.stringify({ baseUrl: connection.baseUrl, cookie: connection.cookie ?? "" }),
        );
        setConnected(true);
      },
      watch: (paneId) => socketRef.current?.watch(paneId),
      clearPrompt: (paneId) =>
        setPrompts((current) => {
          const next = { ...current };
          delete next[paneId];
          return next;
        }),
      pins,
      togglePin,
    }),
    [ready, connected, session, prompts, link, error, refresh, signOut, pins, togglePin],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
