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
import { Dashboard } from "./components/Dashboard";
import { Login } from "./components/Login";
import { PaneView } from "./components/PaneView";
import { PushPrompt } from "./components/PushPrompt";
import { SpaceDetail, Spaces } from "./components/Spaces";

export function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
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

  useEffect(() => {
    void api
      .authStatus()
      .then((s) => setAuthenticated(!s.required || s.authenticated))
      .catch(() => setAuthenticated(false));
  }, []);

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

      case "status":
        break;
    }
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const socket = new SessionSocket(onMessage, setLink);
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
        // Where the cursor currently sits, so an arrow-based delivery knows how
        // far to walk. Unused by the digit strategy.
        const selected = prompts[paneId]?.options.find((o) => o.selected)?.index ?? 1;
        await api.answerPrompt(paneId, optionIndex, selected);
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

  // A session can expire while the app sits open on a home screen.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (event.reason instanceof UnauthorizedError) {
        setAuthenticated(false);
        navigate("/");
      }
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, [navigate]);

  if (authenticated === null) return null;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;

  const blockedCount = session?.panes.filter((p) => p.status === "blocked").length ?? 0;

  return (
    <div className="app">
      <Routes>
        <Route
          path="/"
          element={
            <>
              <header className="topbar">
                <h1 className="topbar__title">Agents</h1>
                <span className="topbar__spacer" />
                {blockedCount > 0 && (
                  <span className="link" style={{ color: "var(--peach)" }}>
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
                <h1 className="topbar__title">Spaces</h1>
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
              frames={frames}
              prompts={prompts}
              onWatch={watch}
              onAnswer={answer}
              onToast={showToast}
            />
          }
        />
      </Routes>

      <TabBar blockedCount={blockedCount} spaceCount={session?.workspaces.length ?? 0} />
      {toast && <div className="toast">{toast}</div>}
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
          ◐
        </span>
        Agents
        {blockedCount > 0 && <span className="tabbar__badge">{blockedCount}</span>}
      </NavLink>
      <NavLink to="/spaces" className="tabbar__item">
        <span className="tabbar__glyph" aria-hidden="true">
          ▤
        </span>
        Spaces
        <span className="tabbar__count">{spaceCount}</span>
      </NavLink>
    </nav>
  );
}
