import { useLocale } from "../i18n";
/**
 * Settings' Claude Code and Codex sections: how much of each plan is used,
 * from the computer this page is connected to, as the phone's Agents section
 * shows it. Codex reports its limits after every turn; Claude Code only to a
 * status line, which the switch here installs (server/lib/plan-usage.ts).
 */
import { planWindowNow, relativeTime, type PlanUsage, type ProviderUsage } from "@shahi/shared";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../api";
import { AgentIcon } from "./AgentIcon";

export function AgentUsage({ computer }: { computer: string }) {
  const { t } = useLocale();
  const api = useApi();
  const [usage, setUsage] = useState<PlanUsage | null>(null);
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  const load = useCallback(async () => {
    try { setUsage(await api.planUsage()); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Usage could not be read."); }
  }, [api]);
  // Both agents report after their own turns, so a minute is fresh enough.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  async function toggle(enabled: boolean) {
    setSwitching(true);
    try { setUsage(await api.setClaudePlanUsage(enabled)); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "Claude Code's settings could not be changed."); }
    finally { setSwitching(false); }
  }

  if (!usage) return <section><h2>{t("Agents")}</h2>{error ? <p className="settings__error" role="alert">{t(error)}</p> : <p>{t("Loading usage…")}</p>}</section>;
  const claude = usage.claude;
  return <>
    <section className="agent-usage" aria-label={t("Claude Code plan usage")}>
      <h2><AgentIcon kind="claude" size={16} /> Claude Code</h2>
      {claude.enabled && <Windows usage={claude.usage} empty={t("Appears after Claude Code's next reply on {value0}. Claude Code reports plan limits for Pro and Max plans.", { value0: computer })} source={t("Claude Code's last reply")} />}
      <label className="agent-usage__switch">
        <input type="checkbox" role="switch" checked={claude.enabled} disabled={switching} onChange={(e) => void toggle(e.target.checked)} />
        {t("Show plan usage")}</label>
      <p>{claude.enabled
        ? t("Shahi's status line in Claude Code reports these. Turn this off to put back the status line you had before.")
        : t("Adds a status line to Claude Code on this computer that reports your 5-hour and weekly limits. Claude Code then hides its footer hints, such as “esc to interrupt”; a status line you already have keeps working.")}</p>
      {error && <p className="settings__error" role="alert">{t(error)}</p>}
    </section>
    <section className="agent-usage" aria-label={t("Codex plan usage")}>
      <h2><AgentIcon kind="codex" size={16} /> Codex{usage.codex.usage?.plan && <span className="agent-usage__plan">{usage.codex.usage.plan.charAt(0).toUpperCase() + usage.codex.usage.plan.slice(1)}</span>}</h2>
      <Windows usage={usage.codex.usage} empty={t("Appears after Codex's next turn on {value0}.", { value0: computer })} source={t("Codex's last turn")} />
    </section>
  </>;
}

function Windows({ usage, empty, source }: { usage: ProviderUsage | null; empty: string; source: string }) {
  const { t, locale } = useLocale();
  if (!usage) return <p>{empty}</p>;
  const now = Date.now();
  return <>
    {usage.windows.map((window) => {
      const { percent, reset } = planWindowNow(window, now, locale);
      const duration = /^(\d+)-(day|hour|minute)$/.exec(window.label);
      const label = duration ? t(`{count}-${duration[2]}`, { count: duration[1]! }) : t(window.label);
      return <div className="agent-usage__window" key={label}>
        <div className="agent-usage__line"><span>{label}</span><span>{percent === null ? "—" : t("{value0}% used", { value0: percent })}</span></div>
        <div className="agent-usage__track" role="meter" aria-label={t("{value0} limit", { value0: label })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? t("No current reading") : t("{value0}% used", { value0: percent })}>
          <div className={`agent-usage__fill${percent !== null && percent >= 80 ? " agent-usage__fill--high" : ""}`} style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
        </div>
        {reset && <p className="agent-usage__reset">{reset}</p>}
      </div>;
    })}
    <p className="agent-usage__updated">{t("Updated")}{" "}{relativeTime(usage.observedAt, now, locale)}{t(", from")}{" "}{source}.</p>
  </>;
}
