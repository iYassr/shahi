/** Canonical Shahi palette shared by native UI and generated web/assets. */
export const brandColors = {
  void: "#0E0D0B",
  surface: "#14120F",
  raised: "#1C1915",
  line: "#2A2620",
  lineBright: "#3A352C",
  text: "#F0EFEA",
  muted: "#A6A099",
  accent: "#E8A33D",
  working: "#8BB8E8",
  success: "#5FB88A",
  danger: "#D96A4A",
} as const;

/**
 * Shahi identity geometry on a 100-unit canvas: the wordmark's lowercase s,
 * followed by a tea glass (an istikana) where a text cursor would wait. Both
 * shapes are filled with one ink. The glass keeps the cursor's footprint, so
 * below about 40pt it reads as a caret and the s stays legible; the tea shows
 * from there up. It replaced a tapered glass under a square, which read as a
 * trash bin with a lid knob at home-screen size. Asset exports are generated
 * by scripts/brand-assets.ts.
 */
export const brandMark = {
  letter: "M61.06 19.25C57.85 15.88 53.34 13.96 48.83 13.09C44.23 12.21 39.34 12.33 34.77 13.34C30.08 14.39 25.47 16.44 21.9 19.72C17.83 23.45 15.59 28.34 15.59 33.89C15.59 40.44 18.97 45.11 24.77 47.87C29.18 49.97 34.28 50.76 39.06 51.6C41.21 51.98 43.38 52.37 45.49 52.93C47.06 53.36 48.75 53.9 50.15 54.76C52.3 56.08 52.88 57.8 52.88 60.26C52.88 66.8 48.07 70.26 42.06 71.33C38.63 71.93 34.93 71.69 31.61 70.62C28.67 69.66 25.88 67.98 24.06 65.43C22.18 62.99 18.67 62.54 16.23 64.42C13.79 66.3 13.34 69.81 15.22 72.25C18.58 76.44 23.33 79.27 28.44 80.81C33.38 82.31 38.75 82.64 43.84 81.8C48.93 80.96 53.92 78.91 57.77 75.4C62.13 71.43 64.38 66.15 64.38 60.26C64.38 53.58 61.32 48.5 55.46 45.34C51.03 42.94 45.82 42 40.91 41.14C38.72 40.75 36.52 40.38 34.35 39.87C32.75 39.48 31.02 39 29.56 38.22C27.63 37.18 27.09 36.04 27.09 33.89C27.09 28.01 31.95 24.96 37.14 23.72C40.23 22.99 43.65 22.88 46.76 23.52C48.84 23.96 51.47 24.91 52.8 26.67C54.85 28.95 58.36 29.14 60.64 27.09C62.92 25.04 63.11 21.53 61.06 19.25Z",
  glass: "M72.288 51.5H87.087Q88.487 51.5 88.487 52.9C87.887 59.83 83.688 65.185 83.688 69.35C83.688 72.92 87.588 72.92 87.588 76.49C87.588 79.465 84.888 81.25 84.088 81.25H75.287C74.487 81.25 71.787 79.465 71.787 76.49C71.787 72.92 75.688 72.92 75.688 69.35C75.688 65.185 71.488 59.83 70.888 52.9Q70.888 51.5 72.288 51.5Z",
} as const;

/** Outlined lettering shared by native lockups and generated assets. */
export const brandWordmark = {
  width: 180,
  height: 76,
  viewBox: "0 0 180 76",
  translateX: 4,
  strokeWidth: 5.5,
  path: "M29 33C24 28 8 29 8 38C8 48 30 41 30 52C30 62 13 64 7 57M44 13V60M44 41C44 27 68 26 68 42V60M106 33V60M106 43C106 26 82 26 82 45C82 65 106 65 106 48M122 13V60M122 41C122 27 146 26 146 42V60M163 32V60",
  dot: { x: 160, y: 14, width: 6, height: 6, rx: 1.5 },
} as const;

/** Existing native agent artwork; keep provider identity consistent across clients. */
export const agentMarks = {"claudecode": "M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z", "openai": "M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a6 6 0 0 0-3.998 2.9a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667m2.01-3.023l-.141-.085l-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.8.8 0 0 0-.393.681zm1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z"} as const;

/** Bundled Simple Icons artwork (CC0; Copilot's is MIT) and Tabler's pi (MIT),
 * with their notices in artwork-notices.ts; no runtime icon requests. Accent
 * colors are Shahi's accessible identity palette, including normally
 * monochrome brands. */
export const agentColors: Record<string, string> = {
  claude: "#d97757", codex: "#10a37f", cursor: "#91a7ff",
  shell: "#67c8dc", gemini: "#8bb8e8", pi: "#c4a7ff",
  opencode: "#5fb88a", agy: "#ffd6a0", copilot: "#b7a0ee",
  droid: "#a4e05a", amp: "#ffd166", grok: "#a7bfff",
  devin: "#7ec8f0", cline: "#7de3c3", kimi: "#ff9ecb",
  kiro: "#ffb37a", hermes: "#c9b6ff", kilo: "#8fd3ff",
  maki: "#ff9d9d", grok3: "#a7bfff", mastracode: "#9fe8c0",
  qodercli: "#c0c8ff", omp: "#e0b0ff",
};
const providerArtwork: Record<string, { d: string; filled: boolean }> = {
  claude: { d: agentMarks.claudecode, filled: true },
  codex: { d: agentMarks.openai, filled: true },
  cursor: { d: "M11.503.131L1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23", filled: true },
  opencode: { d: "M22 24H2V0h20zM17 4.8H7v14.4h10z", filled: true },
  gemini: { d: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68q.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58a12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68q-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96q2.19.93 3.81 2.55t2.55 3.81", filled: true },
  copilot: { d: "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02S.939 18.492.078 16.997A.6.6 0 0 1 0 16.741v-2.869a1 1 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656c.167-.429.414-1.055.644-1.517a10 10 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368c.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98s4.767.957 6.166 2.093c.584.235 1.077.546 1.474.952c.85.869 1.132 2.037 1.132 3.368c0 .368-.014.733-.052 1.086c.23.462.477 1.088.644 1.517c1.258.364 2.233 1.721 2.605 2.656a.8.8 0 0 1 .053.22v2.869a.6.6 0 0 1-.078.256m-11.75-5.992h-.344a4 4 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492c-1.725 0-2.989-.359-3.782-1.259a2 2 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179s6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259c-1.59 0-2.738-.545-3.508-1.492a4 4 0 0 1-.355-.508m2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1s-1-.451-1-1v-2c0-.549.451-1 1-1m-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1s-1-.451-1-1v-2c0-.549.451-1 1-1m3.313-6.185c.136 1.057.403 1.913.878 2.497c.442.544 1.134.938 2.344.938c1.573 0 2.292-.337 2.657-.751c.384-.435.558-1.15.558-2.361c0-1.14-.243-1.847-.705-2.319c-.477-.488-1.319-.862-2.824-1.025c-1.487-.161-2.192.138-2.533.529c-.269.307-.437.808-.438 1.578v.021q0 .397.063.893m-1.626 0q.063-.496.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578c-.341-.391-1.046-.69-2.533-.529c-1.505.163-2.347.537-2.824 1.025c-.462.472-.705 1.179-.705 2.319c0 1.211.175 1.926.558 2.361c.365.414 1.084.751 2.657.751c1.21 0 1.902-.394 2.344-.938c.475-.584.742-1.44.878-2.497", filled: true },
  pi: { d: "M7 20V4m10 0v16m3-16H4", filled: false },
  shell: { d: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm2 4 4 4-4 4m7 0h5", filled: false },
  // A launch symbol for Antigravity; a product symbol, not third-party brand artwork.
  agy: { d: "m12 3 8 17-8-4-8 4 8-17Zm0 0v13", filled: false },
};
const genericAgentMark = { d: "M9 3h6m-3 0v4M5 7h14a2 2 0 0 1 2 2v10H3V9a2 2 0 0 1 2-2Zm3 5h.01M16 12h.01M8 16h8", filled: false };

/** Unknown providers still get a colored agent symbol, never an empty avatar. */
export function agentIdentity(kind: string | null | undefined) {
  const key = (kind ?? "shell").toLowerCase();
  return { ...(providerArtwork[key] ?? genericAgentMark), color: agentColors[key] ?? "#a7bfff" };
}
