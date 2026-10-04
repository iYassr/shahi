import { useLocale } from "../i18n";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { browserConnection, selectBrowserComputer } from "../connection";
import { useComputers } from "./ComputerSwitcher";

export function OtherComputers() {
  const { t } = useLocale();
  const computers = useComputers().map(computer => ({ ...computer, name: computer.named ? computer.name : t("Your computer") }));
  const current = browserConnection().identity?.serverId;
  const [error, setError] = useState("");
  const navigate = useNavigate();
  return <div className="other-computers">
    {computers.filter(c => c.id !== current && c.state === "live").map(c => <button key={c.id} className="empty__action" onClick={() => {
      void selectBrowserComputer(c.id).then(() => navigate("/", { replace: true })).catch(e => setError(e.message));
    }}>{t("Open")}{" "}{c.name} {" "}{t("· Connected")}{c.waiting ? t("· {value0} waiting", { value0: c.waiting }) : ""}</button>)}
    {error && <p role="alert">{t(error)}</p>}
  </div>;
}
