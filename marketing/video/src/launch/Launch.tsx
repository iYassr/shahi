import { AbsoluteFill, Html5Audio, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { lerp, ramp } from "../motion";
import { c, sans } from "../theme";
import { T } from "./timeline";
import { Chat, End, Herdr, Hook, Problem, Setup } from "./scenes";

/** The launch cut: hook, the terminal problem, setup, the chat, herdr, end card. */
export const Launch = () => {
  const f = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const wide = width > height;
  return (
    <AbsoluteFill style={{ background: c.void, fontFamily: sans, color: c.text, overflow: "hidden" }}>
      {/* Music, effects and the voice-over in one mix, rendered from the same timeline by audio/generate.ts. */}
      <Html5Audio src={staticFile("audio/launch.wav")} />
      <Backdrop f={f} />
      <Hook f={f} wide={wide} />
      <Problem f={f} wide={wide} />
      <Setup f={f} wide={wide} />
      <Chat f={f} wide={wide} />
      <Herdr f={f} wide={wide} />
      <End f={f} wide={wide} />
      {/* Fade in from and out to black so the loop on a feed does not jump. */}
      <AbsoluteFill style={{ background: "#000", opacity: Math.max(1 - ramp(f, 0, 10), ramp(f, T.total - 12, 12)), pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};

/** A slow amber light drifting over a faint grid, under a vignette. */
const Backdrop = ({ f }: { f: number }) => {
  const t = f / T.total;
  const x = lerp(t, 20, 80);
  const y = 40 + Math.sin(t * Math.PI * 2) * 12;
  return (
    <>
      <AbsoluteFill style={{ background: `radial-gradient(60% 55% at ${x}% ${y}%, rgba(232,163,61,.13), transparent 70%)` }} />
      <AbsoluteFill style={{
        backgroundImage: `linear-gradient(${c.line}55 1px, transparent 1px), linear-gradient(90deg, ${c.line}55 1px, transparent 1px)`,
        backgroundSize: "64px 64px", backgroundPosition: `${-f * 0.3}px ${-f * 0.15}px`,
        maskImage: "radial-gradient(70% 70% at 50% 50%, #000, transparent 85%)", WebkitMaskImage: "radial-gradient(70% 70% at 50% 50%, #000, transparent 85%)",
      }} />
      <AbsoluteFill style={{ background: "radial-gradient(120% 100% at 50% 50%, transparent 55%, rgba(0,0,0,.65))" }} />
    </>
  );
};
