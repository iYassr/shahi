import { AbsoluteFill, Html5Audio, staticFile, useCurrentFrame } from "remotion";
import { lerp, ramp } from "../motion";
import { c, sans } from "../theme";
import { useFormat } from "./kit";
import { Captions, EndCard, PhoneStage, Windows } from "./scenes";
import { T } from "./timeline";

/**
 * The phone cut: the terminal problem, then the app itself (Reader, one-tap
 * answers, every agent, herdr's workspace, setup, SSH, notifications,
 * dictation, the rest) and the end card. Footage is the 1.1.2 Release build on
 * a simulator against the showcase fixture (capture/capture.ts).
 */
export const PhoneCut = () => {
  const f = useCurrentFrame();
  const format = useFormat();
  return (
    <AbsoluteFill style={{ background: c.void, fontFamily: sans, color: c.text, overflow: "hidden" }}>
      {/* Music, effects and the voice-over, rendered from the same timeline by audio/phone.ts. */}
      <Html5Audio src={staticFile("audio/phone.wav")} />
      <Backdrop f={f} />
      <Windows f={f} format={format} />
      <Captions f={f} format={format} />
      <PhoneStage f={f} format={format} />
      <EndCard f={f} format={format} />
      {/* Fade in from and out to black so the loop on a feed does not jump. */}
      <AbsoluteFill style={{ background: "#000", opacity: Math.max(1 - ramp(f, 0, 8), ramp(f, T.total - 12, 12)), pointerEvents: "none" }} />
    </AbsoluteFill>
  );
};

/** The launch cut's ground: a slow amber light over a faint grid, under a vignette. */
const Backdrop = ({ f }: { f: number }) => {
  const t = f / T.total;
  const x = lerp(t, 75, 25);
  const y = 45 + Math.sin(t * Math.PI * 2) * 12;
  return (
    <>
      <AbsoluteFill style={{ background: `radial-gradient(60% 55% at ${x}% ${y}%, rgba(232,163,61,.12), transparent 70%)` }} />
      <AbsoluteFill style={{
        backgroundImage: `linear-gradient(${c.line}55 1px, transparent 1px), linear-gradient(90deg, ${c.line}55 1px, transparent 1px)`,
        backgroundSize: "64px 64px", backgroundPosition: `${-f * 0.3}px ${-f * 0.15}px`,
        maskImage: "radial-gradient(70% 70% at 50% 50%, #000, transparent 85%)", WebkitMaskImage: "radial-gradient(70% 70% at 50% 50%, #000, transparent 85%)",
      }} />
      <AbsoluteFill style={{ background: "radial-gradient(120% 100% at 50% 50%, transparent 55%, rgba(0,0,0,.65))" }} />
    </>
  );
};
