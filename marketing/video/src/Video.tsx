import type { ReactNode } from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { lerp, ramp, settle, window } from "./motion";
import { Phone, PHONE_H, PHONE_W } from "./Phone";
import { Terminal } from "./Terminal";
import { c, mono, S, sans } from "./theme";

export const Video = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const wide = width > height;

  return (
    <AbsoluteFill style={{ background: `radial-gradient(120% 90% at 70% 40%, ${c.surface}, ${c.void} 70%)`, fontFamily: sans, color: c.text }}>
      <TerminalStage f={f} wide={wide} />
      <PhoneStage f={f} wide={wide} />
      <Captions f={f} wide={wide} />
      <Trust f={f} wide={wide} />
      <EndCard f={f} wide={wide} />
    </AbsoluteFill>
  );
};

/* -------------------------------------------------------------- captions */

type Beat = { from: number; to: number; eyebrow?: ReactNode; title: string; sub?: ReactNode };

const beats = (f: number): Beat[] => [
  { from: S.terminal, to: S.away, eyebrow: "claude · in herdr on your Mac", title: "Your agent needs an answer." },
  {
    from: S.away,
    to: S.inbox,
    eyebrow: <Waiting f={f} />,
    title: "You're not at your desk.",
    sub: "So the work stops, and waits for you.",
  },
  {
    from: S.inbox,
    to: S.tap,
    eyebrow: "Shahi",
    title: "Now it reaches you.",
    sub: "Every agent on your computer, live on your phone. What needs you comes first.",
  },
  {
    from: S.tap,
    to: S.reader,
    eyebrow: "One tap",
    title: "Answer from anywhere.",
    sub: "Shahi re-reads the screen before it presses a key, so a stale view never answers the wrong question.",
  },
  {
    from: S.reader,
    to: S.trust,
    eyebrow: "The same conversation",
    title: "Read it. Reply. Keep going.",
    sub: "The agent's own transcript, set for a phone. Not a squeezed terminal.",
  },
];

const Captions = ({ f, wide }: { f: number; wide: boolean }) => (
  <>
    {beats(f).map((b) => {
      const o = window(f, b.from + (b.from === 0 ? 8 : 4), b.to, 10);
      if (o <= 0) return null;
      const rise = (1 - ramp(f, b.from + 4, 14)) * 18;
      return (
        <div
          key={b.from}
          style={{
            position: "absolute",
            ...(wide ? { left: 140, top: 0, bottom: 0, width: 640, justifyContent: "center" } : { left: 80, right: 80, top: 72 }),
            display: "flex",
            flexDirection: "column",
            opacity: o,
            transform: `translateY(${rise}px)`,
          }}
        >
          {b.eyebrow ? (
            <div style={{ fontFamily: mono, fontSize: wide ? 22 : 22, color: c.amber, marginBottom: wide ? 22 : 16 }}>{b.eyebrow}</div>
          ) : null}
          <div style={{ fontSize: wide ? 76 : 64, fontWeight: 500, letterSpacing: "-0.045em", lineHeight: 1.04 }}>{b.title}</div>
          {b.sub ? (
            <div style={{ fontSize: wide ? 28 : 26, lineHeight: 1.45, color: c.muted, marginTop: wide ? 26 : 16, maxWidth: wide ? 600 : 900, textWrap: "pretty" }}>{b.sub}</div>
          ) : null}
        </div>
      );
    })}
  </>
);

/** A wait that grows while nobody is there to answer. */
const Waiting = ({ f }: { f: number }) => {
  const minutes = Math.round(lerp(ramp(f, S.away + 6, 60), 0, 12));
  return <span>Waiting {minutes}m</span>;
};

/* ---------------------------------------------------------------- stages */

const TerminalStage = ({ f, wide }: { f: number; wide: boolean }) => {
  const enter = settle(f, 0);
  const away = ramp(f, S.away, 24);
  const exit = ramp(f, S.inbox - 6, 18);
  if (exit >= 1) return null;
  const tw = wide ? 1000 : 920;
  return (
    <div
      style={{
        position: "absolute",
        ...(wide ? { left: 820, top: 250 } : { left: 80, top: 330 }),
        opacity: enter * (1 - exit) * lerp(away, 1, 0.3),
        filter: `blur(${away * 3 + exit * 6}px)`,
        transform: `translateY(${(1 - enter) * 40}px) scale(${lerp(away, 1, 0.95)})`,
        transformOrigin: "center",
      }}
    >
      <Terminal f={f} width={tw} size={wide ? 20 : 19} />
    </div>
  );
};

const PhoneStage = ({ f, wide }: { f: number; wide: boolean }) => {
  const enter = settle(f, S.inbox - 4);
  const leave = ramp(f, S.trust - 4, 16);
  if (f < S.inbox - 6 || leave >= 1) return null;
  const scale = wide ? 1.12 : 1.04;
  const w = (PHONE_W + 24) * scale;
  const h = (PHONE_H + 24) * scale;
  // Wide: right half, fully in frame. Square: under the caption, running off the bottom edge.
  const left = wide ? 1310 - w / 2 : 540 - w / 2;
  const top = wide ? (1080 - h) / 2 : 380;
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: w,
        height: h,
        opacity: enter * (1 - leave),
        transform: `translateY(${(1 - enter) * 260 + leave * 60}px)`,
      }}
    >
      <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <Phone f={f} />
      </div>
    </div>
  );
};

/* ----------------------------------------------------------------- trust */

const points = [
  {
    title: "End-to-end encrypted",
    body: "The relay forwards sealed frames it cannot read. Or skip it and use SSH.",
    icon: <path d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z" />,
  },
  {
    title: "Nothing to upload",
    body: "Agents, files and commands stay in herdr, on your machine.",
    icon: <path d="M3 5h18v11H3zM8 20h8M12 16v4" />,
  },
  {
    title: "Devices you control",
    body: "Pair with a one-time code. Revoke any phone, instantly.",
    icon: <path d="M8 3h8v18H8zM11 18h2" />,
  },
];

const Trust = ({ f, wide }: { f: number; wide: boolean }) => {
  const o = window(f, S.trust + 6, S.end, 12);
  if (o <= 0) return null;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: o, padding: wide ? 140 : 80 }}>
      <div style={{ fontFamily: mono, fontSize: 22, color: c.amber, marginBottom: 20 }}>Built to be trusted with a shell</div>
      <div style={{ fontSize: wide ? 76 : 62, fontWeight: 500, letterSpacing: "-0.045em", textAlign: "center", lineHeight: 1.05 }}>
        Your code stays on your machine.
      </div>
      <div style={{ display: "flex", flexDirection: wide ? "row" : "column", gap: wide ? 28 : 18, marginTop: wide ? 64 : 44, width: "100%" }}>
        {points.map((p, i) => {
          const a = ramp(f, S.trust + 18 + i * 8, 14);
          return (
            <div
              key={p.title}
              style={{
                flex: 1,
                display: "flex",
                gap: 20,
                alignItems: "flex-start",
                padding: wide ? "30px 30px" : "22px 26px",
                background: c.surface,
                border: `1px solid ${c.line}`,
                borderRadius: 14,
                opacity: a,
                transform: `translateY(${(1 - a) * 20}px)`,
              }}
            >
              <svg width={34} height={34} viewBox="0 0 24 24" style={{ flex: "none", marginTop: 2 }}>
                <g fill="none" stroke={c.sage} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round">
                  {p.icon}
                </g>
              </svg>
              <div>
                <div style={{ fontSize: wide ? 28 : 27, fontWeight: 600 }}>{p.title}</div>
                <div style={{ fontSize: wide ? 22 : 22, color: c.muted, lineHeight: 1.45, marginTop: 6 }}>{p.body}</div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ------------------------------------------------------------------- end */

const EndCard = ({ f, wide }: { f: number; wide: boolean }) => {
  if (f < S.end) return null;
  const mark = settle(f, S.end + 4);
  const steam = settle(f, S.end + 14);
  const word = ramp(f, S.end + 16, 16);
  const line = ramp(f, S.end + 30, 16);
  const url = ramp(f, S.end + 44, 16);
  const foot = ramp(f, S.end + 58, 16);
  const s = wide ? 1 : 0.92;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 26 * s, transform: `scale(${s})` }}>
        {/* Geometry of docs/logo.svg; the steam square settling in is the brand's one sanctioned logo motion. */}
        <svg width={150} height={150} viewBox="0 0 100 100" style={{ opacity: mark }}>
          <rect x="44" y="10" width="12" height="12" rx="2" fill={c.amber} opacity={steam} transform={`translate(0 ${(1 - steam) * 12})`} />
          <path
            d="M22 34H78L71 72Q70 80 62 80H38Q30 80 29 72Z"
            fill="none"
            stroke={c.amber}
            strokeWidth={8}
            strokeLinejoin="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - mark}
          />
        </svg>
        <Img src={staticFile("wordmark.svg")} style={{ height: 114, opacity: word, transform: `translateX(${(1 - word) * -16}px)` }} />
      </div>
      <div style={{ fontSize: wide ? 60 : 54, fontWeight: 500, letterSpacing: "-0.04em", marginTop: 48, opacity: line, transform: `translateY(${(1 - line) * 14}px)` }}>
        Leave your desk. <span style={{ color: c.muted }}>Keep working.</span>
      </div>
      <div
        style={{
          marginTop: 44,
          padding: "16px 34px",
          borderRadius: 14,
          background: c.amber,
          color: c.void,
          fontSize: 34,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          opacity: url,
          transform: `translateY(${(1 - url) * 14}px)`,
        }}
      >
        getshahi.dev
      </div>
      <div style={{ position: "absolute", bottom: wide ? 70 : 64, display: "flex", alignItems: "center", gap: 16, fontFamily: mono, fontSize: 21, color: c.muted, opacity: foot }}>
        <span>Works with herdr</span>
        <Sep />
        <Img src={staticFile("agents/claude.svg")} style={{ width: 24, height: 24 }} />
        <span>Claude Code</span>
        <Sep />
        <Img src={staticFile("agents/codex.svg")} style={{ width: 24, height: 24 }} />
        <span>Codex</span>
        <Sep />
        <span>iPhone & browser</span>
      </div>
    </AbsoluteFill>
  );
};

const Sep = () => <span style={{ width: 4, height: 4, borderRadius: 9, background: c.lineBright }} />;
