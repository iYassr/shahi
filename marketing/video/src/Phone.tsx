import type { CSSProperties, ReactNode } from "react";
import { Img, interpolate, staticFile } from "remotion";
import { lerp, ramp, settle, typed } from "./motion";
import { c, mono, S, sans } from "./theme";

export const PHONE_W = 390;
export const PHONE_H = 844;

const CLAUDE = "#d97757";
const TAP = S.tap;
const ANSWERED = TAP + 16;
const SEND = S.reader + 172;
const REPLY = "Yes. Add a test for the empty-invoice case first.";

/** An iPhone-proportioned device, 390×844 logical points. */
export const Phone = ({ f }: { f: number }) => {
  const toReader = settle(f, S.reader);
  return (
    <div
      style={{
        width: PHONE_W + 24,
        height: PHONE_H + 24,
        padding: 12,
        borderRadius: 68,
        background: "#050505",
        boxShadow: `0 0 0 2px ${c.lineBright}, 0 60px 140px rgba(0,0,0,.6)`,
      }}
    >
      <div
        style={{
          position: "relative",
          width: PHONE_W,
          height: PHONE_H,
          borderRadius: 56,
          overflow: "hidden",
          background: c.void,
          fontFamily: sans,
          color: c.text,
        }}
      >
        <div style={{ position: "absolute", inset: 0, transform: `translateX(${-toReader * 30}%)`, opacity: 1 - toReader * 0.6 }}>
          <Agents f={f} />
        </div>
        <div style={{ position: "absolute", inset: 0, transform: `translateX(${(1 - toReader) * 100}%)` }}>
          <Reader f={f} />
        </div>
        <StatusBar />
      </div>
    </div>
  );
};

const StatusBar = () => (
  <div
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 54,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "6px 34px 0 44px",
      fontSize: 16,
      fontWeight: 600,
    }}
  >
    <span>9:41</span>
    <span style={{ position: "absolute", left: 132, top: 11, width: 126, height: 36, borderRadius: 20, background: "#000" }} />
    <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <span style={{ display: "flex", gap: 2, alignItems: "flex-end" }}>
        {[5, 7, 9, 11].map((h) => (
          <span key={h} style={{ width: 3, height: h, borderRadius: 1, background: c.text }} />
        ))}
      </span>
      <span style={{ width: 24, height: 12, borderRadius: 4, border: `1.5px solid ${c.muted}`, padding: 1.5 }}>
        <span style={{ display: "block", width: "80%", height: "100%", borderRadius: 2, background: c.text }} />
      </span>
    </span>
  </div>
);

/* ---------------------------------------------------------------- Agents */

const Agents = ({ f }: { f: number }) => {
  const pressed = f >= TAP && f < ANSWERED;
  const gone = settle(f, ANSWERED);
  const toast = Math.min(ramp(f, ANSWERED, 8), 1 - ramp(f, ANSWERED + 50, 10));

  return (
    <div style={{ position: "absolute", inset: 0, padding: "54px 16px 0" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 6 }}>
        <Pill>
          <span style={{ fontFamily: mono, fontSize: 12, color: c.muted }}>studio-mac</span>
          <span style={{ fontFamily: mono, fontSize: 12, color: c.sage, letterSpacing: 1 }}>LIVE</span>
        </Pill>
      </div>
      <div style={{ fontSize: 34, fontWeight: 600, letterSpacing: -0.8, margin: "6px 0 14px" }}>Agents</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        <Filter selected>All</Filter>
        <Filter>{f < ANSWERED ? "Waiting 1" : "Waiting"}</Filter>
        <Filter>claude</Filter>
        <Filter>codex</Filter>
      </div>

      <div
        style={{
          maxHeight: lerp(gone, 360, 0),
          opacity: 1 - gone,
          transform: `scale(${lerp(gone, 1, 0.97)})`,
          overflow: "hidden",
          marginBottom: lerp(gone, 22, 0),
        }}
      >
        <div style={{ border: `1.5px solid ${c.amber}`, borderRadius: 14, padding: 16, background: c.surface }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 11.5, letterSpacing: 1.6, color: c.amber }}>
            <span style={{ width: 7, height: 7, borderRadius: 9, background: c.amber }} />
            NEEDS YOUR ANSWER
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 8 }}>Ship the billing migration</div>
          <div style={{ fontFamily: mono, fontSize: 12.5, color: c.muted, marginTop: 2 }}>claude · api · 12m</div>
          <div
            style={{
              fontFamily: mono,
              fontSize: 12.5,
              lineHeight: 1.6,
              background: c.steeped,
              borderRadius: 8,
              padding: "8px 10px",
              margin: "12px 0",
            }}
          >
            <div style={{ color: c.muted }}>Bash command</div>
            <div>bun run db:migrate && bun test</div>
          </div>
          <div style={{ fontSize: 16, marginBottom: 6 }}>Do you want to proceed?</div>
          <Choice n={1} pressed={pressed} tap={f - TAP}>
            Yes
          </Choice>
          <Choice n={2}>Yes, and don't ask again for bun</Choice>
          <Choice n={3}>No, and tell Claude what to do differently</Choice>
        </div>
      </div>

      <div style={{ fontFamily: mono, fontSize: 11.5, letterSpacing: 1.6, color: c.muted, marginBottom: 4 }}>
        {f < ANSWERED ? "EVERYTHING ELSE" : "ALL AGENTS"}
      </div>
      {f >= ANSWERED ? (
        <div style={{ opacity: ramp(f, ANSWERED + 6, 10) }}>
          <Row agent="claude" title="Ship the billing migration" detail="Running bun test…" status="working" />
        </div>
      ) : null}
      <Row agent="codex" title="Refactor auth middleware" detail="Reading src/auth/session.ts" status="working" f={f} />
      <Row agent="claude" title="Update onboarding copy" detail="Changed 3 files" status="done" />
      <Row agent="codex" title="Fix flaky upload test" detail="Tests passed" status="done" />

      <div
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          bottom: 108,
          display: "flex",
          justifyContent: "center",
          opacity: toast,
          transform: `translateY(${(1 - toast) * 12}px)`,
        }}
      >
        <Pill>
          <Check />
          <span style={{ fontSize: 15 }}>Answer sent</span>
        </Pill>
      </div>
      <TabBar />
    </div>
  );
};

const Pill = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      padding: "9px 16px",
      borderRadius: 99,
      background: c.steeped,
      border: `1px solid ${c.lineBright}`,
    }}
  >
    {children}
  </div>
);

const Filter = ({ children, selected }: { children: ReactNode; selected?: boolean }) => (
  <span
    style={{
      fontFamily: mono,
      fontSize: 13,
      padding: "8px 14px",
      borderRadius: 99,
      color: selected ? c.text : c.muted,
      background: selected ? c.steeped : "transparent",
      border: `1px solid ${selected ? c.muted : c.line}`,
    }}
  >
    {children}
  </span>
);

const Choice = ({ n, children, pressed, tap = -99 }: { n: number; children: ReactNode; pressed?: boolean; tap?: number }) => (
  <div
    style={{
      position: "relative",
      display: "flex",
      gap: 10,
      alignItems: "center",
      minHeight: 44,
      padding: "0 12px",
      marginTop: 6,
      borderRadius: 10,
      fontSize: 15.5,
      background: pressed ? "rgba(232,163,61,.16)" : c.steeped,
      border: `1px solid ${pressed ? c.amber : c.line}`,
      overflow: "visible",
    }}
  >
    <span style={{ fontFamily: mono, color: c.muted }}>{n}.</span>
    <span>{children}</span>
    {tap >= -8 && tap < 16 ? <Touch t={tap} x={70} y={22} /> : null}
  </div>
);

/** A fingertip: grows in, presses, and lifts away. */
const Touch = ({ t, x, y }: { t: number; x: number; y: number }) => {
  const size = interpolate(t, [-8, 0, 4, 16], [70, 44, 38, 70], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = interpolate(t, [-8, -2, 8, 16], [0, 0.55, 0.45, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <span
      style={{
        position: "absolute",
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: 99,
        background: "rgba(240,239,234,.5)",
        border: "2px solid rgba(240,239,234,.8)",
        opacity,
        pointerEvents: "none",
      }}
    />
  );
};

const STATUS = { working: c.blue, done: c.sage };

const Row = ({
  agent,
  title,
  detail,
  status,
  f = 0,
}: {
  agent: "claude" | "codex";
  title: string;
  detail: string;
  status: keyof typeof STATUS;
  f?: number;
}) => {
  // The brand's avatar bob: working agents only, 3px and 1.06 over 420ms each way.
  const bob = status === "working" ? (1 - Math.cos((f / 25.2) * Math.PI)) / 2 : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: `1px solid ${c.line}` }}>
      <Avatar agent={agent} lift={bob} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        <div style={{ fontSize: 13.5, color: c.muted, marginTop: 1 }}>{detail}</div>
      </div>
      <span style={{ fontFamily: mono, fontSize: 12.5, color: STATUS[status] }}>{status}</span>
    </div>
  );
};

const Avatar = ({ agent, lift = 0, size = 40 }: { agent: "claude" | "codex"; lift?: number; size?: number }) => (
  <span
    style={{
      display: "grid",
      placeItems: "center",
      width: size,
      height: size,
      flex: "none",
      borderRadius: 99,
      background: c.steeped,
      border: `1px solid ${c.lineBright}`,
      transform: `translateY(${-3 * lift}px) scale(${1 + 0.06 * lift})`,
    }}
  >
    <Img
      src={staticFile(`agents/${agent}.svg`)}
      style={{ width: size * 0.5, height: size * 0.5 }}
    />
  </span>
);

const Check = ({ color = c.sage, size = 16 }: { color?: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16">
    <path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const TabBar = () => {
  const tab = (label: string, icon: ReactNode, active?: boolean) => (
    <div style={{ display: "grid", justifyItems: "center", gap: 3, color: active ? c.text : c.muted, fontSize: 11 }}>
      {icon}
      {label}
    </div>
  );
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinejoin: "round" } as const;
  return (
    <div
      style={{
        position: "absolute",
        left: 40,
        right: 40,
        bottom: 26,
        height: 62,
        borderRadius: 99,
        background: "rgba(28,25,21,.92)",
        border: `1px solid ${c.lineBright}`,
        display: "flex",
        justifyContent: "space-around",
        alignItems: "center",
      }}
    >
      {tab("Agents", <svg width={22} height={22} viewBox="0 0 22 22"><rect x="5" y="5" width="12" height="12" rx="2" {...stroke} /><rect x="8.5" y="8.5" width="5" height="5" {...stroke} /></svg>, true)}
      {tab("Spaces", <svg width={22} height={22} viewBox="0 0 22 22">{[3, 12].flatMap((x) => [3, 12].map((y) => <rect key={`${x}${y}`} x={x} y={y} width="7" height="7" rx="1.5" {...stroke} />))}</svg>)}
      {tab("Settings", <svg width={22} height={22} viewBox="0 0 22 22"><circle cx="11" cy="11" r="3" {...stroke} /><circle cx="11" cy="11" r="7.5" {...stroke} strokeDasharray="3 2.4" /></svg>)}
    </div>
  );
};

/* ---------------------------------------------------------------- Reader */

const Reader = ({ f }: { f: number }) => {
  const r = f - S.reader;
  const draft = f < SEND ? typed(REPLY, f, S.reader + 100, 28) : "";
  const sent = f >= SEND;
  const appear = (at: number): CSSProperties => ({
    opacity: ramp(r, at, 10),
    transform: `translateY(${(1 - ramp(r, at, 12)) * 14}px)`,
  });
  // The column is bottom-anchored like a chat: new rows push history upward.
  return (
    <div style={{ position: "absolute", inset: 0, background: c.void }}>
      <div
        style={{
          position: "absolute",
          top: 54,
          left: 0,
          right: 0,
          height: 64,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          borderBottom: `1px solid ${c.line}`,
          background: c.void,
          zIndex: 2,
        }}
      >
        <span style={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: 99, background: c.steeped, border: `1px solid ${c.lineBright}` }}>
          <svg width={14} height={14} viewBox="0 0 14 14"><path d="M9 2L4 7l5 5" fill="none" stroke={c.text} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Ship the billing migration</div>
          <div style={{ fontFamily: mono, fontSize: 11.5, color: c.muted }}>claude · api</div>
        </div>
        <span style={{ display: "flex", borderRadius: 99, border: `1px solid ${c.lineBright}`, background: c.steeped, fontFamily: mono, fontSize: 12.5 }}>
          <span style={{ padding: "6px 10px", color: c.amber }}>read</span>
          <span style={{ padding: "6px 10px", color: c.muted }}>screen</span>
        </span>
      </div>

      <div
        style={{
          position: "absolute",
          left: 16,
          right: 16,
          top: 118,
          bottom: 96,
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          gap: 16,
          overflow: "hidden",
        }}
      >
        <You>Can invoices carry their own currency?</You>
        <AgentSays>Yes. Migration 0042 adds invoices.currency and backfills it from each account.</AgentSays>
        <You>Ship the billing migration. Run the tests before you finish.</You>
        <AgentSays>Applied 0042_invoice_currency: 3 tables altered, no rows lost. Running the suite now.</AgentSays>
        <div style={appear(18)}>
          <Tool />
        </div>
        <div style={appear(48)}>
          <AgentSays>All 214 tests pass. Want me to open a pull request?</AgentSays>
        </div>
        {sent ? (
          <div style={appear(SEND - S.reader)}>
            <You>{REPLY}</You>
          </div>
        ) : null}
        {sent ? (
          <div style={{ ...appear(SEND - S.reader + 14), display: "flex", alignItems: "center", gap: 10, fontFamily: mono, fontSize: 13, color: c.muted }}>
            <span style={{ width: 8, height: 8, borderRadius: 9, background: c.blue, opacity: 0.55 + 0.45 * Math.cos(f / 6) }} />
            <span style={{ color: c.blue }}>Working</span>
            <span>0m {String(Math.max(0, Math.floor((f - SEND - 14) / 30))).padStart(2, "0")}s</span>
          </div>
        ) : null}
      </div>

      <Composer draft={draft} f={f} />
    </div>
  );
};

const Role = ({ color, children }: { color: string; children: ReactNode }) => (
  <div style={{ fontFamily: mono, fontSize: 11.5, letterSpacing: 1.6, color, marginBottom: 5 }}>{children}</div>
);

const You = ({ children }: { children: ReactNode }) => (
  <div style={{ background: "rgba(139,184,232,.08)", borderLeft: `2px solid ${c.blue}`, borderRadius: 10, padding: "10px 14px" }}>
    <Role color={c.blue}>YOU</Role>
    <div style={{ fontSize: 16, lineHeight: 1.45 }}>{children}</div>
  </div>
);

const AgentSays = ({ children }: { children: ReactNode }) => (
  <div>
    <Role color={CLAUDE}>AGENT</Role>
    <div style={{ fontSize: 16, lineHeight: 1.5 }}>{children}</div>
  </div>
);

const Tool = () => (
  <div style={{ background: c.surface, border: `1px solid ${c.line}`, borderRadius: 10, padding: "10px 12px", fontFamily: mono, fontSize: 12.5, lineHeight: 1.6 }}>
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span>
        <span style={{ color: c.muted }}>Bash </span>bun test
      </span>
      <Check size={14} />
    </div>
    <div style={{ color: c.muted }}>
      <span style={{ color: c.sage }}>214 pass</span> · 0 fail · 38 files · 4.12s
    </div>
  </div>
);

const Composer = ({ draft, f }: { draft: string; f: number }) => {
  const press = f - SEND;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 96,
        padding: "12px 14px 34px",
        display: "flex",
        gap: 8,
        borderTop: `1px solid ${c.line}`,
        background: c.void,
      }}
    >
      <span style={{ display: "grid", placeItems: "center", width: 46, borderRadius: 12, border: `1px solid ${c.lineBright}`, color: c.muted, fontSize: 22 }}>+</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          borderRadius: 12,
          border: `1px solid ${draft ? c.muted : c.lineBright}`,
          fontSize: 14.5,
          color: draft ? c.text : c.muted,
          justifyContent: draft ? "flex-end" : "flex-start",
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {/* flex-end overflows to the left, keeping the end of a long draft in view as a real field scrolls. */}
        <span style={{ flex: "none" }}>
          {draft || "Reply to this agent…"}
          {draft ? <span style={{ display: "inline-block", width: 2, height: 17, marginLeft: 1, verticalAlign: -3, background: c.amber, opacity: Math.floor(f / 12) % 2 ? 0.2 : 1 }} /> : null}
        </span>
      </span>
      <span
        style={{
          position: "relative",
          display: "grid",
          placeItems: "center",
          padding: "0 16px",
          borderRadius: 12,
          background: c.amber,
          color: c.void,
          fontWeight: 600,
          fontSize: 15,
          opacity: draft || press >= 0 ? 1 : 0.45,
        }}
      >
        Send
        {press >= -8 && press < 16 ? <Touch t={press} x={32} y={25} /> : null}
      </span>
    </div>
  );
};
