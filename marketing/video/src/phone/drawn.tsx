// Screens drawn rather than recorded, for what the simulator cannot show: a
// terminal app on a phone (the problem, and no real product's interface), the
// camera reading a code, a notification on the lock screen, and dictation,
// which needs an iPhone that runs Apple's SpeechTranscriber. Dictation follows
// mobile/src/components/dictation.tsx: the meter, "Listening · m:ss", settled
// words with tentative ones dimmed, Cancel and Add.

import type { ReactNode } from "react";
import { Img, staticFile } from "remotion";
import { lerp, ramp, settle, typed } from "../motion";
import { c, mono, sans } from "../theme";
import { QR } from "../launch/kit";
import { SH, StatusBar, SW, Tap } from "./kit";

/* --------------------------------------------------------------- terminal */

const COLS = 146;
const rule = "─".repeat(COLS);
const boxed = (rows: string[]) => ["╭" + "─".repeat(COLS - 2) + "╮", ...rows.map((r) => "│" + r.padEnd(COLS - 2) + "│"), "╰" + "─".repeat(COLS - 2) + "╯"];

// The same conversation the Reader shows next, as a 146-column terminal draws it.
const TTY = [
  ...boxed([" ✻ Welcome to Claude Code!".padEnd(100) + "cwd: /Users/maya/code/tasks-web"]),
  "",
  "> Why is the due-date test flaky on CI? Fix it.",
  "",
  "● Read(src/tasks/due.ts)",
  "  ⎿  Read 31 lines (ctrl+o to expand)",
  "",
  "● Search(pattern: \"new Date\\(\\)\", path: \"src\")",
  "  ⎿  Found 1 file (ctrl+o to expand)",
  "",
  "● Found it. isDueSoon() reads the real clock, and the test's task is due at 18:00. Runs between 16:00 and 18:00 see a due soon badge: about one run in ten.",
  "",
  "● Update(src/tasks/due.ts)",
  "  ⎿  Updated src/tasks/due.ts with 12 additions and 6 removals",
  "        4 -export function isDueSoon(task: Task) {",
  "        4 +export function isDueSoon(",
  "        5 +  task: Task,",
  "        6 +  now = new Date(),",
  "",
  "● Bash(bun test src/tasks --rerun-each 50)",
  "  ⎿  412 pass",
  "     0 fail",
  "",
  "● Fixed. The badge test now passes a fixed clock, and 50 runs in a row pass where one in ten failed before. Want me to look for other tests that read the clock?",
  "",
  "✻ Worked for 8m 34s",
  "",
  rule,
  "> ",
  rule,
  "  ~/code/tasks-web (fix/due-soon-clock) · ctx 31%".padEnd(104) + "⏵⏵ accept edits on (shift+tab to cycle)",
];

const ttyColor = (l: string) =>
  l.startsWith(">") ? c.text : l.startsWith("●") ? "#e0d9cf" : /^\s+\d+ -/.test(l) ? c.terracotta : /^\s+\d+ \+/.test(l) ? c.sage : l.startsWith("✻") ? c.amber : undefined;

/**
 * A terminal app squeezed onto the phone. `zoom` and `pan` are what a thumb
 * does to it: pinch in, scroll sideways, pinch out to see it all.
 */
export const TerminalScreen = ({ zoom, pan, blur = 0 }: { zoom: number; pan: number; blur?: number }) => (
  <div style={{ position: "absolute", inset: 0, background: "#0b0a09" }}>
    <StatusBar />
    <div style={{ position: "absolute", top: 58, left: 0, right: 0, height: 44, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px", fontFamily: mono, fontSize: 13, color: c.muted, borderBottom: `1px solid ${c.line}` }}>
      <span>maya@workstation</span><span>ssh · 146×42</span>
    </div>
    <div style={{ position: "absolute", top: 104, left: 0, right: 0, bottom: 312, overflow: "hidden" }}>
      <div style={{ transform: `translateX(${pan}px) scale(${zoom})`, transformOrigin: "top left", fontFamily: mono, fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre", color: "#cfcac2", padding: "8px 10px", width: 1000, filter: blur ? `blur(${blur}px)` : undefined }}>
        {TTY.map((l, i) => <div key={i} style={{ color: ttyColor(l) }}>{l || " "}</div>)}
      </div>
    </div>
    {/* The horizontal scroll thumb: the tell-tale of text that does not fit. */}
    <div style={{ position: "absolute", bottom: 300, left: 18, right: 18, height: 4, borderRadius: 2, background: c.line }}>
      <div style={{ position: "absolute", top: 0, height: 4, width: lerp(Math.min(1, 1 / zoom), 60, 300), borderRadius: 2, background: c.muted, left: Math.min(300, Math.max(0, (-pan / 600) * 300)) }} />
    </div>
    <Keyboard />
  </div>
);

const Keyboard = () => {
  const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 292, background: "#1f1c18", padding: "8px 5px", fontFamily: sans }}>
      <div style={{ display: "flex", gap: 6, padding: "0 4px 9px", fontFamily: mono, fontSize: 13, color: c.muted }}>
        {["esc", "tab", "ctrl", "alt", "↑", "↓", "←", "→"].map((k) => (
          <span key={k} style={{ flex: 1, textAlign: "center", padding: "7px 0", borderRadius: 6, background: c.steeped }}>{k}</span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r} style={{ display: "flex", justifyContent: "center", gap: 6, marginBottom: 10 }}>
          {r.split("").map((k) => (
            <span key={k} style={{ width: 37, height: 46, borderRadius: 7, background: "#3b3731", display: "grid", placeItems: "center", fontSize: 21 }}>{k}</span>
          ))}
        </div>
      ))}
    </div>
  );
};

/** Two fingertips spreading (in) or closing (out), centred on the terminal. */
export const Pinch = ({ f, at, out = false }: { f: number; at: number; out?: boolean }) => {
  const a = Math.min(ramp(f, at - 6, 6), 1 - ramp(f, at + 16, 6));
  if (a <= 0) return null;
  const t = ramp(f, at, 16);
  const spread = (out ? 1 - t : t) * 80 + 14;
  const dot = (dx: number, dy: number) => (
    <div style={{ position: "absolute", left: SW / 2 - 28 + dx, top: 330 - 28 + dy, width: 56, height: 56, borderRadius: 28, background: "rgba(240,239,234,.2)", border: "2px solid rgba(240,239,234,.6)" }} />
  );
  return <div style={{ position: "absolute", inset: 0, opacity: a, zIndex: 24 }}>{dot(-spread, spread * 0.8)}{dot(spread, -spread * 0.8)}</div>;
};

/** One finger dragging sideways from `at`. */
export const Drag = ({ f, at, dur, dx }: { f: number; at: number; dur: number; dx: number }) => {
  const a = Math.min(ramp(f, at - 6, 6), 1 - ramp(f, at + dur, 8));
  if (a <= 0) return null;
  const x = SW / 2 + 70 + dx * ramp(f, at, dur);
  return <div style={{ position: "absolute", left: x - 28, top: 330 - 28, width: 56, height: 56, borderRadius: 28, zIndex: 24, opacity: a, background: "rgba(240,239,234,.2)", border: "2px solid rgba(240,239,234,.6)" }} />;
};

/* ----------------------------------------------------------------- camera */

/** The app's scanner reading the installer's code; brackets turn green when it locks. */
export const CameraScreen = ({ f, lockAt, lockedAt }: { f: number; lockAt: number; lockedAt: number }) => {
  const lock = ramp(f, lockAt, lockedAt - lockAt);
  return (
    <div style={{ position: "absolute", inset: 0, background: "radial-gradient(80% 60% at 50% 45%, #2a2620, #0b0a09)" }}>
      <StatusBar />
      <div style={{ position: "absolute", left: SW / 2 - 120, top: SH / 2 - 170, transform: `perspective(700px) rotateX(${lerp(lock, 16, 0)}deg) rotate(${lerp(lock, -7, 0)}deg) scale(${lerp(lock, 0.82, 1)})`, filter: `blur(${(1 - lock) * 2.5}px)` }}>
        <QR size={216} />
      </div>
      {[0, 1, 2, 3].map((i) => {
        const s = lerp(lock, 180, 134);
        const x = i % 2 ? 1 : -1, y = i > 1 ? 1 : -1;
        return (
          <div key={i} style={{ position: "absolute", left: SW / 2 + x * s - 24, top: SH / 2 - 46 + y * s - 24, width: 48, height: 48,
            borderColor: lock >= 1 ? c.sage : c.text, borderStyle: "solid", borderWidth: 0,
            [`border${y < 0 ? "Top" : "Bottom"}Width`]: 4, [`border${x < 0 ? "Left" : "Right"}Width`]: 4,
            [`border${y < 0 ? "Top" : "Bottom"}${x < 0 ? "Left" : "Right"}Radius`]: 13 }} />
        );
      })}
      <div style={{ position: "absolute", bottom: 110, left: 0, right: 0, textAlign: "center", fontSize: 17, color: c.muted }}>Point at the code on your computer</div>
    </div>
  );
};

/* ------------------------------------------------------------ lock screen */

/**
 * A notification as the computer sends it when an agent starts waiting:
 * "<space> needs you" over the conversation's name (server/lib/push.ts).
 */
export const LockScreen = ({ f, bannerAt }: { f: number; bannerAt: number }) => {
  const b = settle(f, bannerAt);
  return (
    <div style={{ position: "absolute", inset: 0, background: "radial-gradient(90% 60% at 30% 85%, rgba(232,163,61,.35), transparent 70%), radial-gradient(80% 60% at 85% 20%, rgba(139,184,232,.22), transparent 70%), linear-gradient(180deg, #17140f, #0b0a09)" }}>
      <StatusBar />
      <div style={{ position: "absolute", top: 104, left: 0, right: 0, textAlign: "center" }}>
        <div style={{ fontSize: 21, fontWeight: 500, color: "rgba(240,239,234,.85)" }}>Friday 16 October</div>
        <div style={{ fontSize: 108, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1, marginTop: 4 }}>9:41</div>
      </div>
      <div style={{ position: "absolute", left: 14, right: 14, top: 300 + (1 - b) * -60, opacity: b, borderRadius: 26, padding: "14px 16px", display: "flex", gap: 12, alignItems: "flex-start",
        background: "rgba(48,43,36,.72)", backdropFilter: "blur(24px)", boxShadow: "0 12px 30px rgba(0,0,0,.35)", transform: `scale(${lerp(b, 0.96, 1)})` }}>
        <span style={{ width: 40, height: 40, borderRadius: 10, background: c.void, display: "grid", placeItems: "center", flex: "none", border: `1px solid ${c.lineBright}` }}>
          <Img src={staticFile("mark.svg")} style={{ width: 26, height: 26 }} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15 }}>
            <span style={{ fontWeight: 600 }}>tasks-mobile needs you</span>
            <span style={{ color: "rgba(240,239,234,.6)", fontSize: 14 }}>now</span>
          </div>
          <div style={{ fontSize: 15, marginTop: 2, color: "rgba(240,239,234,.92)" }}>Add offline sync</div>
        </div>
      </div>
      <div style={{ position: "absolute", bottom: 10, left: SW / 2 - 70, width: 140, height: 5, borderRadius: 3, background: "rgba(240,239,234,.8)" }} />
    </div>
  );
};

/* -------------------------------------------------------------- dictation */

const Label = ({ children, color = c.muted }: { children: ReactNode; color?: string }) => (
  <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: ".12em", color, marginBottom: 6 }}>{children}</div>
);

/**
 * A conversation with the reply spoken: the microphone beside Send, the live
 * panel above the reply box, then Add, then Send.
 */
export const DictationScreen = ({ f, micAt, wordsAt, words, cps, addAt, sendAt }: {
  f: number; micAt: number; wordsAt: number; words: string; cps: number; addAt: number; sendAt: number;
}) => {
  const listening = f >= micAt + 4 && f < addAt;
  const panel = ramp(f, micAt + 4, 8) * (1 - ramp(f, addAt, 6));
  const said = typed(words, f, wordsAt, cps);
  // Apple's model settles words a moment after it hears them: the newest two stay dim.
  const all = said.split(" ");
  const settledCount = f >= addAt - 10 ? all.length : Math.max(0, all.length - 2);
  const finalized = all.slice(0, settledCount).join(" ");
  const volatile = all.slice(settledCount).join(" ");
  const seconds = Math.max(0, Math.floor((f - micAt - 4) / 30));
  const inField = f >= addAt && f < sendAt + 4;
  const sent = f >= sendAt + 4;
  const level = listening ? 0.45 + 0.4 * Math.abs(Math.sin(f * 0.55)) * (said.length < words.length ? 1 : 0.2) : 0;

  return (
    <div style={{ position: "absolute", inset: 0, background: c.void, fontFamily: sans }}>
      <StatusBar />
      <div style={{ position: "absolute", top: 62, left: 0, right: 0, height: 66, display: "flex", alignItems: "center", padding: "0 20px" }}>
        <div style={{ width: 46, height: 46, borderRadius: 23, background: c.steeped, display: "grid", placeItems: "center" }}>
          <svg width="12" height="20" viewBox="0 0 12 18"><path d="M10 1 2 9l8 8" stroke={c.text} strokeWidth="2.4" fill="none" strokeLinecap="round" /></svg>
        </div>
        <div style={{ flex: 1, textAlign: "center", marginRight: 46 }}>
          <div style={{ fontSize: 16, fontWeight: 500 }}>Add offline sync</div>
          <div style={{ fontFamily: mono, fontSize: 13, color: c.muted }}>Claude · workstation</div>
        </div>
      </div>
      <div style={{ position: "absolute", top: 128, left: 16, right: 16, height: 44, display: "flex", borderBottom: `1px solid ${c.line}`, fontSize: 15 }}>
        {["Read", "Screen", "Changes"].map((t, i) => (
          <div key={t} style={{ flex: 1, textAlign: "center", paddingTop: 10, color: i === 0 ? c.text : c.muted, fontWeight: i === 0 ? 600 : 400, borderBottom: i === 0 ? `2px solid ${c.amber}` : "none" }}>{t}</div>
        ))}
      </div>
      <div style={{ position: "absolute", top: 188, left: 18, right: 18, bottom: 120, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 22 }}>
        <div style={{ fontSize: 14, color: c.muted }}>Activity · 4 steps ▸</div>
        <div>
          <Label>YOU</Label>
          <div style={{ fontSize: 17, lineHeight: 1.45 }}>Queue task changes made offline and send them when the phone reconnects.</div>
        </div>
        <div style={{ fontSize: 14, color: c.muted }}>Activity · 6 steps ▸</div>
        <div>
          <Label>AGENT</Label>
          <div style={{ fontSize: 17, lineHeight: 1.45 }}>The queue is in, and <span style={{ fontFamily: mono, fontSize: 15, background: c.steeped, padding: "1px 5px", borderRadius: 4 }}>flush()</span> stops at the first change it cannot send. Should a failed send retry, or wait for the next launch?</div>
        </div>
        {sent ? (
          <div style={{ opacity: ramp(f, sendAt + 4, 8), transform: `translateY(${(1 - ramp(f, sendAt + 4, 10)) * 12}px)` }}>
            <Label color={c.amber}>YOU</Label>
            <div style={{ fontSize: 17, lineHeight: 1.45 }}>{words}.</div>
          </div>
        ) : null}
        {panel > 0 ? (
          <div style={{ opacity: panel, transform: `translateY(${(1 - panel) * 10}px)`, margin: "0 -10px", padding: 12, borderRadius: 12, background: c.steeped, border: `1px solid ${c.line}`, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 3, height: 22 }}>
                {[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ width: 4, borderRadius: 2, background: c.amber, height: 4 + Math.max(0, level - i * 0.12) * 18 }} />)}
              </div>
              <span style={{ fontSize: 12, color: c.muted }}>Listening · 0:{String(seconds).padStart(2, "0")}</span>
            </div>
            <div style={{ fontSize: 16, lineHeight: "22px", minHeight: 44 }}>
              {said ? <>{finalized}{finalized && volatile ? " " : ""}<span style={{ color: c.muted }}>{volatile}</span></> : <span style={{ color: c.muted }}>Say your reply…</span>}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <span style={{ padding: "11px 14px", fontSize: 15, color: c.amber }}>Cancel</span>
              <span style={{ padding: "11px 18px", fontSize: 15, fontWeight: 600, borderRadius: 8, background: c.amber, color: c.void }}>Add</span>
            </div>
          </div>
        ) : null}
      </div>
      {/* The reply box: attach, the draft, the microphone beside Send. */}
      <div style={{ position: "absolute", left: 12, right: 12, bottom: 34, height: 64, borderRadius: 16, border: `1px solid ${c.line}`, background: c.surface, display: "flex", alignItems: "center", gap: 6, padding: "0 8px" }}>
        <span style={{ width: 40, textAlign: "center", fontSize: 26, color: c.muted }}>+</span>
        <span style={{ flex: 1, fontSize: 16, color: inField ? c.text : c.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{inField ? `${words}.` : "Reply to this agent…"}</span>
        <span style={{ width: 44, height: 44, borderRadius: 10, display: "grid", placeItems: "center", background: listening ? c.amber : "transparent" }}>
          {listening ? (
            <svg width="20" height="20" viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10" stroke={c.void} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24"><path d="M12 19v3M19 10v2a7 7 0 0 1-14 0v-2M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0Z" stroke={c.text} strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          )}
        </span>
        <span style={{ padding: "12px 16px", borderRadius: 10, fontSize: 16, fontWeight: 600, background: inField ? c.amber : "rgba(232,163,61,.3)", color: c.void }}>Send</span>
      </div>
      <Tap f={f} at={micAt} x={SW - 12 - 8 - 70 - 30} y={SH - 34 - 32} />
      <Tap f={f} at={addAt} x={SW - 18 - 10 - 32} y={SH - 120 - 34} />
      <Tap f={f} at={sendAt} x={SW - 12 - 8 - 38} y={SH - 34 - 32} />
    </div>
  );
};
