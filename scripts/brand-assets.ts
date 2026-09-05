/** Regenerate identity exports from the shared mark: bun scripts/brand-assets.ts. */
import sharp from "sharp";
import { agentMarks, brandColors, brandMark, brandWordmark } from "../shared/src/brand";
import { mkdir, writeFile } from "node:fs/promises";
const amber = brandColors.accent, black = brandColors.void, porcelain = brandColors.text;
function mark(ink: string) {
  const c = brandMark.cursor;
  return `<rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" rx="${c.rx}" fill="${ink}"/><path d="${brandMark.glass}" fill="none" stroke="${ink}" stroke-width="8" stroke-linejoin="round"/>`;
}
function svg(body: string, w = 100, h = w) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Shahi">${body}</svg>\n`;
}
// Outlined lettering makes the wordmark independent of installed fonts.
const dot = brandWordmark.dot;
const letters = `<g fill="none" stroke="currentColor" stroke-width="${brandWordmark.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"><path d="${brandWordmark.path}"/></g><rect x="${dot.x}" y="${dot.y}" width="${dot.width}" height="${dot.height}" rx="${dot.rx}" fill="currentColor"/>`;

await mkdir("docs/brand", { recursive: true });
for (const path of ["docs/logo.svg", "site/public/favicon.svg", "web/public/favicon.svg"]) await writeFile(path, svg(mark(amber)));
await writeFile("docs/brand/mark-dark.svg", svg(mark(black)));
await writeFile("docs/brand/mark-light.svg", svg(mark(porcelain)));
for (const [name, ink] of [["wordmark", porcelain], ["wordmark-dark", black]]) {
  await writeFile(`docs/brand/${name}.svg`, svg(`<g color="${ink}" transform="translate(${brandWordmark.translateX} 0)">${letters}</g>`, brandWordmark.width, brandWordmark.height));
}
for (const [name, markInk, textInk] of [
  ["lockup", amber, porcelain], ["lockup-dark", black, black],
  ["lockup-mono-light", porcelain, porcelain], ["lockup-mono-dark", black, black],
]) {
  await writeFile(`docs/brand/${name}.svg`, svg(`${mark(markInk)}<g color="${textInk}" transform="translate(108 12)">${letters}</g>`, 290, 100));
}
await writeFile("site/public/wordmark.svg", svg(`<g color="${porcelain}" transform="translate(${brandWordmark.translateX} 0)">${letters}</g>`, brandWordmark.width, brandWordmark.height));
const icon = (ink: string, bg?: string) => svg(`${bg ? `<rect width="1024" height="1024" fill="${bg}"/>` : ""}<g transform="translate(154 154) scale(7.16)">${mark(ink)}</g>`, 1024);
await writeFile("mobile/assets/expo.icon/Assets/cup.svg", icon(amber));
for (const [path, size, ink, bg] of [
  ["mobile/assets/images/icon.png",1024,amber,black],
  ["mobile/assets/images/splash-icon.png",512,amber,undefined],
  ["mobile/assets/images/android-icon-foreground.png",1024,amber,undefined],
  ["mobile/assets/images/android-icon-monochrome.png",1024,"#FFFFFF",undefined],
  ["mobile/assets/images/favicon.png",48,amber,black],
  ["web/public/icon-180.png",180,amber,black],
  ["web/public/icon-192.png",192,amber,black],
  ["web/public/icon-512.png",512,amber,black],
] as const) await sharp(Buffer.from(icon(ink,bg))).resize(size,size).png().toFile(path);
await sharp({ create: { width: 1024, height: 1024, channels: 3, background: black } }).png().toFile("mobile/assets/images/android-icon-background.png");
const colors = [
  ["Kettle", black], ["Steeped", brandColors.raised], ["Porcelain", porcelain],
  ["Idle", brandColors.muted], ["Attention", amber], ["Working", brandColors.working],
  ["Done", brandColors.success], ["Error", brandColors.danger],
];
const board = svg(`<rect width="1200" height="760" fill="${black}"/><g transform="translate(66 50)">${mark(amber)}<g color="${porcelain}" transform="translate(118 12)">${letters}</g></g><g fill="${porcelain}" font-family="Helvetica, Arial, sans-serif"><text x="80" y="280" font-size="64" font-weight="600">Step away.</text><text x="80" y="355" font-size="64" font-weight="600">Stay in control.</text><text x="82" y="410" fill="${brandColors.muted}" font-size="24">Your coding agents, within reach.</text></g><rect x="880" y="120" width="220" height="220" rx="48" fill="${brandColors.raised}"/><g transform="translate(910 150) scale(1.6)">${mark(amber)}</g>${colors.map(([label,c],i)=>`<rect x="${80+i*132}" y="525" width="116" height="94" rx="12" fill="${c}" stroke="${brandColors.lineBright}"/><text x="${80+i*132}" y="649" fill="${brandColors.muted}" font-family="Menlo, monospace" font-size="14">${c}</text><text x="${80+i*132}" y="675" fill="${porcelain}" font-family="Helvetica, Arial, sans-serif" font-size="16">${label}</text>`).join("")}<text x="80" y="710" fill="${brandColors.muted}" font-family="Helvetica, Arial, sans-serif" font-size="16">SHAHI / IDENTITY 2.0</text>`,1200,760);
await writeFile("docs/brand/overview.svg",board);
await sharp(Buffer.from(board)).png().toFile("docs/brand/overview.png");
console.log("Generated Shahi logo, wordmark, app icons, and identity overview.");

await mkdir("site/public/agents", { recursive: true });
for (const [kind, path, ink] of [["claude", agentMarks.claudecode, "#d97757"], ["codex", agentMarks.openai, "#10a37f"]]) {
  await writeFile(`site/public/agents/${kind}.svg`, svg(`<path d="${path}" fill="${ink}"/>`, 24));
}

// Keep CSS consumable without a runtime dependency on the shared package.
const cssColors = Object.entries(brandColors).map(([name, value]) =>
  `  --${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}: ${value};`
).join("\n");
await writeFile("web/public/identity.css", `/* Generated by bun run brand:assets from shared/src/brand.ts. */
:root {
  color-scheme: dark;
${cssColors}
  --accent-soft: ${amber}12;
  --focus-ring: ${amber}18;
  --ui: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", "SFMono-Regular", Menlo, monospace;
  --sans: "IBM Plex Sans", var(--ui);
  --radius: 10px;
  --radius-card: 14px;
  --settle: cubic-bezier(.22, 1, .36, 1);
}
`);
