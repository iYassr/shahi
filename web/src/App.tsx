import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
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

  const answer = useCallback(
    async (paneId: string, optionIndex: number) => {
      try {
        await api.answerPrompt(paneId, optionIndex);
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
    [showToast],
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
                <h1 className="topbar__title">herdr</h1>
                <span className="topbar__spacer" />
                {blockedCount > 0 && (
                  <span className="link" style={{ color: "var(--peach)" }}>
                    {blockedCount} waiting
                  </span>
                )}
                <span className={`link link--${link}`}>
                  <span className="link__dot" />
                  {link === "live" ? "live" : link === "lost" ? "offline" : "…"}
                </span>
              </header>
              <PushPrompt onToast={showToast} />
              <Dashboard session={session} prompts={prompts} onAnswer={answer} />
            </>
          }
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
