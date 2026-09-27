import { describe, expect, test } from "bun:test";
import { isWebUrl, webLinks } from "./web-links";

describe("webLinks", () => {
  test("keeps exact Unicode offsets, case, escapes, queries and fragments", () => {
    const text = "🫖 See HTTPS://example.com/a%20b?q=one&two=2#result and http://localhost:7171/path.";
    const links = webLinks(text);
    expect(links.map(link => link.url)).toEqual(["HTTPS://example.com/a%20b?q=one&two=2#result", "http://localhost:7171/path"]);
    for (const link of links) expect(text.slice(link.start, link.end)).toBe(link.url);
    expect(links[0]?.start).toBe(text.indexOf("HTTPS"));
  });

  test("leaves sentence punctuation and unmatched wrappers outside links", () => {
    const text = '(https://example.com/a_(b)). “https://example.com/next!” <https://example.com/third>, [http://[::1]:7171/x]';
    expect(webLinks(text).map(link => link.url)).toEqual([
      "https://example.com/a_(b)", "https://example.com/next", "https://example.com/third", "http://[::1]:7171/x",
    ]);
  });

  test("preserves nested balanced parentheses and punctuation inside a URL", () => {
    const url = "https://example.com/a_(b_(c))?x=a,b;c!d";
    expect(webLinks(url)).toEqual([{ start: 0, end: url.length, url }]);
  });

  test("does not invent schemes or merge hard-wrapped URL lines", () => {
    expect(webLinks("example.com www.example.com ftp://example.com file:///tmp/a javascript:alert(1)")).toEqual([]);
    expect(webLinks("https://example.com/a\nbc?token=next\nhttps://other.example/b").map(link => link.url))
      .toEqual(["https://example.com/a", "https://other.example/b"]);
  });

  test("rejects malformed and dangerous embedded destinations", () => {
    for (const text of ["https:///example.com", "https://", "http://?x=y", "https://example.com:99999", "https://user:secret@example.com", "https://example.com/a%ZZ", "https://example.com\\evil", "javascript:https://example.com", "data:text/plain,https://example.com", "file:///https://example.com", "xhttps://example.com", "https://a..b", "https://."]) {
      expect(webLinks(text), text).toEqual([]);
    }
  });
});

test("isWebUrl checks exact Markdown destinations without trimming path punctuation", () => {
  for (const url of ["https://example.com/a.", "http://127.0.0.1:7171/", "https://例え.テスト/path", "HTTPS://example.com/x_(y)"]) expect(isWebUrl(url), url).toBe(true);
  for (const url of [" https://example.com", "https://example.com\n", "//example.com", "javascript:alert(1)", "https:/example.com", "https://example.com/\u202Eevil"]) expect(isWebUrl(url), url).toBe(false);
});
