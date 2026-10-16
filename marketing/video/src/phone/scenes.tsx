import type { ReactNode } from "react";
import { Img, staticFile } from "remotion";
import { lerp, ramp, settle } from "../motion";
import { c, mono } from "../theme";
import { CameraScreen, DictationScreen, Drag, LockScreen, Pinch, TerminalScreen } from "./drawn";
import { between, capIn, Caption, Chip, Footage, type Format, Phone, type Place, remap, Screens, Shot, SW, Tap } from "./kit";
import { AGENTS, ANSWER, END, HERDR, MORE, PROBLEM, READER, REACH, SETUP, T } from "./timeline";
import { HerdrWindow, InstallWindow } from "./windows";

type P = { f: number; format: Format };

/* ---------------------------------------------------------------- layout */

type Rect = { x: number; y: number; w: number; h: number };
type Layout = { solo: Place; duo: Place; win: Rect };

/**
 * Where things sit. Solo: the caption beside the phone (above it, tall).
 * Duo: the caption above, the computer's window and a smaller phone below.
 */
const LAYOUT: Record<Format, Layout> = {
  wide: { solo: { x: 1194, y: 84, scale: 0.93 }, duo: { x: 1447, y: 300, scale: 0.74 }, win: { x: 130, y: 330, w: 1100, h: 630 } },
  square: { solo: { x: 588, y: 68, scale: 0.96 }, duo: { x: 750, y: 426, scale: 0.62 }, win: { x: 40, y: 330, w: 680, h: 470 } },
  tall: { solo: { x: 250, y: 590, scale: 1.25 }, duo: { x: 382, y: 1180, scale: 0.68 }, win: { x: 60, y: 600, w: 960, h: 540 } },
};

/** The phone's place at frame `f`: in from below, aside for the computer's windows, out for the end card. */
const placeAt = (f: number, L: Layout): Place => {
  let p = between(f, 0, { ...L.solo, y: L.solo.y + 260, o: 0, rotY: -16 }, { ...L.solo, rotY: -16 });
  // It turns to face you as the terminal becomes a conversation.
  if (f >= T.reader - 4) p = between(f, T.reader - 4, { ...L.solo, rotY: -16 }, L.solo);
  if (f >= T.herdr - 6) p = between(f, T.herdr - 6, L.solo, L.duo);
  if (f >= SETUP.ssh - 6) p = between(f, SETUP.ssh - 6, L.duo, L.solo);
  if (f >= T.end) p = { ...p, y: p.y + ramp(f, T.end, 20) * 160, o: 1 - ramp(f, T.end, 14) };
  return p;
};

/* ----------------------------------------------------------------- phone */

/** One phone for the whole cut; only its screen changes, on the cuts. */
export const PhoneStage = ({ f, format }: P) => {
  if (f >= T.end + 16) return null;
  const L = LAYOUT[format];
  // The terminal, as a thumb meets it: pinch in, drag across, pinch out to see the whole width.
  const zoom = lerp(ramp(f, PROBLEM.pinch, 16), 1, 1.55) * lerp(ramp(f, PROBLEM.squint, 16), 1, 0.44 / 1.55);
  const pan = lerp(ramp(f, PROBLEM.scroll, 16), 0, -520) * (1 - ramp(f, PROBLEM.squint, 16));
  const tasksWeb = { x: 150, y: 245 };

  return (
    <Phone place={placeAt(f, L)} glow={ramp(f, SETUP.connected, 10) * (1 - ramp(f, SETUP.connected + 30, 20))}>
      <Screens f={f} layers={[
        { at: 0, until: T.reader + 8, node: () => (
          <>
            <TerminalScreen zoom={zoom} pan={pan} blur={ramp(f, PROBLEM.squint + 6, 10) * 0.4} />
            <Pinch f={f} at={PROBLEM.pinch} />
            <Drag f={f} at={PROBLEM.scroll} dur={16} dx={-180} />
            <Pinch f={f} at={PROBLEM.squint} out />
          </>
        ) },
        // reader.mp4: mid-push into the conversation, its reply read, then a slow scroll up to the question.
        { at: T.reader, until: T.answer + 8, fade: 8, node: () => (
          <Footage name="reader" frame={remap(f, [[T.reader, 17], [T.reader + 12, 28], [READER.scrollAt, 28], [READER.scrollAt + 50, 76], [T.answer + 8, 76]])} />
        ) },
        { at: T.answer, until: T.agents + 8, fade: 8, node: () => (
          <>
            <Footage name="answer" frame={f < ANSWER.tap + 2 ? 4 : f < ANSWER.working ? 14 : 234} />
            <Tap f={f} at={ANSWER.tap} x={120} y={664} />
          </>
        ) },
        { at: T.agents, until: T.herdr + 8, fade: 8, node: () => {
          const shown = f >= AGENTS.back.at ? AGENTS.back : AGENTS.names.filter((n) => f >= n.at).pop() ?? AGENTS.names[0];
          return (
            <>
              <Footage name="new-agent" frame={shown.clip} />
              {AGENTS.names.filter((n) => n.x).map((n) => <Tap key={n.name} f={f} at={n.at - 2} x={n.x!} y={n.row ? 230 : 177} />)}
              <Tap f={f} at={AGENTS.back.at - 2} x={AGENTS.back.x} y={177} />
            </>
          );
        } },
        // spaces.mp4: the Spaces tab, then tasks-web pushed in, as herdr lights the same space.
        { at: T.herdr, until: T.setup + 8, fade: 8, node: () => (
          <>
            <Footage name="spaces" frame={f < HERDR.spacesTab + 2 ? 10 : f < HERDR.pick + 2 ? 19 : remap(f, [[HERDR.pick + 2, 93], [HERDR.pick + 12, 103]])} />
            <Tap f={f} at={HERDR.spacesTab} x={220} y={904} />
            <Tap f={f} at={HERDR.pick} x={tasksWeb.x} y={tasksWeb.y} />
          </>
        ) },
        { at: T.setup, until: SETUP.camera + 6, fade: 8, node: () => (
          <>
            <Shot name="connect" />
            <Tap f={f} at={SETUP.tap} x={SW / 2} y={842} />
          </>
        ) },
        { at: SETUP.camera, until: SETUP.connected + 8, fade: 6, node: () => <CameraScreen f={f} lockAt={SETUP.lock} lockedAt={SETUP.locked} /> },
        { at: SETUP.connected, until: SETUP.ssh + 8, fade: 8, node: () => <Shot name="agents" /> },
        // ssh.mp4: the SSH form, the host and user typed (a little faster than Maestro types), the keyboard put away.
        { at: SETUP.ssh, until: T.reach + 8, fade: 8, node: () => (
          <Footage name="ssh" frame={remap(f, [[SETUP.ssh, 30], [SETUP.ssh + 14, 52], [SETUP.ssh + 52, 128], [SETUP.ssh + 84, 205], [SETUP.ssh + 92, 205], [SETUP.ssh + 100, 276]])} />
        ) },
        { at: T.reach, until: REACH.open + 8, fade: 8, node: () => (
          <>
            <LockScreen f={f} bannerAt={REACH.banner} />
            <Tap f={f} at={REACH.tapBanner} x={SW / 2} y={336} />
          </>
        ) },
        { at: REACH.open, until: T.more + 8, fade: 8, node: () => (
          <DictationScreen f={f} micAt={REACH.mic} wordsAt={REACH.wordsAt} words={REACH.words} cps={REACH.wordsCps} addAt={REACH.add} sendAt={REACH.send} />
        ) },
        // The rest, one beat each: a diff, slash commands, plan limits, Arabic, Spanish.
        { at: MORE.beats[0], until: MORE.beats[1] + 6, fade: 8, node: () => (
          <>
            <Footage name="changes" frame={remap(f, [[MORE.beats[0], 30], [MORE.beats[0] + 8, 42], [MORE.beats[0] + 24, 57]])} />
            <Tap f={f} at={MORE.beats[0] + 6} x={120} y={238} />
          </>
        ) },
        { at: MORE.beats[1], until: MORE.beats[2] + 6, fade: 6, node: () => (
          <>
            <Footage name="slash" frame={remap(f, [[MORE.beats[1], 0], [MORE.beats[1] + 8, 8], [MORE.beats[1] + 9, 9], [MORE.beats[1] + 23, 23]])} />
            <Tap f={f} at={MORE.beats[1] + 7} x={32} y={826} />
          </>
        ) },
        { at: MORE.beats[2], until: MORE.beats[3] + 6, fade: 6, node: () => <Shot name="usage" /> },
        { at: MORE.beats[3], until: MORE.beats[4] + 6, fade: 6, node: () => <Shot name="arabic" /> },
        { at: MORE.beats[4], until: T.end + 16, fade: 6, node: () => <Shot name="spanish" /> },
      ]} />
    </Phone>
  );
};

/* ------------------------------------------------------- computer windows */

export const Windows = ({ f, format }: P) => {
  if (f < T.herdr - 4 || f >= SETUP.ssh + 4) return null;
  const { win } = LAYOUT[format];
  const enter = settle(f, T.herdr);
  const leave = ramp(f, SETUP.ssh - 10, 12);
  const swap = ramp(f, T.setup - 6, 10);
  return (
    <div style={{ position: "absolute", left: win.x, top: win.y + (1 - enter) * 60, opacity: enter * (1 - leave) }}>
      <div style={{ position: "absolute", opacity: 1 - swap }}><HerdrWindow f={f} w={win.w} h={win.h} pick={HERDR.pick} /></div>
      <div style={{ position: "absolute", opacity: swap, transform: `translateY(${(1 - swap) * 20}px)` }}><InstallWindow f={f} w={win.w} h={win.h} /></div>
    </div>
  );
};

/* -------------------------------------------------------------- captions */

const Word = ({ f, at, children, color = c.text }: { f: number; at: number; children: ReactNode; color?: string }) => {
  const a = ramp(f, at, 12);
  return <span style={{ display: "inline-block", marginRight: "0.24em", color, opacity: a, filter: `blur(${(1 - a) * 10}px)`, transform: `translateY(${(1 - a) * 18}px)` }}>{children}</span>;
};

export const Captions = ({ f, format }: P) => {
  const narrow = format === "square";
  const chipSize = format === "square" ? 17 : format === "tall" ? 22 : 20;
  const row = (children: ReactNode) => <div style={{ display: "flex", flexWrap: "wrap", gap: narrow ? 8 : 12, marginTop: narrow ? 16 : 26 }}>{children}</div>;
  const scene = (from: number, to: number, node: (cap: { o: number; rise: number }) => ReactNode, last = false) =>
    f >= from - 2 && f < to + 2 ? node(capIn(f, from, to, last)) : null;

  return (
    <>
      {scene(T.problem, T.reader, (cap) => (
        <Caption format={format} {...cap} eyebrow="Checking on your agents from your phone?"
          title={<><Word f={f} at={PROBLEM.pinch - 4}>Pinch.</Word><Word f={f} at={PROBLEM.scroll - 4}>Scroll.</Word><Word f={f} at={PROBLEM.squint - 4} color={c.amber}>Squint.</Word></>}
          sub={<span style={{ opacity: ramp(f, PROBLEM.squint + 8, 12) }}>A terminal made for a big screen, on a small one.</span>} />
      ))}
      {scene(T.reader, T.answer, (cap) => (
        <Caption format={format} {...cap} eyebrow="Reader" title={<>A conversation, <span style={{ color: c.amber }}>not a terminal.</span></>}
          sub="Replies, code and tables from your agent's own transcript, laid out for a phone." />
      ))}
      {scene(T.answer, T.agents, (cap) => (
        <Caption format={format} {...cap} eyebrow="One-tap answers" title="Tap to answer."
          sub={<span style={{ color: ramp(f, ANSWER.check, 10) > 0.5 ? c.text : c.muted }}>Shahi reads the agent's live screen again before it presses anything.</span>} />
      ))}
      {scene(T.agents, T.herdr, (cap) => (
        <Caption format={format} {...cap} eyebrow="Every agent" title="The agents you already use."
          sub={<>
            {row(AGENTS.names.map((n) => <Chip key={n.name} f={f} at={n.at} size={chipSize}>{n.name}</Chip>))}
            <div style={{ marginTop: narrow ? 14 : 22, opacity: ramp(f, AGENTS.names[4].at + 6, 12) }}>Start any of them from your phone, with the permissions you choose.</div>
          </>} />
      ))}
      {scene(T.herdr, T.setup, (cap) => (
        <Caption format={format} top {...cap} eyebrow="Built on herdr" title={<>The same workspace <span style={{ color: c.amber }}>as your laptop.</span></>}
          sub={format === "square" ? "Every space and pane, live." : "Every space and pane you have open on your computer, live on your phone."} />
      ))}
      {scene(T.setup, SETUP.ssh, (cap) => (
        <Caption format={format} top {...cap} eyebrow="Setup" title="One command. One scan."
          sub={row(["End-to-end encrypted", "No VPN", "No port forwarding", "No account"].map((t, i) => <Chip key={t} f={f} at={SETUP.chips[i]} size={chipSize}>{t}</Chip>))} />
      ))}
      {scene(SETUP.ssh, T.reach, (cap) => (
        <Caption format={format} {...cap} eyebrow="Or use SSH" title="No one in between."
          sub="Connect straight to your computer with a password or a key. The tunnel is built into the app." />
      ))}
      {scene(T.reach, REACH.dictate, (cap) => (
        <Caption format={format} {...cap} eyebrow="Notifications" title="Know when an agent needs you." />
      ))}
      {scene(REACH.dictate, T.more, (cap) => (
        <Caption format={format} {...cap} eyebrow="Dictation" title="Say your reply."
          sub="On the iPhone itself, in English, with iOS 26. Nothing is sent until you tap Send." />
      ))}
      {scene(T.more, T.end, (cap) => {
        const items = ["Every diff", "Slash commands", "Plan limits", <>English, <span style={{ fontFamily: "system-ui" }}>العربية</span>, Español</>];
        const beat = f >= MORE.beats[3] ? 3 : f >= MORE.beats[2] ? 2 : f >= MORE.beats[1] ? 1 : 0;
        return (
          <Caption format={format} {...cap} eyebrow="And the rest" title="Everything else, too."
            sub={<div style={{ display: "flex", flexDirection: "column", gap: narrow ? 6 : 10, marginTop: 4 }}>
              {items.map((t, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, color: i === beat ? c.text : c.muted, opacity: i <= beat ? 1 : 0.35 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 5, background: i === beat ? c.amber : c.line, flex: "none" }} />{t}
                </div>
              ))}
            </div>} />
        );
      }, true)}
    </>
  );
};

/* ------------------------------------------------------------------- end */

export const EndCard = ({ f, format }: P) => {
  if (f < T.end - 2) return null;
  const wide = format === "wide";
  const mark = settle(f, END.mark);
  const line = ramp(f, END.line, 16);
  const url = ramp(f, END.url, 14);
  const size = wide ? 112 : format === "tall" ? 120 : 96;
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 60 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 22, opacity: mark, transform: `scale(${lerp(mark, 0.9, 1)})` }}>
        <Img src={staticFile("mark.svg")} style={{ width: size, height: size }} />
        <Img src={staticFile("wordmark.svg")} style={{ height: size }} />
      </div>
      <div style={{ fontSize: wide ? 66 : format === "tall" ? 72 : 54, fontWeight: 600, letterSpacing: "-0.045em", marginTop: 34, opacity: line, transform: `translateY(${(1 - line) * 18}px)`, maxWidth: 1000, lineHeight: 1.08 }}>
        Your agents, <span style={{ color: c.amber }}>on your phone.</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14, marginTop: 36, maxWidth: 940 }}>
        {["End-to-end encrypted", "No VPN · no account", "Open source · MIT"].map((t, i) => (
          <Chip key={t} f={f} at={END.chips[i]} size={wide ? 22 : 20}>{t}</Chip>
        ))}
      </div>
      <div style={{ marginTop: 44, opacity: url, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
        <div style={{ fontFamily: mono, fontSize: wide ? 24 : 21, padding: "14px 26px", borderRadius: 12, background: c.surface, border: `1px solid ${c.line}` }}>
          <span style={{ color: c.amber }}>$ </span>{SETUP.cmd}
        </div>
        <div style={{ fontSize: wide ? 36 : 34, fontWeight: 600, color: c.amber, letterSpacing: "-0.02em" }}>getshahi.dev</div>
        <div style={{ fontSize: wide ? 24 : 22, color: c.muted }}>Free on the App Store, for iPhone.</div>
      </div>
    </div>
  );
};
