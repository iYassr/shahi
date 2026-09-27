/** An HTTP(S) link and its UTF-16 slice offsets in the original text. */
export interface WebLink { start: number; end: number; url: string }

/** Validate the whole destination; URL alone repairs malformed slashes and whitespace. */
export function isWebUrl(url: string): boolean {
  if (!/^https?:\/\/[^/?#]+/i.test(url) || /[\s\\<>"`\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(url) || /%(?![\da-f]{2})/i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      Boolean(parsed.hostname.replace(/\./g, "")) && !parsed.hostname.includes("..") &&
      !parsed.username && !parsed.password;
  } catch { return false; }
}

/**
 * Find explicit web links in prose. Call after separating Markdown/code spans.
 * Never join lines or normalize the URL: copied links preserve their exact bytes.
 */
export function webLinks(text: string): WebLink[] {
  const links: WebLink[] = [];
  const candidates = /https?:\/\/[^\s<>"'`“”‘’]+/gi;
  for (const match of text.matchAll(candidates)) {
    const start = match.index;
    // A URL must start a prose token, not be part of another scheme, a file
    // path, an email or a query parameter containing a second URL.
    if (start > 0 && !/[\s([{"'“‘<]/u.test(text[start - 1]!)) continue;
    let url = match[0];
    const stack: string[] = [];
    const closing: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    for (let at = 0; at < url.length; at++) {
      const char = url[at]!;
      if ("([{".includes(char)) stack.push(char);
      else if (closing[char]) {
        if (stack[stack.length - 1] !== closing[char]) { url = url.slice(0, at); break; }
        stack.pop();
      }
    }
    url = url.replace(/[.,;:!?…。，；：！？]+$/u, "");
    if (isWebUrl(url)) links.push({ start, end: start + url.length, url });
  }
  return links;
}
