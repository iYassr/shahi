import { Logo, Wordmark } from "./Logo";
import { useState } from "react";
import { ApiError, useApi } from "../api";
import { noticesUrl } from "../notices";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const api = useApi();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(passcode);
      onSuccess();
    } catch (err) {
      // The server does not distinguish between a wrong passcode and a
      // malformed one, and neither should this. Refusing sign-ins for a while
      // is different: blaming the passcode would send the owner to reset one
      // that works (pre-release review, September 2026).
      if (err instanceof ApiError && err.status === 429) {
        setError("Too many sign-in attempts are reaching this computer. Wait a moment, then try again.");
      } else {
        setError("That passcode did not work.");
        setPasscode("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1 className="login__title"><Logo size={40} /><Wordmark /></h1>
      <h2>Welcome back</h2>
      <p className="login__hint">
        Enter your passcode to reach the agents on this machine.
      </p>
      <input
        value={passcode}
        onChange={(e) => setPasscode(e.target.value)}
        type="password"
        inputMode="numeric"
        autoComplete="current-password"
        aria-label="Passcode"
        autoFocus
      />
      {error && <p className="login__error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || passcode === ""}>
        {busy ? "Checking…" : "Unlock"}
      </button>
      {/* Only the passcode's hash is kept, so a lost one is replaced rather
          than found; this page used to give no way back at all (pre-release
          review). The native SSH form says the same. */}
      <p className="login__help">
        Lost it? On this computer, run <code>herdr plugin action invoke shahi.reset-passcode</code>, then read the new
        one with <code>herdr plugin log list --plugin shahi</code>.
      </p>
      <p className="app-help__links"><a href={noticesUrl()} target="_blank" rel="noreferrer">Open-source licenses</a></p>
    </form>
  );
}
