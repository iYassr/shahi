// The computer's side, drawn: herdr's window with the same spaces and panes
// the phone lists, and the terminal running the installer.

import { ramp, typed, window } from "../motion";
import { c, mono } from "../theme";
import { QR } from "../launch/kit";
import { SETUP } from "./timeline";

/** The showcase's spaces and, for tasks-web, its four panes (e2e/stub/showcase.ts). */
export const SPACES = ["tasks-web", "tasks-api", "tasks-mobile", "docs"];
const PANES = [
  { agent: "claude", title: "Fix the flaky due-date test", state: "done" },
  { agent: "cursor", title: "Move settings to the new form library", state: "working" },
  { agent: "opencode", title: "Add dark mode to the dashboard", state: "working" },
  { agent: "cursor", title: "Fix the login redirect loop", state: "done" },
] as const;

const stateColor = (s: string) => (s === "working" ? c.blue : s === "done" ? c.sage : c.amber);

const Chrome = ({ title }: { title: string }) => (
  <div style={{ height: 44, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderBottom: `1px solid ${c.line}`, color: c.muted, fontSize: 14, fontFamily: mono }}>
    {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: c.lineBright }} />)}
    <span style={{ marginLeft: 8 }}>{title}</span>
  </div>
);

/**
 * herdr on the laptop. `pick` is when the phone opens tasks-web: the space
 * lights up here too, and its panes flash one after another as their rows
 * land on the phone.
 */
export const HerdrWindow = ({ f, w, h, pick }: { f: number; w: number; h: number; pick: number }) => {
  const side = Math.round(w * 0.2);
  const paneW = (w - side - 36) / 2;
  const paneH = (h - 44 - 34) / 2;
  const small = w < 800;
  return (
    <div style={{ position: "relative", width: w, height: h, borderRadius: 16, background: c.surface, border: `1px solid ${c.lineBright}`, boxShadow: "0 40px 90px rgba(0,0,0,.6)", overflow: "hidden", fontFamily: mono }}>
      <Chrome title="herdr · workstation" />
      <div style={{ position: "absolute", top: 44, left: 0, bottom: 0, width: side, borderRight: `1px solid ${c.line}`, padding: small ? 10 : 14, fontSize: small ? 12 : 15 }}>
        <div style={{ color: c.muted, fontSize: small ? 10 : 12, letterSpacing: ".12em", marginBottom: 10 }}>SPACES</div>
        {SPACES.map((s, i) => {
          const on = i === 0 && f >= pick;
          return (
            <div key={s} style={{ display: "flex", gap: 8, padding: "6px 8px", borderRadius: 6, marginBottom: 4, background: on ? "rgba(232,163,61,.12)" : "transparent", color: on ? c.text : c.muted, border: `1px solid ${on ? c.amber : "transparent"}` }}>
              <span style={{ color: c.lineBright }}>{i + 1}</span>{s}{i === 2 ? <span style={{ marginLeft: "auto", color: c.amber }}>●</span> : null}
            </div>
          );
        })}
      </div>
      {PANES.map((p, i) => {
        const hl = window(f, pick + 6 + i * 7, pick + 40 + i * 7, 6);
        return (
          <div key={p.title} style={{ position: "absolute", left: side + 12 + (i % 2) * (paneW + 12), top: 56 + Math.floor(i / 2) * (paneH + 10), width: paneW, height: paneH,
            border: `1px solid ${hl > 0.3 ? c.amber : c.line}`, borderRadius: 10, padding: small ? 9 : 12, fontSize: small ? 10 : 13, overflow: "hidden", background: `rgba(232,163,61,${hl * 0.07})` }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, color: c.text, marginBottom: small ? 6 : 8, whiteSpace: "nowrap" }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.agent} · {p.title}</span>
              <span style={{ color: stateColor(p.state) }}>● {p.state}</span>
            </div>
            {[0.9, 0.62, 0.8, 0.5, 0.7, 0.4].map((lw, j) => (
              <div key={j} style={{ height: small ? 5 : 7, width: `${lw * 100}%`, background: c.line, borderRadius: 3, marginTop: small ? 7 : 10 }} />
            ))}
          </div>
        );
      })}
    </div>
  );
};

/** The installer's own words (site/install.sh), its steps in bold as it prints them. */
const STEPS = ["Installing herdr 0.9.5", "Installing the Shahi plugin", "Starting Shahi's service", "Pair your phone"];

export const InstallWindow = ({ f, w, h }: { f: number; w: number; h: number }) => {
  const qr = ramp(f, SETUP.qr, 12);
  const small = w < 800;
  const qrSize = Math.min(h - 280, small ? 170 : 210);
  return (
    <div style={{ position: "relative", width: w, height: h, borderRadius: 16, background: c.surface, border: `1px solid ${c.lineBright}`, boxShadow: "0 40px 90px rgba(0,0,0,.6)", overflow: "hidden", fontFamily: mono }}>
      <Chrome title="Terminal · ~" />
      <div style={{ padding: small ? "16px 18px" : "22px 26px", fontSize: small ? 15 : 19, lineHeight: 1.65 }}>
        <div style={{ whiteSpace: "nowrap" }}><span style={{ color: c.amber }}>$ </span>{typed(SETUP.cmd, f, SETUP.cmdAt, SETUP.cmdCps)}</div>
        {STEPS.map((s, i) => (f >= SETUP.steps[i] ? <div key={s} style={{ fontWeight: 600, color: i === STEPS.length - 1 ? c.text : "#d8d2c8" }}>{i < STEPS.length - 1 ? <span style={{ color: c.sage }}>✓ </span> : null}{s}</div> : null))}
        <div style={{ display: "flex", gap: 22, alignItems: "center", marginTop: 12, opacity: qr, transform: `translateY(${(1 - qr) * 10}px)` }}>
          <QR size={qrSize} />
          <div style={{ fontSize: small ? 13 : 16, color: c.muted, lineHeight: 1.5, maxWidth: 360, fontFamily: mono }}>Scan this code in the Shahi app.</div>
        </div>
      </div>
    </div>
  );
};
