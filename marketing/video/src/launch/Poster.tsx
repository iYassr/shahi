import { AbsoluteFill, Img, staticFile } from "remotion";
import { c, sans } from "../theme";
import { HOOK } from "./timeline";

/**
 * The website's poster for the launch video: one still for the square player
 * on phones and the wide one elsewhere, since a poster cannot change with the
 * breakpoint. The background is the page's --void and nothing glows or darkens
 * at the edges, so the bars either side of it in the wide player cannot be
 * seen; the hook frame's vignette showed there as a lighter square. The words
 * sit in the upper third and the wordmark above the control bar, clear of the
 * play button WebKit draws in the middle.
 */
export const Poster = () => (
  <AbsoluteFill style={{ background: c.void, fontFamily: sans, color: c.text, alignItems: "center", textAlign: "center" }}>
    <div style={{ position: "absolute", top: 118, fontSize: 104, fontWeight: 600, letterSpacing: "-0.05em", lineHeight: 1.02 }}>
      <div>{HOOK.line1}</div>
      <div style={{ color: c.amber }}>{HOOK.line2}</div>
    </div>
    <div style={{ position: "absolute", top: 790, display: "flex", alignItems: "center", gap: 16 }}>
      <Img src={staticFile("mark.svg")} style={{ width: 76, height: 76 }} />
      <Img src={staticFile("wordmark.svg")} style={{ height: 76 }} />
    </div>
  </AbsoluteFill>
);
