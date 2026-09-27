/** Inline images in public Codex UI items. Bytes stay behind the image route. */
import { imageMediaType, isRecord } from "./session-log";

type Image = { data: string; mediaType: string };
const records = (value: unknown) => Array.isArray(value) ? value.filter(isRecord) : [];

export function codexDataImage(value: unknown): Image | null {
  if (typeof value !== "string") return null;
  const comma = value.indexOf(",");
  if (comma < 0 || comma > 80) return null;
  const header = /^data:([^;,]+);base64$/.exec(value.slice(0, comma));
  if (!header || imageMediaType(header[1]) === "application/octet-stream") return null;
  return { data: value.slice(comma + 1), mediaType: header[1]! };
}

export function codexItemImages(item: Record<string, unknown>): Image[] {
  let parts: Record<string, unknown>[] = [];
  switch (item.type) {
    case "UserMessage": parts = records(item.content).filter(p => p.type === "image"); break;
    case "FunctionCallOutput": parts = records(item.output).filter(p => p.type === "input_image"); break;
    case "DynamicToolCall": parts = records(item.content_items).filter(p => p.type === "inputImage"); break;
    case "McpToolCall": {
      const result = isRecord(item.result) ? item.result : {};
      return records(result.content).filter(p => p.type === "image" && typeof p.data === "string" && imageMediaType(p.mimeType) !== "application/octet-stream")
        .map(p => ({ data: p.data as string, mediaType: p.mimeType as string }));
    }
    case "ImageGeneration":
    case "Extension": {
      if (item.type === "Extension" && item.kind !== "image_gen.generation") return [];
      if (typeof item.result !== "string" || !item.result) return [];
      const dataUrl = codexDataImage(item.result);
      if (dataUrl) return [dataUrl];
      // Generation records store bare base64; inspect the signature rather
      // than guessing an executable content type from extension metadata.
      const head = Buffer.from(item.result.slice(0, 24), "base64");
      const mediaType = head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
        : head[0] === 255 && head[1] === 216 && head[2] === 255 ? "image/jpeg"
        : head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : null;
      return mediaType ? [{ data: item.result, mediaType }] : [];
    }
    default: return [];
  }
  return parts.map(p => codexDataImage(p.image_url ?? p.imageUrl)).filter((p): p is Image => p !== null);
}
