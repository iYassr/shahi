import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { browserConnection, selectBrowserComputer } from "../connection";
import { useComputers } from "./ComputerSwitcher";

export function OtherComputers() {
  const computers = useComputers();
  const current = browserConnection().identity?.serverId;
  const [error, setError] = useState("");
  const navigate = useNavigate();
  return <div className="other-computers">
    {computers.filter(c => c.id !== current && c.state === "live").map(c => <button key={c.id} className="empty__action" onClick={() => {
      void selectBrowserComputer(c.id).then(() => navigate("/", { replace: true })).catch(e => setError(e.message));
    }}>Open {c.name} · Connected{c.waiting ? ` · ${c.waiting} waiting` : ""}</button>)}
    {error && <p role="alert">{error}</p>}
  </div>;
}
