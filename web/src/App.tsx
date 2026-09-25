import { ComputerSwitcher } from "./components/ComputerSwitcher";
import { ComputerUpdate, ComputerControlProvider } from "./components/ComputerUpdate";
import { Computers } from "./components/Computers";
import { connectionHealth } from "@shahi/shared";
import { UnreachableError } from "@shahi/shared/errors";
import { ConnectionHealth } from "./components/ConnectionHealth";
import { retainReviews, reviewKey, type Reviewed, type DashboardPane } from "@shahi/shared";
import { NavigationIcon } from "./components/NavigationIcon";
import { Logo } from "./components/Logo";
import { browserConnection, browserComputers, nameBrowserComputer, forgetBrowser, hosted, restoreBrowser, selectBrowserComputer, takePairingFragment } from "./connection";
import { listenForNotifications, openNotification } from "./notification-route";
import { forgetEndedConversations } from "./pane-occupants";
import { PairBrowser } from "./components/PairBrowser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  IncompatibleServerError,
  SessionSocket,
  UnauthorizedError,
  ApiContext, createApi, useApi,
  type LinkState,
  type PaneFrame,
  type ParsedPrompt,
  type Session,
  type SocketMessage,
} from "./api";
import { hasPendingWork, reloadIfStale, UPDATE_AVAILABLE } from "./version";
import { Dashboard } from "./components/Dashboard";
import { Login } from "./components/Login";
import { PaneView } from "./components/PaneView";
import { clearReaderMemory } from "./components/Reader";
import { Settings } from "./components/Settings";
import { NewAgent } from "./components/NewAgent";
import { Sheet } from "./components/Sheet";
import { PushPrompt } from "./components/PushPrompt";
import { SpaceDetail, Spaces } from "./components/Spaces";
import { OwnedRoute } from "./components/OwnedRoute";

export function App(props: { initialPairingCode?: string }) {
  const [epoch, setEpoch] = useState(0);
  const [restored, setRestored] = useState(!hosted);
  const navigate = useNavigate();
  useEffect(() => {
    void restoreBrowser().then(async () => {
      if (!window.location.pathname.endsWith("/notification")) return;
      const query = new URLSearchParams(window.location.search);
      await openNotification(query.get("pane"), query.get("computer"), (path) => navigate(path, { replace: true }), query.get("instance"));
    }).finally(() => setRestored(true));
    return listenForNotifications((pane, computer, instance) => {
      void restoreBrowser()
        // In place of the entry on screen when it switched computers: that
        // entry is the other computer's, and one Back away it could only be
        // refused (see OwnedRoute).
        .then(() => openNotification(pane, computer, (path, switched) => navigate(path, { replace: switched }), instance))
        .catch(() => navigate("/computers"));
    });
  }, []);
  const scopedApi = useMemo(() => { const owner = browserConnection(); return createApi(() => owner); }, [epoch, restored]);
  const [openPairing, setOpenPairing] = useState(!!props.initialPairingCode);
  /** A code from a `#pair=` link, held until it pairs, is cancelled, or another computer is chosen. */
  const [linkCode, setLinkCode] = useState(props.initialPairingCode ?? "");
  const followedLink = useRef("");
  useEffect(() => {
    const changed = (event: Event) => {
      clearReaderMemory();
      setOpenPairing(!!(event as CustomEvent).detail?.pairing);
      // A linked code belongs to the change its link asked for; choosing
      // some other computer leaves it behind.
      setLinkCode(followedLink.current);
      followedLink.current = "";
      setEpoch(value => value + 1);
    };
    window.addEventListener("shahi:computer-changed", changed);
    return () => window.removeEventListener("shahi:computer-changed", changed);
  }, []);
  /*
   * A pairing link followed in a tab that already shows the app.
   *
   * The fragment was read once, at load. Pasted into the address bar or
   * clicked in an open tab, a link changed nothing — the pairing form stayed
   * empty, and the one-time secret stayed in the address bar and the tab's
   * history (pre-release bug hunt, 2026-09). It is taken off the address the
   * same way now, and opens the same confirmation card, from a dashboard too,
   * by the route Add a computer takes.
   */
  useEffect(() => {
    const followed = () => {
      if (!/[#&]pair=/.test(window.location.hash)) return;
      const code = takePairingFragment();
      if (!code || !hosted) return;
      void restoreBrowser().then(() => {
        followedLink.current = code;
        return selectBrowserComputer(null);
      }).catch(() => { followedLink.current = ""; });
    };
    window.addEventListener("hashchange", followed);
    return () => window.removeEventListener("hashchange", followed);
  }, []);
  return restored ? <ApiContext.Provider value={scopedApi}><AppSession key={epoch} openPairing={openPairing} initialPairingCode={linkCode} onPairingConsumed={() => setLinkCode("")} /></ApiContext.Provider> : <Opening />;
}
function Opening() { return <div className="app" role="status">Opening Shahi…</div>; }
function AppSession({ initialPairingCode = "", openPairing = false, onPairingConsumed }: { initialPairingCode?: string; openPairing?: boolean; onPairingConsumed?: () => void }) {
  const api = useApi();
  const routeLocation = useLocation();
  const [pairingRequested] = useState(openPairing);
  const [showComputers, setShowComputers] = useState(false);
  const owner = useRef(browserConnection().generation);
  const active = () => owner.current === browserConnection().generation;
  const [pairingCode, setPairingCode] = useState(initialPairingCode);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [newAgent, setNewAgent] = useState(false);
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  /**
   * Whether the server answered at all.
   *
   * Distinct from being signed out, and the difference matters: launched with
   * the server unreachable — off the tailnet, or the box asleep — the app used
   * to show a passcode prompt, which invites you to type a passcode that cannot
   * possibly work.
   */
  const [connectionError, setConnectionError] = useState("");
  const [healthError, setHealthError] = useState<Error | null>(null);
  /*
   * A computer on another contract version is not reconnecting; it is
   * refusing. The live stream stops, as on mobile, because its pushes are in
   * a shape this build may misread and each one cleared the "Update needed"
   * notice. Only a request that succeeds — Retry, after updating — ends it.
   */
  const incompatible = healthError instanceof IncompatibleServerError;
  const [reachable, setReachable] = useState(true);
  const [session, storeSession] = useState<Session | null>(() => browserConnection().session);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  // The last real snapshot, updated as sessions arrive rather than as they
  // render, so two that land before a render are each compared with the one
  // before them.
  const lastSnapshot = useRef(session);
  const setSession = useCallback((next: Session | null) => {
    if (next) forgetEndedConversations(lastSnapshot.current, next);
    if (next?.version) lastSnapshot.current = next;
    storeSession(next);
  }, []);
  const [reviewed, setReviewed] = useState<Reviewed>({});
  useEffect(() => { setReviewed((current) => retainReviews(current, session?.panes ?? [])); }, [session]);
  const markReviewed = useCallback((pane: DashboardPane) => {
    if (pane.status === "done") setReviewed((current) => ({ ...current, [pane.paneId]: reviewKey(pane) }));
  }, []);
  const [frames, setFrames] = useState<Record<string, PaneFrame>>({});
  const [prompts, setPrompts] = useState<Record<string, ParsedPrompt>>({});
  // A New agent sheet whose space closed goes back to choosing one, rather
  // than reopening by itself for the next space herdr gives the same id
  // (pre-release bug hunt, B43).
  useEffect(() => {
    if (selectedSpace && session && !session.workspaces.some((space) => space.workspaceId === selectedSpace)) setSelectedSpace(null);
  }, [session, selectedSpace]);
  const [link, setLink] = useState<LinkState>("connecting");
  const [toast, setToast] = useState<string | null>(null);
  const socketRef = useRef<SessionSocket | null>(null);
  /*
   * The pane on screen, held here rather than only in the socket.
   *
   * A pane opened by URL — a reload, a bookmark, a notification — mounts in
   * the same commit as the socket, and a child's effect runs before its
   * parent's: PaneView asked to watch while there was no socket yet, the
   * request went nowhere, and the pane was never watched. Its Screen tab
   * kept its first frame, and an answered card stayed on screen with its
   * options disabled (pre-release bug hunt, 2026-09). Each new socket now
   * starts by watching whatever is on screen.
   */
  const watchedRef = useRef<string | null>(null);
  const navigate = useNavigate();

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3_000);
  }, []);

  const checkAuth = useCallback(() => {
    const expected = browserConnection().generation;
    const current = () => expected === browserConnection().generation;
    return restoreBrowser().then(() => {
      // A saved device is still paired while its computer is offline. Open
      // its dashboard immediately; requests report availability separately.
      if (hosted) return { required: true, authenticated: !!browserConnection().identity };
      return api.authStatus();
    })
      .then((s) => {
        if (!current()) return;
        setReachable(true);
        setHealthError(null);
        setAuthenticated(!s.required || s.authenticated);
      })
      .catch((err) => {
        if (!current()) return;
        setHealthError(err instanceof Error ? err : new Error("Connection failed"));
        setConnectionError(err instanceof Error ? err.message : "Could not contact Shahi");
        // A refused or timed-out request is the server being away; a 401 would
        // have resolved, not thrown.
        if (!sessionRef.current) { setReachable(false); setAuthenticated(false); }
      });
  }, []);

  useEffect(() => {
    void checkAuth();
    // Coming back onto the network should just work, without a manual retry.
    window.addEventListener("online", checkAuth);
    return () => window.removeEventListener("online", checkAuth);
  }, [checkAuth]);

  /*
   * Launched while the computer is away, nothing else would ask again: the
   * live socket reconnects by itself but exists only once signed in, and the
   * wake handler below waits for that too. So "Cannot reach Shahi" said it
   * was reconnecting and made no request at all until someone pressed Try
   * again — 45 seconds and two wake events, zero requests (pre-release bug
   * hunt, 2026-09). Ask again on a backoff capped at 30 seconds, one request
   * at a time, and at once when the page is shown again.
   */
  useEffect(() => {
    if (reachable) return;
    let stopped = false;
    let delay = 2_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => void checkAuth().finally(() => {
        if (stopped) return;
        delay = Math.min(delay * 2, 30_000);
        schedule();
      }), delay);
    };
    const wake = () => { if (document.visibilityState === "visible") void checkAuth(); };
    schedule();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", wake);
    };
  }, [reachable, checkAuth]);

  const onMessage = useCallback((msg: SocketMessage) => {
    switch (msg.type) {
      case "session":
        setHealthError((current) => current instanceof IncompatibleServerError ? current : null);
        setSession(msg.session);
        setPrompts((current) => {
          const next: Record<string, ParsedPrompt> = {};
          for (const pane of msg.session.panes) {
            // A prompt belongs to a blocked agent. Anything else is dropped, so
            // the dashboard cannot offer answers to a question already answered.
            if (pane.status !== "blocked") continue;
            // The payload carries the prompt, which is what lets a cold load —
            // opening from a notification — show answers straight away. A live
            // frame may still be fresher, so it wins.
            const known = current[pane.paneId] ?? pane.prompt;
            if (known) next[pane.paneId] = known;
          }
          return next;
        });
        break;

      case "frame":
        setFrames((current) => ({ ...current, [msg.frame.paneId]: msg.frame }));
        if (msg.frame.prompt) {
          setPrompts((current) => ({ ...current, [msg.frame.paneId]: msg.frame.prompt! }));
        }
        break;

      case "prompt":
        setPrompts((current) => ({ ...current, [msg.paneId]: msg.prompt }));
        break;

      case "log_changed":
        window.dispatchEvent(new CustomEvent("shahi:log_changed", { detail: msg.paneId }));
        break;
      case "status":
        break;
    }
  }, []);

  useEffect(() => {
    if (!authenticated || incompatible) return;
    const socket = new SessionSocket(msg => { if (active()) onMessage(msg); }, (state) => {
      if (!active()) return;
      setLink(state);
      if (state === "lost") void api.session().then((s) => { setSession(s); setHealthError(null); }).catch((e) => setHealthError(e instanceof Error ? e : new Error("Connection failed")));
    });
    socketRef.current = socket;
    socket.connect();
    if (watchedRef.current) socket.watch(watchedRef.current);
    // Authentication may open the relay before the screen subscribes. Fetch
    // a snapshot explicitly so an early push cannot leave this computer empty.
    void api.session().then(next => { if (active()) setSession(next); }).catch(error => {
      if (active()) setHealthError(error instanceof Error ? error : new Error("Connection failed"));
    });
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [authenticated, onMessage, incompatible]);

  const watch = useCallback((paneId: string | null) => {
    watchedRef.current = paneId;
    socketRef.current?.watch(paneId);
  }, []);

  const retryConnection = useCallback(async () => {
    socketRef.current?.ensureConnected();
    try { const next = await api.session(); setSession(next); setHealthError(null); }
    catch (e) { setHealthError(e instanceof Error ? e : new Error("Connection failed")); }
  }, []);

  // After creating something, pull the session straight away rather than
  // waiting up to a few seconds for the server's next snapshot to land.
  const refresh = useCallback(() => {
    void api
      .session()
      .then(setSession)
      .catch(() => showToast("Could not refresh"));
  }, [showToast]);

  const answer = useCallback(
    async (paneId: string, optionIndex: number) => {
      try {
        const option = prompts[paneId]?.options.find((o) => o.index === optionIndex);
        if (!option) throw new Error("That prompt changed. Wait for the latest question.");
        const instanceId = sessionRef.current?.panes.find((pane) => pane.paneId === paneId)?.instanceId;
        await api.answerPrompt(paneId, optionIndex, option.label, prompts[paneId], instanceId);
        setFrames((current) => current[paneId] ? { ...current, [paneId]: { ...current[paneId]!, prompt: null } } : current);
        // The agent's next frame is what confirms it landed; clearing here keeps
        // the card from re-offering a question that is on its way out.
        setPrompts((current) => {
          const next = { ...current };
          delete next[paneId];
          return next;
        });
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Could not send that");
        throw err;
      }
    },
    [showToast, prompts],
  );

  /**
   * Coming back to the app.
   *
   * A PWA on a home screen spends most of its life suspended, and iOS does not
   * reliably tell a suspended page that its socket died. Returning to a screen
   * full of hours-old agents was the single most misleading thing this app did,
   * so returning now forces the connection open and pulls a fresh session
   * rather than waiting for something to change.
   */
  useEffect(() => {
    if (!authenticated) return;
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      socketRef.current?.ensureConnected();
      void api.session().then(setSession).catch(() => {});
      // And pick up a new build, rather than running whatever was current when
      // the app was last launched — which on a phone can be days ago.
      void reloadIfStale(Date.now, {
        canReload: () => !hasPendingWork() && (!hosted || browserComputers().every(computer => computer.remembered)),
        onAvailable: () => setUpdateAvailable(true),
      });
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("pageshow", wake);
    };
  }, [authenticated]);

  // A chunk that failed to load because a newer release replaced it: offer the
  // update rather than reloading under someone's feet.
  useEffect(() => {
    const available = () => setUpdateAvailable(true);
    window.addEventListener(UPDATE_AVAILABLE, available);
    return () => window.removeEventListener(UPDATE_AVAILABLE, available);
  }, []);

  // A session can expire while the app sits open on a home screen.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof UnauthorizedError) {
        setAuthenticated(false);
        navigate("/");
      }
    };
    const expired = () => { setAuthenticated(false); setSession(null); setFrames({}); setPrompts({}); clearReaderMemory(); navigate("/"); };
    window.addEventListener("shahi:unauthorized", expired);
    window.addEventListener("unhandledrejection", onRejection);
    return () => { window.removeEventListener("unhandledrejection", onRejection); window.removeEventListener("shahi:unauthorized", expired); };
  }, [navigate]);

  useEffect(() => { if (session?.serverName && hosted) nameBrowserComputer(session.serverName); }, [session?.serverName]);
  // Until the first auth answer. Drawing nothing here left the locally served
  // app a blank page for up to the check's fifteen-second deadline behind a
  // half-open SSH tunnel, which is the "blank" refresh shape (pre-release
  // review, 2026-09). The deadline then shows "Cannot reach Shahi" and Try again.
  if (authenticated === null) return <Opening />;
  if (hosted && !authenticated && !pairingRequested && browserComputers().length > 0) {
    return <div className="app"><Computers /></div>;
  }
  if (showComputers || routeLocation.pathname === "/computers") return <div className="app"><Computers onClose={() => { setShowComputers(false); navigate("/"); }} /></div>;
  const computerButton = hosted && browserComputers().length > 0 ? <ComputerSwitcher onManage={() => setShowComputers(true)} /> : null;
  if (!reachable) {
    const health = connectionHealth({ link: "lost", error: healthError, transport: hosted ? "relay" : "direct", online: navigator.onLine });
    // Nothing has opened yet on this screen, so the general "your
    // conversation stays open… you don't need to pair again" was wrong here,
    // and pairing means nothing to a passcode sign-in. A cause the connection
    // named keeps its own words.
    const named = !navigator.onLine || healthError instanceof IncompatibleServerError || healthError instanceof UnreachableError;
    return (
      <div className="app">
        <div className="empty">
          <span className="empty__mark">○</span>
          Cannot reach Shahi. {(named ? health?.detail : "Check that your computer is awake and Shahi is running. Shahi will keep trying.") || connectionError}
          {computerButton}
          {hosted && <button className="empty__action" onClick={() => void forgetBrowser().then(() => { setReachable(true); setAuthenticated(false); })}>Forget this browser and pair again</button>}
          <button className="empty__action" onClick={checkAuth}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!authenticated) {
    if (hosted) return <>{computerButton}<PairBrowser initialCode={pairingCode} onConsumed={() => { setPairingCode(""); onPairingConsumed?.(); }} onSuccess={() => { window.dispatchEvent(new CustomEvent("shahi:computer-changed", { detail: { pairing: false } })); }} /></>;
    return <Login onSuccess={() => {
      setReachable(true);
      setAuthenticated(true);
    }} />;
  }

  // Only the hosted app keeps more than one computer; see OwnedRoute.
  const computer = hosted ? browserConnection().identity?.serverId ?? null : null;
  const conversationLayout = routeLocation.pathname === "/" || routeLocation.pathname.startsWith("/pane/");
  const conversationOpen = routeLocation.pathname.startsWith("/pane/");
  const blockedCount = session?.panes.filter((p) => p.status === "blocked").length ?? 0;

  return (
    <ComputerControlProvider onRecovered={retryConnection}><div className="app">
      {updateAvailable && <div className="banner" role="status">
        <span>A new version is ready. Finish your work before reloading.{hosted && browserComputers().some(computer => !computer.remembered) && " Reloading forgets computers that were not remembered in this browser. Those computers will need a new pairing code."}</span>
        <button onClick={() => { if (!hasPendingWork() || window.confirm("Reload Shahi and discard your unfinished work?")) location.reload(); }}>{hosted && browserComputers().some(computer => !computer.remembered) ? "Reload and pair again" : "Reload Shahi"}</button>
        <button onClick={() => setUpdateAvailable(false)}>Later</button>
      </div>}
      {computerButton}
      <ComputerUpdate />
      <ConnectionHealth link={link} error={healthError} relay={hosted} onRetry={retryConnection} />
      <div className={conversationLayout ? "conversation-layout" : "page-layout"} data-conversation-open={conversationOpen}>
      {conversationLayout && <aside className="agent-sidebar" aria-label="Agent conversations">
              <header className="topbar">
                <h1 className="topbar__title"><Logo size={28} /> Agents</h1>
                <button className="topbar__action" onClick={() => setNewAgent(true)}>+ New agent</button>
                <span className="topbar__spacer" />
                {blockedCount > 0 && (
                  <span className="link topbar__waiting" style={{ color: "var(--accent)" }}>
                    {blockedCount} waiting
                  </span>
                )}
                <LinkState state={link} />
              </header>
              <PushPrompt onToast={showToast} />
              <Dashboard reviewed={reviewed} onReviewed={markReviewed} session={session} prompts={prompts} onAnswer={answer} />
        <TabBar allowPane blockedCount={blockedCount} spaceCount={session?.workspaces.length ?? 0} />
      </aside>}
      <main className="conversation-main">
      <Routes>
        <Route path="/settings" element={<Settings onComputers={() => setShowComputers(true)} onToast={showToast} onLogout={() => { setAuthenticated(false); setSession(null); setFrames({}); setPrompts({}); clearReaderMemory(); navigate("/"); }} />} />
        <Route path="/" element={<div className="conversation-welcome"><Logo size={64} /><h1>Your work, ready to continue</h1><p>Choose an agent on the left to read the conversation or send the next instruction.</p><span>Same session. Same computer.</span></div>} />
        <Route
          path="/spaces"
          element={
            <>
              <header className="topbar">
                <h1 className="topbar__title"><Logo size={28} /> Spaces</h1>
                <span className="topbar__spacer" />
                <LinkState state={link} />
              </header>
              <Spaces session={session} onToast={showToast} onChanged={refresh} />
            </>
          }
        />
        <Route
          path="/space/:workspaceId"
          element={<OwnedRoute computer={computer}><SpaceDetail session={session} onToast={showToast} onChanged={refresh} /></OwnedRoute>}
        />
        <Route
          path="/pane/:paneId"
          element={
            <OwnedRoute computer={computer}>
              <PaneView key={routeLocation.pathname}
                session={session}
                frames={frames}
                prompts={prompts}
                onWatch={watch}
                onAnswer={answer}
                onToast={showToast}
              />
            </OwnedRoute>
          }
        />
      </Routes>
      </main>
      </div>

      {newAgent && (selectedSpace && session?.workspaces.find((s) => s.workspaceId === selectedSpace)
        ? <NewAgent space={session.workspaces.find((s) => s.workspaceId === selectedSpace)!} onClose={() => { setNewAgent(false); setSelectedSpace(null); }} onToast={showToast} onStarted={(id) => { setNewAgent(false); setSelectedSpace(null); refresh(); navigate(`/pane/${encodeURIComponent(id)}`); }} />
        : <Sheet title="Choose a space" onClose={() => setNewAgent(false)}>
            {session?.workspaces.map((space) => <button className="row" key={space.workspaceId} onClick={() => setSelectedSpace(space.workspaceId)}>{space.label}</button>)}
            {!session?.workspaces.length && <button className="sheet__go" onClick={() => { setNewAgent(false); navigate("/spaces"); }}>Create a space first</button>}
          </Sheet>)}
      {!conversationLayout && <TabBar blockedCount={blockedCount} spaceCount={session?.workspaces.length ?? 0} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div></ComputerControlProvider>
  );
}

function LinkState({ state }: { state: LinkState }) {
  return (
    <span className={`link link--${state}`}>
      <span className="link__dot" />
      {state === "live" ? "live" : state === "lost" ? "offline" : "…"}
    </span>
  );
}

/**
 * Bottom navigation between the app's two halves, matching how herdr splits its
 * own sidebar. Bottom rather than top because that is where a thumb reaches.
 *
 * Hidden on the drill-in screens, which have their own back control and need
 * every row of height they can get for a terminal.
 */
function TabBar({ blockedCount, spaceCount, allowPane = false }: { blockedCount: number; spaceCount: number; allowPane?: boolean }) {
  const { pathname } = useLocation();
  if (!allowPane && (pathname.startsWith("/pane/") || pathname.startsWith("/space/"))) return null;

  return (
    <nav className="tabbar" aria-label="Main navigation">
      <NavLink to="/" className="tabbar__item" end>
        <span className="tabbar__glyph" aria-hidden="true">
          <NavigationIcon name="agents" />
        </span>
        Agents
        {blockedCount > 0 && <span className="tabbar__badge">{blockedCount}</span>}
      </NavLink>
      <NavLink to="/spaces" className="tabbar__item">
        <span className="tabbar__glyph" aria-hidden="true">
          <NavigationIcon name="spaces" />
        </span>
        Spaces
        <span className="tabbar__count">{spaceCount}</span>
      </NavLink>
      <NavLink to="/settings" className="tabbar__item"><span className="tabbar__glyph" aria-hidden="true"><NavigationIcon name="settings" /></span>Settings</NavLink>
    </nav>
  );
}
