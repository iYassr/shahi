import type { CSSProperties, ReactNode } from "react";
import { ramp, typed } from "./motion";
import { c, mono } from "./theme";

const CLAUDE = "#d97757";

/**
 * A Claude Code session inside herdr, stopped at a Bash permission prompt.
 * Box drawing and the ❯/● glyphs are drawn with CSS: the Plex Mono subset
 * the site ships has none of them, and a fallback face would show.
 */
export const Terminal = ({ f, width, size }: { f: number; width: number; size: number }) => {
  const line = (start: number): CSSProperties => ({
    opacity: ramp(f, start, 6),
    transform: `translateY(${(1 - ramp(f, start, 8)) * 6}px)`,
  });
  const prompt = "Ship the billing migration. Run the tests before you finish.";
  const caret = Math.floor(f / 15) % 2 === 0 && f > 70;

  return (
    <div
      style={{
        width,
        background: c.surface,
        border: `1px solid ${c.lineBright}`,
        borderRadius: 16,
        overflow: "hidden",
        boxShadow: "0 40px 120px rgba(0,0,0,.55)",
        fontFamily: mono,
        fontSize: size,
        lineHeight: 1.55,
        color: c.text,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: `${size * 0.7}px ${size}px`,
          borderBottom: `1px solid ${c.line}`,
          background: c.steeped,
        }}
      >
        {[0, 1, 2].map((i) => (
          <span key={i} style={{ width: size * 0.6, height: size * 0.6, borderRadius: 99, background: c.lineBright }} />
        ))}
        <span style={{ marginLeft: size * 0.6, color: c.muted, fontSize: size * 0.8 }}>herdr · api · claude</span>
      </div>

      <div style={{ padding: `${size * 1.1}px ${size * 1.4}px ${size * 1.4}px` }}>
        <div style={{ color: c.muted }}>
          <span style={{ color: c.text }}>{"> "}</span>
          {typed(prompt, f, 4, 90)}
        </div>

        <div style={{ ...line(26), marginTop: size }}>
          <Dot color={CLAUDE} size={size} />
          Applying migration 0042_invoice_currency
        </div>
        <div style={{ ...line(32), color: c.muted, paddingLeft: size * 1.4 }}>3 tables altered, no rows lost</div>

        <div
          style={{
            ...line(44),
            marginTop: size,
            border: `1.5px solid ${c.amber}`,
            borderRadius: 10,
            padding: `${size * 0.8}px ${size * 1.1}px`,
          }}
        >
          <div style={{ color: c.amber }}>Bash command</div>
          <div style={{ paddingLeft: size * 1.2, marginBottom: size * 0.6 }}>bun run db:migrate && bun test</div>
          <div>Do you want to proceed?</div>
          <Option n={1} label="Yes" active caret={caret} size={size} />
          <Option n={2} label="Yes, and don't ask again for bun commands" size={size} />
          <Option n={3} label="No, and tell Claude what to do differently" size={size} />
        </div>
      </div>
    </div>
  );
};

const Dot = ({ color, size }: { color: string; size: number }) => (
  <span
    style={{
      display: "inline-block",
      width: size * 0.45,
      height: size * 0.45,
      borderRadius: 99,
      background: color,
      margin: `0 ${size * 0.6}px ${size * 0.1}px ${size * 0.1}px`,
    }}
  />
);

const Option = ({
  n,
  label,
  active,
  caret,
  size,
}: {
  n: number;
  label: ReactNode;
  active?: boolean;
  caret?: boolean;
  size: number;
}) => (
  <div style={{ display: "flex", color: active ? c.text : c.muted }}>
    <span style={{ width: size * 1.4, color: c.amber, opacity: active ? 1 : 0 }}>›</span>
    {n}. {label}
    {active && caret ? (
      <span style={{ width: size * 0.55, background: c.text, marginLeft: size * 0.4, opacity: 0.8 }} />
    ) : null}
  </div>
);
