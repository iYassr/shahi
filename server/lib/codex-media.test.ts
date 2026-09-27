import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexImage, readCodexLog } from "./codex-log";
import { codexItemImages } from "./codex-media";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVQAAAABJRU5ErkJggg==";
const dataUrl = `data:image/png;base64,${png}`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const line = (item: object) => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item } }) + "\n";

test("Codex image refs survive pagination and append, carry no bytes and cannot cross sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shahi-codex-images-")); dirs.push(dir);
  const path = join(dir, "rollout-a.jsonl");
  writeFileSync(path, line({ type: "UserMessage", content: [{ type: "image", image_url: dataUrl }] }));
  const first = await readCodexLog(path, { limit: 1 });
  const block = first!.messages[0]!.blocks[0]!;
  expect(block).toEqual({ kind: "image", mediaType: "image/png", ref: "codex:rollout-a:0:0" });
  expect(JSON.stringify(first)).not.toContain(png);
  appendFileSync(path, line({ type: "AgentMessage", content: [{ type: "text", text: "A pixel" }] }));
  expect((await readCodexLog(path, { limit: 1, before: 1 }))!.messages[0]!.blocks[0]).toEqual(block);
  expect(await readCodexImage(path, "codex:rollout-a:0:0")).toEqual({ bytes: new Uint8Array(Buffer.from(png, "base64")), mediaType: "image/png" });
  for (const ref of ["codex:rollout-b:0:0", "codex:rollout-a:0:1", "codex:rollout-a:-1:0", "codex:rollout-a:1:0", "../../secret"]) {
    expect(await readCodexImage(path, ref)).toBeNull();
  }
});

test("current image-generation, MCP and dynamic-tool image shapes are recognised", () => {
  for (const item of [
    { type: "ImageGeneration", result: png },
    { type: "Extension", kind: "image_gen.generation", result: png },
    { type: "McpToolCall", result: { content: [{ type: "image", data: png, mimeType: "image/png" }] } },
    { type: "DynamicToolCall", content_items: [{ type: "inputImage", imageUrl: dataUrl }] },
    { type: "FunctionCallOutput", output: [{ type: "input_image", image_url: dataUrl }] },
  ]) expect(codexItemImages(item)).toEqual([{ data: png, mediaType: "image/png" }]);
});

test("image extraction refuses active types, remote fetches, unknown context and corrupt bytes", async () => {
  for (const image_url of ["https://example.com/image.png", "file:///tmp/private.png", "data:image/svg+xml;base64,PHN2Zy8+", "data:text/html;base64,PHNjcmlwdC8+"]) {
    expect(codexItemImages({ type: "UserMessage", content: [{ type: "image", image_url }] })).toEqual([]);
  }
  expect(codexItemImages({ type: "HookPrompt", result: png })).toEqual([]);
  expect(codexItemImages({ type: "Extension", kind: "unknown", result: png })).toEqual([]);
  const dir = mkdtempSync(join(tmpdir(), "shahi-codex-images-")); dirs.push(dir);
  const path = join(dir, "bad.jsonl");
  writeFileSync(path, line({ type: "UserMessage", content: [{ type: "image", image_url: "data:image/png;base64,?!invalid" }] }));
  expect(await readCodexImage(path, "codex:bad:0:0")).toBeNull();
});
