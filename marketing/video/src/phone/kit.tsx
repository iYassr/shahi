import type { CSSProperties, ReactNode } from "react";
import { Freeze, Img, OffthreadVideo, staticFile, useVideoConfig } from "remotion";
import { lerp, ramp, settle } from "../motion";
import { c, mono } from "../theme";

/** Wide 16:9, square 1:1, tall 9:16: every scene lays itself out for all three. */
export type Format = "wide" | "square" | "tall";
export const useFormat = (): Format => {
  const { width, height } = useVideoConfig();
  return width > height ? "wide" : width === height ? "square" : "tall";
};

/**
 * The iPhone 17 Pro Max screen in points. capture.ts records it at 3× and
 * keeps 1.5×, so footage and stills are 660 × 1434 and drawn screens use the
 * same 440 × 956 space: a tap ring's coordinates are the app's own layout.
 */
export const SW = 440;
export const SH = 956;
const BEZEL = 12;
export const PW = SW + 2 * BEZEL;
export const PH = SH + 2 * BEZEL;

/** Where the phone sits: its frame's top-left, and its scale. */
export type Place = { x: number; y: number; scale: number; rotY?: number; o?: number };

export const Phone = ({ place, children, glow = 0 }: { place: Place; children: ReactNode; glow?: number }) => (
  <div style={{ position: "absolute", left: place.x, top: place.y, opacity: place.o ?? 1, perspective: 2400 }}>
    <div style={{ transform: `rotateY(${place.rotY ?? 0}deg) scale(${place.scale})`, transformOrigin: "top left" }}>
      <div style={{ width: PW, height: PH, padding: BEZEL, borderRadius: 72, background: "linear-gradient(145deg, #3a352c, #16140f 45%, #2a2620)",
        boxShadow: `0 60px 120px rgba(0,0,0,.7), 0 0 0 1px #4a443a, 0 0 ${120 * glow}px rgba(232,163,61,${0.3 * glow})` }}>
        <div style={{ position: "relative", width: SW, height: SH, borderRadius: 60, overflow: "hidden", background: c.void }}>
          {children}
          {/* The Dynamic Island, where the device has it: recordings with a black mask show only a hole. */}
          <div style={{ position: "absolute", left: (SW - 125) / 2, top: 11, width: 125, height: 37, borderRadius: 19, background: "#000", zIndex: 30 }} />
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 31, background: "linear-gradient(115deg, rgba(255,255,255,.05), transparent 32%)" }} />
        </div>
      </div>
    </div>
  </div>
);

/**
 * Footage from capture.ts at clip frame `frame`. Every frame is looked up, so
 * a scene can hold the picture where the app is still, or skip a still stretch,
 * without a visible cut: Maestro's pauses between taps are not the video's pace.
 */
export const Footage = ({ name, frame }: { name: string; frame: number }) => (
  <Freeze frame={Math.max(0, Math.round(frame))}>
    <OffthreadVideo src={staticFile(`phone/${name}.mp4`)} muted style={{ position: "absolute", inset: 0, width: SW, height: SH }} />
  </Freeze>
);

export const Shot = ({ name }: { name: string }) => (
  <Img src={staticFile(`phone/${name}.png`)} style={{ position: "absolute", inset: 0, width: SW, height: SH }} />
);

/**
 * Scene frame → clip frame, through [scene, clip] points: linear between
 * points, held before the first, and running at speed one after the last.
 * Two points with the same clip frame hold the picture.
 */
export const remap = (f: number, points: [number, number][]) => {
  if (f <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [s0, c0] = points[i - 1], [s1, c1] = points[i];
    if (f <= s1) return c0 + ((f - s0) / (s1 - s0)) * (c1 - c0);
  }
  const [sl, cl] = points[points.length - 1];
  return cl + (f - sl);
};

/** Screens stacked in order, each fading in over the one before it from its `at`. */
export const Screens = ({ f, layers }: { f: number; layers: { at: number; until: number; fade?: number; node: () => ReactNode }[] }) => (
  <>
    {layers.map((l, i) => {
      if (f < l.at || f >= l.until) return null;
      const o = i === 0 ? 1 : ramp(f, l.at, l.fade ?? 6);
      return <div key={i} style={{ position: "absolute", inset: 0, opacity: o }}>{l.node()}</div>;
    })}
  </>
);

/** The status bar drawn over a screen that is not footage. */
export const StatusBar = ({ color = c.text }: { color?: string }) => (
  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 58, zIndex: 20, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 36px 0 52px", color }}>
    <span style={{ fontSize: 17, fontWeight: 600 }}>9:41</span>
    <span style={{ display: "flex", gap: 7, alignItems: "center" }}>
      <svg width="19" height="12" viewBox="0 0 18 12"><path d="M1 11h2V8H1zM5 11h2V6H5zM9 11h2V3H9zM13 11h2V0h-2z" fill={color} /></svg>
      <svg width="17" height="12" viewBox="0 0 17 12"><path d="M8.5 2.2c2.4 0 4.6.9 6.2 2.5l1.2-1.2C13.9 1.5 11.3.5 8.5.5S3.1 1.5 1.1 3.5l1.2 1.2C3.9 3.1 6.1 2.2 8.5 2.2Zm0 3.4c1.5 0 2.8.6 3.8 1.5l1.2-1.2c-1.3-1.3-3.1-2-5-2s-3.7.7-5 2l1.2 1.2c1-.9 2.3-1.5 3.8-1.5Zm0 3.4c.6 0 1.1.2 1.5.6L8.5 11 7 9.6c.4-.4.9-.6 1.5-.6Z" fill={color} /></svg>
      <span style={{ width: 27, height: 13, borderRadius: 4, border: `1.5px solid ${color}88`, padding: 1.5, display: "flex" }}>
        <span style={{ flex: 1, background: color, borderRadius: 2 }} />
      </span>
    </span>
  </div>
);

/** A finger tap in screen points: a ring that lands, presses and fades. */
export const Tap = ({ f, at, x, y }: { f: number; at: number; x: number; y: number }) => {
  const t = f - at;
  if (t < -8 || t > 22) return null;
  const inn = ramp(f, at - 8, 8);
  const out = ramp(f, at + 4, 16);
  return (
    <div style={{ position: "absolute", left: x - 30, top: y - 30, width: 60, height: 60, borderRadius: 30, zIndex: 25,
      background: "rgba(240,239,234,.22)", border: "2px solid rgba(240,239,234,.65)",
      opacity: inn * (1 - out), transform: `scale(${(t < 0 ? 1.3 - inn * 0.3 : 1 - Math.min(t, 4) * 0.04) + out * 0.8})` }} />
  );
};

/** Caption block: mono eyebrow, a large headline and an optional line beneath, placed for the format. */
export const Caption = ({ format, eyebrow, title, sub, o, rise, style, top = false }: {
  format: Format; eyebrow?: ReactNode; title: ReactNode; sub?: ReactNode; o: number; rise: number; style?: CSSProperties;
  /** Wide and square captions sit at the top instead of beside the phone (scenes with a second window). */
  top?: boolean;
}) => {
  const box: CSSProperties =
    format === "tall" ? { left: 80, right: 80, top: 130 }
    : top ? { left: format === "wide" ? 130 : 60, right: format === "wide" ? 130 : 60, top: format === "wide" ? 70 : 52 }
    : format === "wide" ? { left: 130, top: 0, bottom: 0, width: 760, justifyContent: "center" }
    : { left: 60, top: 0, bottom: 0, width: 470, justifyContent: "center" };
  const size = format === "wide" ? (top ? 72 : 84) : format === "square" ? (top ? 54 : 58) : 80;
  return (
    <div style={{ position: "absolute", display: "flex", flexDirection: "column", opacity: o, transform: `translateY(${rise}px)`, ...box, ...style }}>
      {eyebrow ? <div style={{ fontFamily: mono, fontSize: format === "square" ? 21 : 25, color: c.amber, marginBottom: format === "square" ? 14 : 22, letterSpacing: ".02em" }}>{eyebrow}</div> : null}
      <div style={{ fontSize: size, fontWeight: 600, letterSpacing: "-0.045em", lineHeight: 1.03, textWrap: "balance" }}>{title}</div>
      {sub ? <div style={{ fontSize: format === "square" ? 24 : format === "tall" ? 32 : 29, lineHeight: 1.42, color: c.muted, marginTop: format === "square" ? 16 : 24, textWrap: "pretty" }}>{sub}</div> : null}
    </div>
  );
};

/** A caption's fade and rise for a scene from `start` to `end`. */
export const capIn = (f: number, start: number, end: number, last = false) => ({
  o: last ? ramp(f, start + 4, 12) : Math.min(ramp(f, start + 4, 12), 1 - ramp(f, end - 10, 10)),
  rise: (1 - ramp(f, start + 4, 16)) * 22,
});

/** A pill that ticks on at `at`: the setup scene's promises, the end card's facts. */
export const Chip = ({ f, at, children, size = 22 }: { f: number; at: number; children: ReactNode; size?: number }) => {
  const ok = ramp(f, at, 8);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "10px 18px", borderRadius: 999, fontFamily: mono, fontSize: size,
      border: `1px solid ${ok > 0.5 ? c.sage : c.line}`, background: ok > 0.5 ? "rgba(95,184,138,.08)" : "transparent", color: ok > 0.5 ? c.text : c.muted,
      opacity: lerp(ok, 0.45, 1), transform: `translateY(${(1 - ok) * 8}px)` }}>
      <span style={{ color: c.sage, opacity: ok }}>✓</span>{children}
    </span>
  );
};

/** Moves from one place to another from `at`, settling without overshoot. */
export const between = (f: number, at: number, a: Place, b: Place): Place => {
  if (f <= at) return a;
  const t = settle(f, at);
  return { x: lerp(t, a.x, b.x), y: lerp(t, a.y, b.y), scale: lerp(t, a.scale, b.scale), rotY: lerp(t, a.rotY ?? 0, b.rotY ?? 0), o: lerp(t, a.o ?? 1, b.o ?? 1) };
};
