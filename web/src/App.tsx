import { NavigationIcon } from "./components/NavigationIcon";
import { Logo } from "./components/Logo";
import { browserConnection, forgetBrowser, hosted, restoreBrowser } from "./connection";
import { PairBrowser } from "./components/PairBrowser";
import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import {
  SessionSocket,
  UnauthorizedError,
  api,
  type LinkState,
  type PaneFrame,
  type ParsedPrompt,
  type Session,
  type SocketMessage,
} from "./api";
import { reloadIfStale } from "./version";
import { Dashboard } from "./components/Dashboard";
import { Login } from "./components/Login";
import { PaneView } from "./components/PaneView";
import { clearReaderMemory } from "./components/Reader";
import { Settings } from "./components/Settings";
import { NewAgent } from "./components/NewAgent";
import { Sheet } from "./components/Sheet";
import { PushPrompt } from "./components/PushPrompt";
import { SpaceDetail, Spaces } from "./components/Spaces";

export function App({ initialPairingCode = "" }: { initialPairingCode?: string }) {
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
  const [reachable, setReachable] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [frames, setFrames] = useState<Record<string, PaneFrame>>({});
  const [prompts, setPrompts] = useState<Record<string, ParsedPrompt>>({});
  const [link, setLink] = useState<LinkState>("connecting");
  const [toast, setToast] = useState<string | null>(null);
  const socketRef = useRef<SessionSocket | null>(null);
  const navigate = useNavigate();

  const showToast = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 3_000);
  }, []);

  const checkAuth = useCallback(() => {
    void restoreBrowser().then(() => {
      if (hosted && !browserConnection().identity) return { required: true, authenticated: false };
      return api.authStatus();
    })
      .then((s) => {
        setReachable(true);
        setAuthenticated(!s.required || s.authenticated);
      })
      .catch((err) => {
        setConnectionError(err instanceof Error ? err.message : "Could not contact Shahi");
        // A refused or timed-out request is the server being away; a 401 would
        // have resolved, not thrown.
        setReachable(false);
        setAuthenticated(false);
      });
  }, []);

  useEffect(() => {
    checkAuth();
    // Coming back onto the network should just work, without a manual retry.
    window.addEventListener("online", checkAuth);
    return () => window.removeEventListener("online", checkAuth);
  }, [checkAuth]);

  const onMessage = useCallback((msg: SocketMessage) => {
    switch (msg.type) {
      case "session":
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
    if (!authenticated) return;
    const socket = new SessionSocket(onMessage, (state) => {
      setLink(state);
      if (state === "lost") void api.session().catch(() => {});
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [authenticated, onMessage]);

  const watch = useCallback((paneId: string | null) => {
    socketRef.current?.watch(paneId);
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
        await api.answerPrompt(paneId, optionIndex, option.label);
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
        canReload: () => !hosted || !browserConnection().identity || browserConnection().remembered,
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

  if (authenticated === null) return null;
  if (!reachable) {
    return (
      <div className="app">
        <div className="empty">
          <span className="empty__mark">○</span>
          Cannot reach Shahi. {connectionError || "Check your connection and that the server or tunnel is running."}
          {hosted && <button className="empty__action" onClick={() => void forgetBrowser().then(() => { setReachable(true); setAuthenticated(false); })}>Forget this browser and pair again</button>}
          <button className="empty__action" onClick={checkAuth}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!authenticated) {
    if (hosted) return <PairBrowser initialCode={pairingCode} onConsumed={() => setPairingCode("")} onSuccess={() => { setReachable(true); setAuthenticated(true); }} />;
    return <Login onSuccess={() => {
      setReachable(true);
      setAuthenticated(true);
    }} />;
  }

  const blockedCount = session?.panes.filter((p) => p.status === "blocked").length ?? 0;

  return (
    <div className="app">
      {updateAvailable && <div className="banner" role="status">
        <span>A new version is ready. Reloading ends this session; you will need a fresh pairing code to reconnect.</span>
        <button onClick={() => location.reload()}>Reload and pair again</button>
        <button onClick={() => setUpdateAvailable(false)}>Later</button>
      </div>}
      <Routes>
        <Route path="/settings" element={<Settings onToast={showToast} onLogout={() => { setAuthenticated(false); setSession(null); setFrames({}); setPrompts({}); clearReaderMemory(); navigate("/"); }} />} />
        <Route
          path="/"
          element={
            <>
              <header className="topbar">
                <h1 className="topbar__title"><Logo size={28} /> Agents</h1>
                <button className="topbar__action" onClick={() => setNewAgent(true)}>+ New agent</button>
                <span className="topbar__spacer" />
                {blockedCount > 0 && (
                  <span className="link" style={{ color: "var(--accent)" }}>
                    {blockedCount} waiting
                  </span>
                )}
                <LinkState state={link} />
              </header>
              <PushPrompt onToast={showToast} />
              <Dashboard session={session} prompts={prompts} onAnswer={answer} />
            </>
          }
        />
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
          element={<SpaceDetail session={session} onToast={showToast} onChanged={refresh} />}
        />
        <Route
          path="/pane/:paneId"
          element={
            <PaneView
              session={session}
              frames={frames}
              prompts={prompts}
              onWatch={watch}
              onAnswer={answer}
              onToast={showToast}
            />
          }
        />
      </Routes>

      {newAgent && (selectedSpace && session?.workspaces.find((s) => s.workspaceId === selectedSpace)
        ? <NewAgent space={session.workspaces.find((s) => s.workspaceId === selectedSpace)!} onClose={() => { setNewAgent(false); setSelectedSpace(null); }} onToast={showToast} onStarted={(id) => { setNewAgent(false); setSelectedSpace(null); refresh(); navigate(`/pane/${encodeURIComponent(id)}`); }} />
        : <Sheet title="Choose a space" onClose={() => setNewAgent(false)}>
            {session?.workspaces.map((space) => <button className="row" key={space.workspaceId} onClick={() => setSelectedSpace(space.workspaceId)}>{space.label}</button>)}
            {!session?.workspaces.length && <button className="sheet__go" onClick={() => { setNewAgent(false); navigate("/spaces"); }}>Create a space first</button>}
          </Sheet>)}
      <TabBar blockedCount={blockedCount} spaceCount={session?.workspaces.length ?? 0} />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
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
function TabBar({ blockedCount, spaceCount }: { blockedCount: number; spaceCount: number }) {
  const { pathname } = useLocation();
  if (pathname.startsWith("/pane/") || pathname.startsWith("/space/")) return null;

  return (
    <nav className="tabbar">
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
