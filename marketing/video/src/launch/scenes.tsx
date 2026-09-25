import type { ReactNode } from "react";
import { Img, staticFile } from "remotion";
import { lerp, ramp, settle, typed, window } from "../motion";
import { c, mono, sans } from "../theme";
import { AgentIcon, AppHeader, Caption, Device, DH, DW, QR, Status, Tap } from "./kit";
import { CHAT, END, HERDR, HOOK, PROBLEM, SETUP, STEPS, T } from "./timeline";

type P = { f: number; wide: boolean };

/** Places a scaled device; `x`/`y` are the top-left of the scaled frame. */
const Placed = ({ x, y, scale, children, rotY = 0, o = 1 }: { x: number; y: number; scale: number; children: ReactNode; rotY?: number; o?: number }) => (
  <div style={{ position: "absolute", left: x, top: y, opacity: o, perspective: 2200 }}>
    <div style={{ transform: `rotateY(${rotY}deg) scale(${scale})`, transformOrigin: "top left" }}>{children}</div>
  </div>
);

const capIn = (f: number, start: number, end: number) => ({ o: window(f, start + 4, end, 12), rise: (1 - ramp(f, start + 4, 16)) * 22 });

/* ------------------------------------------------------------------ hook */

export const Hook = ({ f, wide }: P) => {
  // A short fade at the very end: the voice's "didn't" runs to the cut, and a
  // longer fade took the words off screen while they were being said.
  const o = 1 - ramp(f, T.problem - 6, 6);
  if (o <= 0) return null;
  const word = (w: string, at: number, color: string) => {
    const a = ramp(f, at, 14);
    return (
      <span key={w + at} style={{ display: "inline-block", marginRight: "0.24em", color, opacity: a, filter: `blur(${(1 - a) * 12}px)`, transform: `translateY(${(1 - a) * 24}px)` }}>{w}</span>
    );
  };
  const size = wide ? 132 : 104;
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", justifyContent: "center", padding: wide ? "0 170px" : "0 80px", opacity: o, transform: `scale(${lerp(ramp(f, 0, T.problem), 1, 1.05)})` }}>
      <div style={{ fontSize: size, fontWeight: 600, letterSpacing: "-0.05em", lineHeight: 1.02 }}>
        {HOOK.line1.split(" ").map((w, i) => word(w, HOOK.line1At + i * HOOK.stagger, c.text))}
      </div>
      <div style={{ fontSize: size, fontWeight: 600, letterSpacing: "-0.05em", lineHeight: 1.02 }}>
        {HOOK.line2.split(" ").map((w, i) => word(w, HOOK.line2At + i * HOOK.stagger, c.amber))}
      </div>
    </div>
  );
};

/* --------------------------------------------------------------- problem */

// A Claude Code box drawn the way the terminal draws it: every row padded to the border.
const box = (rows: string[], w = 94) => ["╭" + "─".repeat(w) + "╮", ...rows.map((r) => "│" + r.padEnd(w) + "│"), "╰" + "─".repeat(w) + "╯"];

const ttyLines = [
  ...box([" ✻ Welcome to Claude Code!".padEnd(63) + "cwd: /Users/you/work/api"]),
  "> Ship the billing migration. Run the tests before you finish, and open a PR against main when green.",
  "⏺ Update(src/billing/invoice.ts)",
  "  ⎿  Updated src/billing/invoice.ts with 12 additions and 3 removals",
  "      41 -   const total = lines.reduce((sum, l) => sum + l.amount, 0); // currency assumed USD for every acc",
  "      41 +   const total = sumInCurrency(lines, invoice.currency); // per-invoice currency from 0042_invoice_c",
  "⏺ Bash(bun run db:migrate && bun test --coverage --reporter=dots src/billing src/payments src/ledger)",
  "  ⎿  Running…",
  ...box([
    " Bash command",
    "   bun test && bun run deploy:staging --region eu-west-1 --confirm",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for bun commands in /Users/you/work/api",
    "   3. No, and tell Claude what to do differently (esc)",
  ]),
];

export const Problem = ({ f, wide }: P) => {
  const lf = f - T.problem;
  if (lf < -4 || f > T.setup + 4) return null;
  const cap = capIn(f, T.problem, T.setup);
  const enter = settle(f, T.problem);
  const leave = ramp(f, T.setup - 16, 16);
  // The thumb pans the wide terminal left and back: the only way to read it.
  const pan = lerp(ramp(f, PROBLEM.panOut, 34), 0, -520) + lerp(ramp(f, PROBLEM.panBack, 30), 0, 300);
  const zoom = lerp(ramp(f, PROBLEM.pinch, 20), 1, 1.18);
  const scale = wide ? 0.98 : 0.74;
  return (
    <>
      <Caption wide={wide} {...cap} eyebrow="Termius. Blink. Every SSH app." title="Pinch. Scroll. Squint."
        sub={wide ? "A terminal built for a 27-inch screen, squeezed onto your phone. You can see the agent. You can't really talk to it." : "A desktop terminal, squeezed onto your phone."} />
      <Placed x={wide ? 1150 : 380} y={wide ? 100 + (1 - enter) * 200 : 290 + (1 - enter) * 200} scale={scale} rotY={lerp(enter, -28, -12)} o={enter * (1 - leave)}>
        <Device>
          <div style={{ position: "absolute", top: 54, left: 0, right: 0, height: 40, display: "flex", alignItems: "center", padding: "0 18px", fontFamily: mono, fontSize: 13, color: c.muted, borderBottom: `1px solid ${c.line}` }}>
            ssh you@macbook-pro · 146×36
          </div>
          <div style={{ position: "absolute", top: 100, left: 0, right: 0, bottom: 300, overflow: "hidden" }}>
            <div style={{ transform: `translateX(${pan}px) scale(${zoom})`, transformOrigin: "top left", fontFamily: mono, fontSize: 11.5, lineHeight: 1.55, whiteSpace: "pre", color: "#cfcac2", padding: "8px 10px", width: 1100 }}>
              {ttyLines.map((l, i) => (
                <div key={i} style={{ color: l.startsWith(">") ? c.text : l.includes("❯") ? c.amber : l.startsWith("⏺") ? "#e0d9cf" : undefined }}>{l}</div>
              ))}
            </div>
          </div>
          {/* Horizontal scroll thumb: the tell-tale of text that does not fit. */}
          <div style={{ position: "absolute", bottom: 290, left: 16, right: 16, height: 4, borderRadius: 2, background: c.line }}>
            <div style={{ position: "absolute", top: 0, height: 4, width: 110, borderRadius: 2, background: c.muted, left: 8 + (-pan / 520) * 220 }} />
          </div>
          <Keyboard />
          <Pinch f={f} at={PROBLEM.pinch} />
        </Device>
      </Placed>
    </>
  );
};

const Keyboard = () => {
  const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 282, background: "#1f1c18", padding: "8px 4px", fontFamily: sans }}>
      <div style={{ display: "flex", gap: 6, padding: "0 4px 8px", fontFamily: mono, fontSize: 12, color: c.muted }}>
        {["esc", "tab", "ctrl", "↑", "↓", "…"].map((k) => (
          <span key={k} style={{ flex: 1, textAlign: "center", padding: "6px 0", borderRadius: 6, background: c.steeped }}>{k}</span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r} style={{ display: "flex", justifyContent: "center", gap: 5, marginBottom: 9 }}>
          {r.split("").map((k) => (
            <span key={k} style={{ width: 33, height: 42, borderRadius: 6, background: "#3b3731", display: "grid", placeItems: "center", fontSize: 19 }}>{k}</span>
          ))}
        </div>
      ))}
    </div>
  );
};

const Pinch = ({ f, at }: { f: number; at: number }) => {
  const a = window(f, at - 6, at + 30, 6);
  if (a <= 0) return null;
  const spread = ramp(f, at, 20) * 70;
  const dot = (dx: number, dy: number) => (
    <div style={{ position: "absolute", left: 195 - 26 + dx, top: 300 - 26 + dy, width: 52, height: 52, borderRadius: 26, background: "rgba(240,239,234,.2)", border: "2px solid rgba(240,239,234,.55)" }} />
  );
  return <div style={{ position: "absolute", inset: 0, opacity: a, zIndex: 20 }}>{dot(-spread, spread * 0.8)}{dot(spread, -spread * 0.8)}</div>;
};

/* ----------------------------------------------------------------- setup */

export const Setup = ({ f, wide }: P) => {
  const lf = f - T.setup;
  if (lf < -4 || f > T.chat + 4) return null;
  const cap = capIn(f, T.setup, T.chat);
  const leave = ramp(f, T.chat - 14, 14);
  const tEnter = settle(f, T.setup + 2);
  const pEnter = settle(f, T.setup + 10);
  const popup = ramp(f, SETUP.popup, 12);
  const steps = (["Install", "Pair", "Scan"] as const).map((label, i) => [label, STEPS[i]] as const);

  const term = (
    <div style={{ width: wide ? 640 : 560, borderRadius: 16, overflow: "hidden", background: c.surface, border: `1px solid ${c.lineBright}`, boxShadow: "0 40px 90px rgba(0,0,0,.6)", fontFamily: mono }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 18px", borderBottom: `1px solid ${c.line}`, fontSize: 15, color: c.muted }}>
        {[0, 1, 2].map((i) => <span key={i} style={{ width: 12, height: 12, borderRadius: 6, background: c.lineBright }} />)}
        <span style={{ marginLeft: 10 }}>herdr · ~/work/api</span>
      </div>
      <div style={{ position: "relative", padding: "22px 24px", fontSize: wide ? 19 : 17, lineHeight: 1.7, height: wide ? 470 : 440 }}>
        <div><span style={{ color: c.amber }}>$ </span>{typed(SETUP.cmd1, f, SETUP.cmd1At, SETUP.cmd1Cps)}</div>
        {f >= SETUP.installed ? <div style={{ color: c.sage }}>✓ Installed shahi</div> : null}
        {f >= SETUP.cmd2At - 1 ? <div><span style={{ color: c.amber }}>$ </span>{typed(SETUP.cmd2, f, SETUP.cmd2At, SETUP.cmd2Cps)}</div> : null}
        <div style={{ position: "absolute", left: "50%", top: 128, transform: `translateX(-50%) scale(${lerp(popup, 0.92, 1)})`, opacity: popup, background: c.steeped, border: `1px solid ${c.amber}`, borderRadius: 14, padding: 22, textAlign: "center" }}>
          <QR size={wide ? 190 : 170} />
          <div style={{ fontSize: 15, color: c.muted, marginTop: 12, whiteSpace: "nowrap" }}>Scan with Shahi · once · 10 min</div>
        </div>
      </div>
    </div>
  );

  // Phone: the app's pairing screen, then the camera, then connected.
  const tapAt = SETUP.tap;
  const cam = ramp(f, SETUP.camera, 10);
  const lock = ramp(f, SETUP.lock, SETUP.locked - SETUP.lock);
  const done = ramp(f, SETUP.done, 12);
  const phone = (
    <Device glow={done}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, opacity: 1 - cam }}>
        <Img src={staticFile("mark.svg")} style={{ width: 84, height: 84 }} />
        <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.03em" }}>Connect a computer</div>
        <div style={{ fontSize: 16, color: c.muted, textAlign: "center", padding: "0 40px" }}>Scan the code herdr shows on your computer.</div>
        <div style={{ marginTop: 18, background: c.amber, color: c.void, fontWeight: 600, fontSize: 18, padding: "16px 44px", borderRadius: 14 }}>Scan QR code</div>
      </div>
      <div style={{ position: "absolute", inset: 0, opacity: cam * (1 - done), background: "radial-gradient(80% 60% at 50% 45%, #2a2620, #0b0a09)" }}>
        <div style={{ position: "absolute", left: DW / 2 - 110, top: DH / 2 - 150, transform: `perspective(700px) rotateX(${lerp(lock, 14, 0)}deg) rotate(${lerp(lock, -6, 0)}deg) scale(${lerp(lock, 0.85, 1)})`, filter: `blur(${(1 - lock) * 2.5}px)` }}>
          <QR size={200} />
        </div>
        {[0, 1, 2, 3].map((i) => {
          const s = lerp(lock, 170, 124);
          const x = i % 2 ? 1 : -1, y = i > 1 ? 1 : -1;
          return (
            <div key={i} style={{ position: "absolute", left: DW / 2 + x * s - 22, top: DH / 2 - 34 + y * s - 22, width: 44, height: 44,
              borderColor: lock >= 1 ? c.sage : c.text, borderStyle: "solid", borderWidth: 0,
              [`border${y < 0 ? "Top" : "Bottom"}Width`]: 4, [`border${x < 0 ? "Left" : "Right"}Width`]: 4,
              [`border${y < 0 ? "Top" : "Bottom"}${x < 0 ? "Left" : "Right"}Radius`]: 12 }} />
          );
        })}
        <div style={{ position: "absolute", bottom: 90, left: 0, right: 0, textAlign: "center", fontSize: 16, color: c.muted }}>Point at the code</div>
      </div>
      <div style={{ position: "absolute", inset: 0, opacity: done, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
        <div style={{ width: 96, height: 96, borderRadius: 48, background: "rgba(95,184,138,.15)", display: "grid", placeItems: "center", transform: `scale(${lerp(settle(f, SETUP.done), 0.6, 1)})` }}>
          <svg width="46" height="46" viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10" stroke={c.sage} strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="30" strokeDashoffset={30 * (1 - ramp(f, SETUP.done + 4, 12))} /></svg>
        </div>
        <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.03em" }}>Connected</div>
        <div style={{ fontSize: 16, color: c.muted }}>MacBook Pro · end-to-end encrypted</div>
      </div>
      {/* The measured centre of "Scan QR code" under the two-line subtitle: a text edit above it moves this. */}
      <Tap f={f} at={tapAt} x={DW / 2} y={DH / 2 + 117} />
    </Device>
  );

  const stepper = (
    <div style={{ display: "flex", gap: 14, marginTop: wide ? 40 : 18 }}>
      {steps.map(([label, at]) => {
        const ok = ramp(f, at, 8);
        return (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", borderRadius: 999, border: `1px solid ${ok > 0.5 ? c.sage : c.line}`, background: ok > 0.5 ? "rgba(95,184,138,.08)" : "transparent", fontFamily: mono, fontSize: wide ? 20 : 18, color: ok > 0.5 ? c.text : c.muted }}>
            <span style={{ color: c.sage, opacity: ok }}>✓</span>{label}
          </div>
        );
      })}
    </div>
  );

  return (
    <div style={{ position: "absolute", inset: 0, opacity: 1 - leave }}>
      <Caption wide={wide} {...cap} eyebrow="2 commands · 1 scan" title={wide ? <>Connected in<br />about a minute.</> : "Connected in about a minute."}
        sub={<>{wide ? "Install the herdr plugin. Scan the code. No account, no VPN, no open ports." : "No account, no VPN, no open ports."}{stepper}</>}
        style={wide ? { width: 620 } : undefined} />
      <div style={{ position: "absolute", left: wide ? 760 : 50, top: wide ? 260 : 420, opacity: tEnter, transform: `translateY(${(1 - tEnter) * 60}px)` }}>{term}</div>
      <Placed x={wide ? 1450 : 640} y={wide ? 110 + (1 - pEnter) * 240 : 380 + (1 - pEnter) * 240} scale={wide ? 0.98 : 0.72} o={pEnter}>{phone}</Placed>
    </div>
  );
};

/* ------------------------------------------------------------------ chat */

type Item = { at: number; node: ReactNode };

const You = ({ children }: { children: ReactNode }) => (
  <div style={{ background: c.surface, borderLeft: `3px solid ${c.amber}`, borderRadius: 12, padding: "12px 16px" }}>
    <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: ".12em", color: c.amber, marginBottom: 6 }}>YOU</div>
    <div style={{ fontSize: 16, lineHeight: 1.45 }}>{children}</div>
  </div>
);

const Agent = ({ children }: { children: ReactNode }) => (
  <div>
    <div style={{ fontFamily: mono, fontSize: 11, letterSpacing: ".12em", color: c.muted, marginBottom: 6 }}>CLAUDE</div>
    <div style={{ fontSize: 16, lineHeight: 1.45 }}>{children}</div>
  </div>
);

const Tool = ({ name, arg, children }: { name: string; arg: string; children?: ReactNode }) => (
  <div style={{ border: `1px solid ${c.line}`, borderRadius: 12, overflow: "hidden", fontFamily: mono }}>
    <div style={{ display: "flex", gap: 10, padding: "10px 14px", fontSize: 13, background: c.surface }}>
      <span style={{ color: c.blue }}>{name}</span><span style={{ color: c.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{arg}</span>
    </div>
    {children ? <div style={{ padding: "10px 14px", fontSize: 12.5, lineHeight: 1.6, borderTop: `1px solid ${c.line}` }}>{children}</div> : null}
  </div>
);

export const Chat = ({ f, wide }: P) => {
  const lf = f - T.chat;
  if (lf < -4 || f > T.herdr + 4) return null;
  const cap = capIn(f, T.chat, T.herdr);
  const enter = settle(f, T.chat);
  const leave = ramp(f, T.herdr - 14, 14);
  const tapYes = CHAT.tapYes;
  const answered = ramp(f, CHAT.answered, 6);
  const reply = CHAT.reply;
  const sendAt = CHAT.send;

  const items: Item[] = [
    { at: CHAT.you, node: <You>Ship the billing migration. Run the tests before you finish.</You> },
    { at: CHAT.agent, node: <Agent>I'll apply the migration, then run the suite.</Agent> },
    { at: CHAT.tool, node: (
      <Tool name="Bash" arg="bun run db:migrate">
        {f >= CHAT.toolDone ? <span style={{ color: c.sage }}>✓ 3 tables altered · no rows lost</span> : <span style={{ color: c.muted }}>Running…</span>}
      </Tool>
    ) },
    { at: CHAT.edit, node: (
      <Tool name="Edit" arg="src/billing/invoice.ts  +12 −3">
        <div style={{ color: c.terracotta }}>− const total = sum(lines)</div>
        <div style={{ color: c.sage }}>+ const total = sumIn(lines, currency)</div>
      </Tool>
    ) },
    // Answered in place: the card keeps its height, so the conversation above it
    // does not drop 230 px in one frame and the tap ring stays on the Yes it pressed.
    { at: CHAT.prompt, node: (
      <div style={{ border: `1.5px solid ${answered > 0.5 ? c.sage : c.amber}`, borderRadius: 14, padding: 14, background: "rgba(232,163,61,.05)" }}>
        <div style={{ position: "relative", fontFamily: mono, fontSize: 12 }}>
          <span style={{ color: c.amber, opacity: 1 - answered }}>Bash command</span>
          <span style={{ position: "absolute", left: 0, top: 0, color: c.sage, opacity: answered }}>✓ Answered · Yes</span>
        </div>
        <div style={{ fontFamily: mono, fontSize: 13, margin: "6px 0 10px" }}>bun test && bun run deploy:staging</div>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 10 }}>Do you want to proceed?</div>
        {["Yes", "Yes, don't ask again for bun", "No, tell Claude what to do"].map((o, i) => (
          <div key={o} style={{ padding: "11px 14px", borderRadius: 10, marginTop: 6, fontSize: 15, background: i === 0 ? (f >= tapYes ? c.amber : c.steeped) : c.steeped, color: i === 0 && f >= tapYes ? c.void : c.text, border: `1px solid ${c.line}`, opacity: i === 0 ? 1 : lerp(answered, 1, 0.3) }}>{o}</div>
        ))}
      </div>
    ) },
    { at: CHAT.agentDone, node: <Agent>All 214 tests pass. Staging is live.</Agent> },
    { at: CHAT.sent, node: <You>{reply}</You> },
  ];

  const scale = wide ? 1.04 : 0.8;
  const typing = f >= CHAT.typeAt - 2 && f < CHAT.sent;
  return (
    <div style={{ position: "absolute", inset: 0, opacity: 1 - leave }}>
      <Caption wide={wide} {...cap} eyebrow="Like WhatsApp, for your agents" title="Read. Tap. Done."
        sub={wide ? "Claude Code, Codex and Cursor sessions, formatted for your thumb. Permission prompts become buttons." : "Claude Code, Codex and Cursor, formatted for your thumb."} />
      <Placed x={wide ? 1180 : 540 - ((DW + 22) * scale) / 2} y={wide ? 90 + (1 - enter) * 260 : 300 + (1 - enter) * 260} scale={scale}
        rotY={wide ? lerp(enter, -18, 0) : 0} o={enter}>
        <Device>
          <AppHeader title="Ship the billing migration" sub="claude · api" mode="read" />
          <div style={{ position: "absolute", top: 118, left: 0, right: 0, bottom: 86, overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "flex-end", padding: "0 18px 12px", gap: 0 }}>
            {items.map((it, i) => {
              const a = ramp(f, it.at, 12);
              if (a <= 0) return null;
              return (
                <div key={i} style={{ maxHeight: a * 360, opacity: a, marginTop: a * 16, transform: `translateY(${(1 - a) * 14}px)`, flex: "none" }}>{it.node}</div>
              );
            })}
            {f > CHAT.working ? (
              <div style={{ marginTop: 16, fontFamily: mono, fontSize: 14, color: c.muted, opacity: ramp(f, CHAT.working, 8) }}>
                <span style={{ color: c.terracotta }}>✳</span> <span style={{ color: c.text }}>Working</span> {Math.max(1, Math.floor((f - CHAT.working) / 30) + 1)}s
              </div>
            ) : null}
          </div>
          <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 86, borderTop: `1px solid ${c.line}`, display: "flex", gap: 8, padding: "12px 12px 26px", background: c.void }}>
            <div style={{ width: 46, borderRadius: 10, border: `1px solid ${c.line}`, display: "grid", placeItems: "center", fontSize: 24, color: c.muted }}>+</div>
            <div style={{ flex: 1, borderRadius: 10, border: `1px solid ${typing ? c.lineBright : c.line}`, display: "flex", alignItems: "center", padding: "0 12px", fontFamily: mono, fontSize: 14, color: typing ? c.text : c.muted }}>
              {typing ? typed(reply, f, CHAT.typeAt, CHAT.typeCps) : "Reply to this agent…"}
            </div>
            <div style={{ width: 70, borderRadius: 10, display: "grid", placeItems: "center", fontSize: 15, fontWeight: 600, background: typing ? c.amber : "rgba(232,163,61,.3)", color: c.void }}>Send</div>
          </div>
          <Tap f={f} at={tapYes} x={120} y={614} />
          <Tap f={f} at={sendAt} x={DW - 47} y={DH - 55} />
        </Device>
      </Placed>
    </div>
  );
};

/* ----------------------------------------------------------------- herdr */

const panes = [
  { space: "api", title: "Ship the billing migration", kind: "claude" as const, state: "working" as const },
  { space: "web", title: "Fix the checkout layout", kind: "codex" as const, state: "needs" as const },
  { space: "docs", title: "Update the setup guide", kind: "claude" as const, state: "done" as const },
  { space: "infra", title: "Rotate the staging keys", kind: "codex" as const, state: "working" as const },
];

export const Herdr = ({ f, wide }: P) => {
  const lf = f - T.herdr;
  if (lf < -4 || f > T.end + 4) return null;
  const cap = capIn(f, T.herdr, T.end);
  const enter = settle(f, T.herdr);
  const leave = ramp(f, T.end - 14, 14);
  const W = wide ? 1000 : 600;
  const H = wide ? 540 : 440;
  const scale = wide ? 0.78 : 0.6;
  const px = wide ? 1400 : 700;
  const py = wide ? 330 : 390;
  const winX = wide ? 170 : 40;
  const winY = wide ? 400 : 420;
  const sideW = wide ? 170 : 110;
  const paneW = (W - sideW - 36) / 2;
  const paneH = (H - 70) / 2;

  return (
    <div style={{ position: "absolute", inset: 0, opacity: 1 - leave }}>
      <Caption wide={wide} {...cap} eyebrow="Built on herdr" title="Every space. Every pane. Live."
        sub={wide ? "herdr is the lightweight home for your agents. Shahi mirrors all of it on your phone." : undefined}
        style={wide ? { top: 90, bottom: "auto", justifyContent: "flex-start", width: 1500 } : undefined} />
      <div style={{ position: "absolute", left: winX, top: winY + (1 - enter) * 50, width: W, height: H, opacity: enter, borderRadius: 16, background: c.surface, border: `1px solid ${c.lineBright}`, boxShadow: "0 40px 90px rgba(0,0,0,.6)", overflow: "hidden", fontFamily: mono }}>
        <div style={{ height: 44, display: "flex", alignItems: "center", gap: 8, padding: "0 16px", borderBottom: `1px solid ${c.line}`, color: c.muted, fontSize: 14 }}>
          {[0, 1, 2].map((i) => <span key={i} style={{ width: 11, height: 11, borderRadius: 6, background: c.lineBright }} />)}
          <span style={{ marginLeft: 8 }}>herdr</span>
        </div>
        <div style={{ position: "absolute", top: 44, left: 0, bottom: 0, width: sideW, borderRight: `1px solid ${c.line}`, padding: 14, fontSize: wide ? 15 : 12 }}>
          <div style={{ color: c.muted, fontSize: wide ? 12 : 10, letterSpacing: ".12em", marginBottom: 10 }}>SPACES</div>
          {panes.map((p, i) => (
            <div key={p.space} style={{ padding: "6px 8px", borderRadius: 6, marginBottom: 4, background: i === 0 ? c.steeped : "transparent", color: i === 0 ? c.text : c.muted }}>{p.space}</div>
          ))}
        </div>
        {panes.map((p, i) => {
          const hl = window(f, HERDR.panes[i], HERDR.panes[i] + 26, 6);
          return (
            <div key={p.title} style={{ position: "absolute", left: sideW + 12 + (i % 2) * (paneW + 12), top: 56 + Math.floor(i / 2) * (paneH + 10), width: paneW, height: paneH,
              border: `1px solid ${hl > 0.3 ? c.amber : c.line}`, borderRadius: 10, padding: 12, fontSize: wide ? 13 : 10, overflow: "hidden", background: `rgba(232,163,61,${hl * 0.06})` }}>
              <div style={{ display: "flex", justifyContent: "space-between", color: c.text, marginBottom: 8 }}>
                <span>{p.kind} · {p.space}</span><Status state={p.state} />
              </div>
              {[0.9, 0.7, 0.8, 0.5, 0.65].map((w, j) => (
                <div key={j} style={{ height: wide ? 7 : 5, width: `${w * 100}%`, background: c.line, borderRadius: 3, marginTop: wide ? 10 : 7 }} />
              ))}
            </div>
          );
        })}
      </div>
      <Placed x={px} y={py + (1 - enter) * 120} scale={scale} o={enter}>
        <Device>
          <div style={{ position: "absolute", top: 58, left: 0, right: 0, padding: "10px 20px", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.03em" }}>Agents</span>
            <span style={{ fontSize: 14, color: c.muted }}>MacBook Pro · <span style={{ color: c.sage }}>LIVE</span></span>
          </div>
          <div style={{ position: "absolute", top: 118, left: 20, display: "flex", gap: 8, fontSize: 14 }}>
            {["Inbox", "All", "Spaces"].map((t, i) => (
              <span key={t} style={{ padding: "7px 14px", borderRadius: 999, border: `1px solid ${c.line}`, background: i === 1 ? c.steeped : "transparent", color: i === 1 ? c.text : c.muted }}>{t}</span>
            ))}
          </div>
          <div style={{ position: "absolute", top: 170, left: 0, right: 0 }}>
            {panes.map((p, i) => {
              const a = ramp(f, HERDR.rows[i], 12);
              return (
                <div key={p.title} style={{ display: "flex", gap: 14, alignItems: "center", padding: "16px 20px", borderBottom: `1px solid ${c.line}`, opacity: a, transform: `translateX(${(1 - a) * 40}px)` }}>
                  <AgentIcon kind={p.kind} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 500, marginBottom: 4 }}>{p.title}</div>
                    <div style={{ display: "flex", gap: 10, fontSize: 13, color: c.muted }}>{p.space}<Status state={p.state} /></div>
                  </div>
                </div>
              );
            })}
          </div>
        </Device>
      </Placed>
    </div>
  );
};

/* ------------------------------------------------------------------- end */

export const End = ({ f, wide }: P) => {
  const lf = f - T.end;
  if (lf < -2) return null;
  const mark = settle(f, END.mark);
  const line = ramp(f, END.line, 16);
  const chips = ["End-to-end encrypted", "No account · no open ports", "Open source · MIT"];
  const cmd = ramp(f, END.cmd, 14);
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 60 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 22, opacity: mark, transform: `scale(${lerp(mark, 0.9, 1)})` }}>
        <Img src={staticFile("mark.svg")} style={{ width: wide ? 120 : 100, height: wide ? 120 : 100 }} />
        <Img src={staticFile("wordmark.svg")} style={{ height: wide ? 120 : 100 }} />
      </div>
      <div style={{ fontSize: wide ? 64 : 52, fontWeight: 600, letterSpacing: "-0.045em", marginTop: 34, opacity: line, transform: `translateY(${(1 - line) * 18}px)`, maxWidth: 1000, lineHeight: 1.08 }}>
        Your agents, <span style={{ color: c.amber }}>as a chat on your phone.</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 14, marginTop: 38, maxWidth: 900 }}>
        {chips.map((t, i) => {
          const a = ramp(f, END.chips[i], 12);
          return (
            <span key={t} style={{ padding: "12px 22px", borderRadius: 999, border: `1px solid ${c.lineBright}`, background: c.surface, fontSize: wide ? 22 : 20, color: c.text, opacity: a, transform: `translateY(${(1 - a) * 14}px)` }}>
              <span style={{ color: c.sage, marginRight: 10, fontFamily: mono }}>✓</span>{t}
            </span>
          );
        })}
      </div>
      <div style={{ marginTop: 44, opacity: cmd, display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
        <div style={{ fontFamily: mono, fontSize: wide ? 26 : 22, padding: "16px 28px", borderRadius: 12, background: c.surface, border: `1px solid ${c.line}` }}>
          <span style={{ color: c.amber }}>$ </span>herdr plugin install iYassr/shahi
        </div>
        <div style={{ fontSize: wide ? 30 : 28, fontWeight: 500, color: c.amber, letterSpacing: "-0.02em" }}>getshahi.dev</div>
      </div>
    </div>
  );
};
