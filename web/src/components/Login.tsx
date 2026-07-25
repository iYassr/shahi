import { useState } from "react";
import { api } from "../api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
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
    } catch {
      // The server does not distinguish between a wrong passcode and a
      // malformed one, and neither should this.
      setError("That passcode did not work.");
      setPasscode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="login" onSubmit={submit}>
      <h1 className="login__title">herdr</h1>
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
      {error && <p className="login__error">{error}</p>}
      <button type="submit" disabled={busy || passcode === ""}>
        {busy ? "Checking…" : "Unlock"}
      </button>
    </form>
  );
}
