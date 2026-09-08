import { ComputerSession } from "./computer-session";
import { type Reviewed, type DashboardPane } from "@shahi/shared";
/**
 * One live connection per saved computer, shared by all of its screens.
 *
 * A native app stacks screens, and Agents, Spaces and an open pane are all mounted
 * at once; three sockets would mean three snapshots and three reconnect loops
 * fighting over the same server. So the mirror lives here, above the router,
 * and every screen reads it.
 *
 * It also remembers how to reach the server. Re-pairing, or retyping SSH
 * credentials on a phone keyboard at every cold start, is the kind of friction
 * that stops an app being opened at all. What is remembered goes into the
 * keychain rather than plain storage, because it *is* the credential — it
 * grants full control of the herdr session.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { ParsedPrompt, Session } from "@shahi/shared";
import { api, connection, type Api, type Connection, type LinkState } from "@/lib/api";
import { hostOf } from "@/lib/errors";
import { closeRelay, type RelayIdentity } from "@/lib/relay";
import { configurePushProfile, forgetPushRegistration, restorePushRegistration } from "@/lib/push-registration";
import type { SshProfile } from "@/lib/ssh";
import { COMPUTERS_KEY, computerAddress, computerId, rememberComputer, type ComputerConnection, type ComputerSummary, type SavedComputer } from "./computers";

const KEY = "shahi.connection";

/**
 * What is kept in the keychain between launches.
 *
 * An SSH connection remembers the whole profile: the local tunnel port changes
 * every launch, so a base URL would be worthless, and the profile's passcode
 * lets us re-open the tunnel and sign in fresh without asking again. A relay
 * connection remembers the relay, the box's id and the device this phone became
 * when it paired — that device secret is the credential. Both shapes live at
 * the same key; `kind` tells them apart.
 */
type Stored = ComputerConnection;

interface SessionValue {
  api: Api;
  transport: Connection;
  revokeComputer: (id: string) => Promise<void>;
  computers: ComputerSummary[];
  addingComputer: boolean;
  activeComputerId: string | null;
  connectionKey: number;
  switchComputer: (id: string) => Promise<void>;
  addComputer: () => Promise<void>;
  reviewed: Reviewed;
  markReviewed: (pane: DashboardPane) => void;
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
  /** Called by Connect after an SSH tunnel is open and login has succeeded. */
  signInSsh: (profile: SshProfile) => void;
  /** Called by Connect once a pairing over a relay has answered with a device. */
  signInRelay: (identity: RelayIdentity) => void;
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
export { reconcileArray } from "./session-reconcile";

function relayLabel(identity: RelayIdentity): string {
  return `relay://${hostOf(identity.relay)}`;
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
  const [addingComputer, setAddingComputer] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const selected = useRef<string | null>(null);
  const [connectionKey, setConnectionKey] = useState(0);
  const [terminalWidth, setWidth] = useState(100);
  const [storageError, setStorageError] = useState<Error | null>(null);
  const [, render] = useState(0);
  const bank = useRef<SavedComputer[]>([]);
  const live = useRef(new Map<string, ComputerSession>());
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  const write = useCallback((task: () => Promise<void>) => {
    const next = writes.current.catch(() => undefined).then(task);
    writes.current = next;
    void next.catch(() => { if (mounted.current) setStorageError(new Error("Couldn't save your computers securely. Try again.")); });
    return next;
  }, []);
  const persist = useCallback(() => {
    const saved = JSON.stringify(bank.current);
    const current = bank.current.find(c => c.id === selected.current);
    return write(async () => {
      await SecureStore.setItemAsync(COMPUTERS_KEY, saved);
      if (current) await SecureStore.setItemAsync(KEY, JSON.stringify(current.connection));
      else await SecureStore.deleteItemAsync(KEY);
    });
  }, [write]);
  const paint = useCallback(() => { if (mounted.current) render(n => n + 1); }, []);
  function choose(id: string | null) {
    live.current.get(selected.current ?? "")?.watch(null);
    selected.current = id; setSelection(id); setConnectionKey(n => n + 1);
    const entry = id ? live.current.get(id) : undefined;
    // Only pairing and push registration use this temporary/default client.
    Object.assign(connection, entry?.connection ?? { baseUrl: "", cookie: null, relay: null });
    configurePushProfile(entry?.saved.connection.kind === "ssh" ? entry.saved.connection.ssh : null);
    lastUpdate.at = entry?.updatedAt ?? null;
    lastUpdate.listeners.forEach(fn => fn());
  }
  function forget(id: string) {
    live.current.get(id)?.dispose(); live.current.delete(id);
    bank.current = bank.current.filter(c => c.id !== id);
    if (selected.current === id) { choose(null); setAddingComputer(false); }
    void persist(); paint();
  }
  function ensure(saved: SavedComputer, adopted?: Connection): ComputerSession {
    let entry = live.current.get(saved.id);
    if (entry) { entry.saved = saved; return entry; }
    entry = new ComputerSession(saved, (visible = true) => {
      const current = live.current.get(saved.id);
      if (!current || !mounted.current) return;
      const name = current.session?.serverName;
      if (name && current.saved.name !== name) {
        current.saved = { ...current.saved, name };
        bank.current = bank.current.map(c => c.id === saved.id ? current.saved : c);
        const savedNames = JSON.stringify(bank.current);
        void write(() => SecureStore.setItemAsync(COMPUTERS_KEY, savedNames));
      }
      if (selected.current === saved.id) {
        lastUpdate.at = current.updatedAt; lastUpdate.listeners.forEach(fn => fn());
        Object.assign(connection, current.connection);
      }
      if (visible) paint();
    }, () => forget(saved.id), adopted);
    live.current.set(saved.id, entry);
    void entry.start();
    return entry;
  }
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const [raw, saved, width, oldPins] = await Promise.all([KEY, COMPUTERS_KEY, WIDTH_KEY, PINS_KEY].map(key => SecureStore.getItemAsync(key)));
        if (cancelled) return;
        bank.current = saved ? JSON.parse(saved) : [];
        const current: Stored | null = raw ? JSON.parse(raw) : null;
        if (current) bank.current = rememberComputer(bank.current, current, undefined, bank.current.find(c => c.id === computerId(current))?.pins ?? (oldPins ? JSON.parse(oldPins) : []));
        if (width) setWidth(Number(width) || 100);
        // Each connection starts independently: an offline computer cannot
        // delay restoring another one or opening the computer chooser.
        bank.current.forEach(saved => ensure(saved));
        if (current) choose(computerId(current));
      } catch { /* An unreadable keychain still permits explicit pairing. */ }
      if (!cancelled) setReady(true);
    })();
    const sub = AppState.addEventListener("change", state => {
      if (state === "active") for (const entry of live.current.values()) void entry.reconnect();
    });
    return () => {
      cancelled = true; mounted.current = false; sub.remove();
      for (const entry of live.current.values()) entry.dispose();
      live.current.clear();
    };
  }, []);
  const entry = selection ? live.current.get(selection) : undefined;
  const switchComputer = async (id: string) => {
    const target = bank.current.find(c => c.id === id);
    if (!target) throw new Error("That computer is no longer saved. Pair it again.");
    // A failed secure-store write leaves the current view and connection intact.
    await write(() => SecureStore.setItemAsync(KEY, JSON.stringify(target.connection)));
    ensure(target); setAddingComputer(false); choose(id);
  };
  const addComputer = async () => {
    await write(() => SecureStore.deleteItemAsync(KEY));
    choose(null); setAddingComputer(true);
  };
  const signIn = (stored: Stored, adopted?: Connection) => {
    const id = computerId(stored);
    // A replacement grant supersedes only this computer's old connection.
    live.current.get(id)?.dispose(); live.current.delete(id);
    bank.current = rememberComputer(bank.current, stored);
    ensure(bank.current.find(c => c.id === id)!, adopted);
    setAddingComputer(false); choose(id); void persist();
  };
  const updatePins = (pins: string[]) => {
    if (!entry) return;
    entry.saved = { ...entry.saved, pins };
    bank.current = bank.current.map(c => c.id === entry.saved.id ? entry.saved : c);
    void persist(); paint();
  };
  const actions = useMemo(() => ({
    refresh: () => entry?.refresh() ?? Promise.resolve(), reconnect: () => entry?.reconnect() ?? Promise.resolve(),
    watch: (pane: string | null) => entry?.watch(pane),
    onPaneFrame: (pane: string, fn: () => void) => entry?.onPaneFrame(pane, fn) ?? (() => {}),
    clearPrompt: (pane: string) => entry?.clearPrompt(pane),
  }), [entry]);
  const value: SessionValue = {
    api: entry?.api ?? api, transport: entry?.connection ?? connection,
    ready, connected: !!entry, connectionKey, addingComputer, activeComputerId: selection,
    computers: bank.current.map(c => ({ id: c.id, name: c.name, serverId: c.connection.kind === "relay" ? c.connection.serverId : live.current.get(c.id)?.serverId, kind: c.connection.kind, address: computerAddress(c.connection), link: live.current.get(c.id)?.link ?? "connecting" })),
    switchComputer, addComputer,
    revokeComputer: async id => {
      const target = live.current.get(id);
      if (!target) return;
      if (target.saved.connection.kind !== "relay") throw new Error("SSH access is managed on that computer. Sign out to remove its saved login.");
      const deviceId = target.saved.connection.deviceId;
      try { await target.api.revokeDevice(deviceId); }
      catch (e) { if (live.current.has(id)) throw e; }
      forget(id);
    },
    signOut: () => { if (entry) { if (selected.current === entry.saved.id) void forgetPushRegistration(); forget(entry.saved.id); } },
    signInRelay: identity => {
      if (connection.relay?.auth.kind === "pairing") closeRelay(connection.relay);
      signIn({ kind: "relay", ...identity });
    },
    signInSsh: profile => {
      signIn({ kind: "ssh", ssh: profile }, { ...connection, relay: null });
      void restorePushRegistration(() => selected.current === computerId({ kind: "ssh", ssh: profile }));
    },
    session: entry?.session ?? null, prompts: entry?.prompts ?? {}, reviewed: entry?.reviewed ?? {},
    markReviewed: pane => entry?.markReviewed(pane),
    link: entry?.link ?? "connecting", error: storageError ?? entry?.error ?? null,
    ...actions,
    pins: new Set(entry?.saved.pins ?? []),
    togglePin: pane => updatePins(entry?.saved.pins.includes(pane) ? entry.saved.pins.filter(id => id !== pane) : [...(entry?.saved.pins ?? []), pane]),
    clearPins: () => updatePins([]), terminalWidth,
    setTerminalWidth: columns => { setWidth(columns); void SecureStore.setItemAsync(WIDTH_KEY, String(columns)); },
    server: entry ? (entry.saved.connection.kind === "relay" ? relayLabel(entry.saved.connection) : `ssh://${entry.saved.connection.ssh.username}@${entry.saved.connection.ssh.host}`) : "",
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
