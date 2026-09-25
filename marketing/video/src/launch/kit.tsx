import type { CSSProperties, ReactNode } from "react";
import { Img, staticFile } from "remotion";
import { ramp } from "../motion";
import { c, mono, sans } from "../theme";


/** The logical size of the phone screen; the device is drawn at this size and scaled. */
export const DW = 390;
export const DH = 844;

export const Device = ({ children, glow = 0 }: { children: ReactNode; glow?: number }) => (
  <div
    style={{
      width: DW + 22,
      height: DH + 22,
      padding: 11,
      borderRadius: 64,
      background: "linear-gradient(145deg, #3a352c, #16140f 45%, #2a2620)",
      boxShadow: `0 60px 120px rgba(0,0,0,.7), 0 0 0 1px #4a443a, 0 0 ${120 * glow}px rgba(232,163,61,${0.28 * glow})`,
    }}
  >
    <div style={{ position: "relative", width: DW, height: DH, borderRadius: 53, overflow: "hidden", background: c.void, fontFamily: sans, color: c.text }}>
      <StatusBar />
      {children}
      {/* Glass: a faint diagonal highlight sells the screen as a surface. */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "linear-gradient(115deg, rgba(255,255,255,.06), transparent 35%)" }} />
    </div>
  </div>
);

const StatusBar = () => (
  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 50, zIndex: 5, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 34px 0" }}>
    <span style={{ fontSize: 16, fontWeight: 600 }}>9:41</span>
    <div style={{ position: "absolute", left: DW / 2 - 60, top: 11, width: 120, height: 34, borderRadius: 20, background: "#000" }} />
    <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <svg width="18" height="12" viewBox="0 0 18 12"><path d="M1 11h2V8H1zM5 11h2V6H5zM9 11h2V3H9zM13 11h2V0h-2z" fill={c.text} /></svg>
      <span style={{ width: 25, height: 12, borderRadius: 4, border: `1.5px solid ${c.muted}`, padding: 1.5, display: "flex" }}>
        <span style={{ flex: 1, background: c.text, borderRadius: 2 }} />
      </span>
    </span>
  </div>
);

/** A header row as the app draws it: back chevron, mono title, read/screen toggle. */
export const AppHeader = ({ title, sub, mode }: { title: string; sub: string; mode?: "read" | "screen" }) => (
  <div style={{ position: "absolute", top: 54, left: 0, right: 0, height: 64, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", borderBottom: `1px solid ${c.line}`, background: c.void, zIndex: 4 }}>
    <div style={{ width: 38, height: 38, borderRadius: 19, border: `1px solid ${c.line}`, display: "grid", placeItems: "center", flex: "none" }}>
      <svg width="12" height="18" viewBox="0 0 12 18"><path d="M10 1 2 9l8 8" stroke={c.text} strokeWidth="2.4" fill="none" strokeLinecap="round" /></svg>
    </div>
    <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontFamily: mono }}>
      <div style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
      <div style={{ fontSize: 11, color: c.muted }}>{sub}</div>
    </div>
    {mode ? (
      <div style={{ display: "flex", borderRadius: 18, border: `1px solid ${c.line}`, fontFamily: mono, fontSize: 12, padding: "8px 12px", gap: 14, flex: "none" }}>
        <span style={{ color: mode === "read" ? c.amber : c.muted }}>read</span>
        <span style={{ color: mode === "screen" ? c.amber : c.muted }}>screen</span>
      </div>
    ) : null}
  </div>
);

export const AgentIcon = ({ kind, size = 22 }: { kind: "claude" | "codex"; size?: number }) => (
  <span style={{ width: size + 14, height: size + 14, borderRadius: 999, flex: "none", display: "grid", placeItems: "center", background: kind === "claude" ? "rgba(217,119,87,.14)" : "rgba(16,163,127,.16)" }}>
    <Img src={staticFile(`agents/${kind}.svg`)} style={{ width: size, height: size }} />
  </span>
);

export const Status = ({ state }: { state: "needs" | "working" | "done" }) => {
  const [label, color] = state === "needs" ? ["Needs you", c.amber] : state === "working" ? ["Working", c.blue] : ["Done", c.sage];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color }}>
      <span style={{ width: 7, height: 7, borderRadius: 4, background: color }} />
      {label}
    </span>
  );
};

/** A finger tap: a ring that lands, presses and fades. */
export const Tap = ({ f, at, x, y }: { f: number; at: number; x: number; y: number }) => {
  const t = f - at;
  if (t < -8 || t > 22) return null;
  const inn = ramp(f, at - 8, 8);
  const out = ramp(f, at + 4, 16);
  return (
    <div style={{ position: "absolute", left: x - 28, top: y - 28, width: 56, height: 56, borderRadius: 28, zIndex: 20,
      background: "rgba(240,239,234,.22)", border: "2px solid rgba(240,239,234,.6)",
      opacity: inn * (1 - out), transform: `scale(${(t < 0 ? 1.3 - inn * 0.3 : 1 - Math.min(t, 4) * 0.04) + out * 0.8})` }} />
  );
};

/** Caption block: mono eyebrow, a large headline and an optional line beneath. */
export const Caption = ({ eyebrow, title, sub, o, rise, wide, style }: {
  eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; o: number; rise: number; wide: boolean; style?: CSSProperties;
}) => (
  <div style={{ position: "absolute", display: "flex", flexDirection: "column", opacity: o, transform: `translateY(${rise}px)`,
    ...(wide ? { left: 130, top: 0, bottom: 0, width: 700, justifyContent: "center" } : { left: 72, right: 72, top: 64 }), ...style }}>
    {eyebrow ? <div style={{ fontFamily: mono, fontSize: wide ? 24 : 22, color: c.amber, marginBottom: wide ? 22 : 14, letterSpacing: ".02em" }}>{eyebrow}</div> : null}
    <div style={{ fontSize: wide ? 84 : 62, fontWeight: 600, letterSpacing: "-0.045em", lineHeight: 1.02, textWrap: "balance" }}>{title}</div>
    {sub ? <div style={{ fontSize: wide ? 29 : 25, lineHeight: 1.42, color: c.muted, marginTop: wide ? 26 : 14, maxWidth: wide ? 640 : 920, textWrap: "pretty" }}>{sub}</div> : null}
  </div>
);

/** A deterministic, decorative QR-like grid with the three finder squares. */
export const QR = ({ size }: { size: number }) => {
  const n = 25;
  const cell = size / n;
  const finder = (x: number, y: number) => {
    for (const [fx, fy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
      if (x >= fx && x < fx + 7 && y >= fy && y < fy + 7) {
        const dx = x - fx, dy = y - fy;
        return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4) ? 1 : 0;
      }
      if (x >= fx - 1 && x <= fx + 7 && y >= fy - 1 && y <= fy + 7) return 0;
    }
    return -1;
  };
  const rects: ReactNode[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const fi = finder(x, y);
      let h = Math.imul(x + 1, 374761393) + Math.imul(y + 1, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      const on = fi === -1 ? ((h ^ (h >>> 16)) & 3) < 2 : fi === 1;
      if (on) rects.push(<rect key={`${x}-${y}`} x={x * cell} y={y * cell} width={cell + 0.3} height={cell + 0.3} />);
    }
  return (
    <svg width={size} height={size} style={{ background: c.text, padding: cell * 1.5, boxSizing: "content-box", borderRadius: 8 }}>
      <g fill={c.void}>{rects}</g>
    </svg>
  );
};
