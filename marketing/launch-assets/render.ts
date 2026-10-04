/** Repo-native launch cards: outlined SVG sources, then lossless Sharp PNGs. */
import { createCanvas, GlobalFonts, Path2D, SvgExportFlag, type SKRSContext2D } from "@napi-rs/canvas";
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentIdentity, brandMark, brandColors as c, brandWordmark } from "../../shared/src/brand";

const SIZE = 1200;
const sourceDir = import.meta.dir;
const root = resolve(sourceDir, "../..");
const output = join(root, "marketing/video/out/launch-safe/graphics");
mkdirSync(output, { recursive: true });

const fonts = {
  regular: ["LaunchPlexRegular", "IBMPlexSans-Regular-Latin1.woff2"],
  medium: ["LaunchPlexMedium", "IBMPlexSans-Medium-Latin1.woff2"],
  bold: ["LaunchPlexSemibold", "IBMPlexSans-SemiBold-Latin1.woff2"],
  mono: ["LaunchPlexMono", "IBMPlexMono-Regular-Latin1.woff2"],
} as const;
for (const [family, file] of Object.values(fonts)) {
  if (!GlobalFonts.registerFromPath(join(root, "site/public/fonts", file), family)) throw new Error(`Could not load ${file}`);
}

const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function text(ctx: SKRSContext2D, value: string, x: number, y: number, size: number, color: string = c.text, weight: keyof typeof fonts = "regular", width = SIZE - x - 80, center = false) {
  ctx.font = `${size}px ${fonts[weight][0]}`;
  ctx.fillStyle = color;
  const measured = ctx.measureText(value).width;
  if (measured > width) throw new Error(`Text does not fit (${Math.round(measured)} > ${width}): ${value}`);
  const left = center ? x - measured / 2 : x;
  if (left < 64 || left + measured > SIZE - 64) throw new Error(`Text exceeds the safe margin: ${value}`);
  ctx.fillText(value, left, y);
}
function box(ctx: SKRSContext2D, x: number, y: number, width: number, height: number, fill: string = c.surface, radius = 16, stroke?: string) {
  const path = new Path2D(); path.roundRect(x, y, width, height, radius);
  ctx.fillStyle = fill; ctx.fill(path);
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(path); }
}
function line(ctx: SKRSContext2D, x1: number, y1: number, x2: number, y2: number, color: string = c.line, width = 2) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
}
/** The master lockup's original fixed mark/wordmark spacing and proportions. */
function lockup(ctx: SKRSContext2D, x = 64, y = 50, width = 278) {
  ctx.save(); ctx.translate(x, y); ctx.scale(width / 290, width / 290);
  ctx.fillStyle = c.accent;
  ctx.fill(new Path2D(brandMark.letter)); ctx.fill(new Path2D(brandMark.glass));
  ctx.translate(108, 12); ctx.strokeStyle = c.text; ctx.lineWidth = brandWordmark.strokeWidth;
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(new Path2D(brandWordmark.path));
  ctx.fillStyle = c.text; const dot = new Path2D();
  dot.roundRect(brandWordmark.dot.x, brandWordmark.dot.y, brandWordmark.dot.width, brandWordmark.dot.height, brandWordmark.dot.rx); ctx.fill(dot);
  ctx.restore();
}
function provider(ctx: SKRSContext2D, kind: string, x: number, y: number, size: number) {
  const identity = agentIdentity(kind);
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 24, size / 24);
  if (identity.filled) { ctx.fillStyle = identity.color; ctx.fill(new Path2D(identity.d)); }
  else { ctx.strokeStyle = identity.color; ctx.lineWidth = 1.8; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke(new Path2D(identity.d)); }
  ctx.restore();
}
function icon(ctx: SKRSContext2D, name: string, x: number, y: number, size = 48) {
  const paths: Record<string, string> = {
    tunnel: "M4 12h16M8 8l-4 4 4 4m8-8 4 4-4 4M12 3v3m0 12v3",
    reader: "M12 6v15M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z",
    providers: "M5 5h4v4H5Zm10 0h4v4h-4ZM5 15h4v4H5Zm10 0h4v4h-4ZM12 10v4m-2-2h4",
    start: "M4 4h16v16H4ZM8 12h8m-4-4v8",
    computers: "M2 3h14v10H2Zm6 10v4m-3 0h6m9-9h2v13H9v-1m6-7h3",
    answers: "M4 3h16v14h-7l-5 4v-4H4Zm4 6 3 3 5-5",
  };
  ctx.save(); ctx.translate(x, y); ctx.scale(size / 24, size / 24);
  ctx.lineWidth = 1.65; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = c.accent;
  ctx.stroke(new Path2D(paths[name]!)); ctx.restore();
}
function number(ctx: SKRSContext2D, value: string, x: number, y: number) {
  ctx.fillStyle = c.accent; ctx.beginPath(); ctx.arc(x, y, 32, 0, Math.PI * 2); ctx.fill();
  text(ctx, value, x, y + 12, 34, c.void, "bold", 60, true);
}
function card(title: string, description: string) {
  const canvas = createCanvas(SIZE, SIZE, SvgExportFlag.ConvertTextToPaths);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = c.void; ctx.fillRect(0, 0, SIZE, SIZE); lockup(ctx);
  return { canvas, ctx, title, description };
}
async function save(name: string, result: ReturnType<typeof card>) {
  const svg = result.canvas.getContent().toString().replace(/(<svg\b[^>]*>)/, `$1\n<title>${xml(result.title)}</title>\n<desc>${xml(result.description)}</desc>`);
  if (/<image\b|<text\b|https?:\/\//.test(svg.replaceAll("http://www.w3.org/2000/svg", "").replaceAll("http://www.w3.org/1999/xlink", ""))) throw new Error("SVG must contain only self-contained vector drawing");
  const source = join(sourceDir, `${name}.svg`); writeFileSync(source, svg);
  const png = join(output, `${name}.png`);
  await sharp(Buffer.from(svg)).resize(SIZE, SIZE).png({ compressionLevel: 9 }).toFile(png);
  console.log(`${name}: 1200 × 1200 → ${png}`);
}

const announcement = card("Coding agents on your phone", "Shahi connects Claude Code, Codex, Cursor, OpenCode and Antigravity to your phone and browser. Free tunnel. No VPN setup. getshahi.dev.");
{
  const { ctx } = announcement;
  text(ctx, "Meet Shahi", 1000, 117, 34, c.muted, "medium", 220, true);
  text(ctx, "Coding agents.", 80, 290, 104, c.text, "bold");
  text(ctx, "On your phone.", 80, 402, 104, c.accent, "bold");
  text(ctx, "Read the work. Answer what’s next.", 80, 485, 42, c.muted);
  const providers = [["claude", "Claude Code"], ["codex", "Codex"], ["cursor", "Cursor"], ["opencode", "OpenCode"], ["agy", "Antigravity"]];
  for (const [i, [kind, label]] of providers.entries()) {
    const x = 80 + i * 212;
    box(ctx, x, 574, 192, 182, c.surface, 16);
    provider(ctx, kind!, x + 64, 608, 64);
    text(ctx, label!, x + 96, 721, 29, c.text, "medium", 176, true);
  }
  text(ctx, "Free tunnel  ·  No VPN  ·  Phone + browser", 600, 850, 40, c.text, "regular", 1040, true);
  box(ctx, 80, 931, 1040, 120, c.accent, 16);
  text(ctx, "getshahi.dev", 600, 1008, 58, c.void, "bold", 1040, true);
  text(ctx, "Your agents run on your computer.", 600, 1137, 34, c.muted, "regular", 1040, true);
}

const features = card("Six ways to use Shahi", "Free tunnel without VPN setup; Reader for conversations; five supported providers; start agent sessions; switch between computers; answer supported prompts with context. getshahi.dev.");
{
  const { ctx } = features;
  text(ctx, "Built for the phone.", 80, 270, 83, c.text, "bold");
  text(ctx, "Your coding agents, wherever you are.", 80, 356, 40, c.muted);
  const items = [
    ["tunnel", "Free tunnel", "Connect without", "a VPN."],
    ["reader", "Reader", "Read conversations", "clearly."],
    ["providers", "Five providers", "Claude Code to", "Antigravity."],
    ["start", "Start sessions", "Start agents from", "your phone."],
    ["computers", "Multiple computers", "Switch between", "your machines."],
    ["answers", "Answer prompts", "Approve or decline", "with context."],
  ];
  for (const [i, [symbol, heading, a, b]] of items.entries()) {
    const x = 80 + (i % 2) * 536, y = 422 + Math.floor(i / 2) * 216;
    box(ctx, x, y, 504, 190, c.surface, 16, c.line);
    icon(ctx, symbol!, x + 26, y + 28, 42);
    text(ctx, heading!, x + 86, y + 63, 36, c.text, "bold", 392);
    text(ctx, a!, x + 28, y + 119, 34, c.muted, "regular", 448);
    text(ctx, b!, x + 28, y + 160, 34, c.muted, "regular", 448);
  }
  line(ctx, 80, 1090, 1120, 1090);
  text(ctx, "getshahi.dev", 80, 1160, 48, c.accent, "medium");
  text(ctx, "Phone + browser", 905, 1154, 32, c.muted, "regular", 430, true);
}

const pairing = card("Install, pair and open your agents", "With herdr installed on your computer, run herdr plugin install iYassr/shahi. Then run herdr plugin action invoke shahi.pair. Scan the pairing QR code with Shahi or your camera, then open your agents. Keep the computer awake and connected. getshahi.dev.");
{
  const { ctx } = pairing;
  text(ctx, "From computer", 80, 270, 92, c.text, "bold");
  text(ctx, "to phone.", 80, 373, 92, c.accent, "bold");
  text(ctx, "With herdr on your computer:", 80, 429, 36, c.muted);
  const commands = [
    ["1", "Install the plugin", "herdr plugin install iYassr/shahi"],
    ["2", "Show the pairing code", "herdr plugin action invoke shahi.pair"],
  ];
  for (const [i, [n, heading, command]] of commands.entries()) {
    const y = 470 + i * 208;
    box(ctx, 80, y, 1040, 180, c.surface, 16);
    number(ctx, n!, 134, y + 54);
    text(ctx, heading!, 202, y + 69, 44, c.text, "bold", 856);
    box(ctx, 202, y + 92, 850, 64, c.void, 8);
    text(ctx, command!, 222, y + 137, 34, c.text, "mono", 810);
  }
  box(ctx, 80, 886, 1040, 164, c.surface, 16);
  number(ctx, "3", 134, 940);
  text(ctx, "Scan and open your agents", 202, 955, 44, c.text, "bold", 856);
  text(ctx, "Use Shahi’s QR scanner or your camera.", 202, 1006, 34, c.muted, "regular", 856);
  line(ctx, 80, 1090, 1120, 1090);
  text(ctx, "getshahi.dev", 80, 1160, 48, c.accent, "medium");
  text(ctx, "Keep your computer", 780, 1132, 30, c.muted, "regular", 640, true);
  text(ctx, "awake and connected.", 780, 1171, 30, c.muted, "regular", 640, true);
}

await save("01-launch", announcement);
await save("02-features", features);
await save("03-install-pair", pairing);
