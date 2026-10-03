/** Deliberately accepts no conversation, path, identifier, URL or raw error text. */
export const READER_PROVIDERS = ["claude", "codex", "cursor", "antigravity", "opencode"] as const;
export type ReaderProvider = typeof READER_PROVIDERS[number];
export const readerProvider = (value: unknown): ReaderProvider | null => value === "agy" ? "antigravity"
  : READER_PROVIDERS.includes(value as ReaderProvider) ? value as ReaderProvider : null;
export type ReaderFailure = "reader_session_missing" | "reader_transcript_missing" | "reader_unavailable" | "empty_result" | "response_too_large" | "server_error" | "request_failed";
export interface ReaderIncident {
  provider: ReaderProvider;
  reason: ReaderFailure;
  attempts: number;
  durationMs: number;
  recovered: boolean;
}

export function readerFailure(status?: number, code?: string): ReaderFailure | null {
  if (status === 401 || status === 403 || status === 409 || status === 426) return null;
  if (status === 404) return code === "reader_session_missing" || code === "reader_transcript_missing" ? code : "reader_unavailable";
  if (status === 413) return "response_too_large";
  return status && status >= 500 ? "server_error" : "request_failed";
}

/** A failure is an incident, not one error per 2.5-second poll. */
export class ReaderHealth {
  private pending: { provider: ReaderProvider; reason: ReaderFailure; since: number; last: number; attempts: number; reported: boolean } | null = null;
  constructor(private report: (incident: ReaderIncident) => void) {}
  reset() { this.pending = null; }
  observe(provider: ReaderProvider | null, reason: ReaderFailure | null, eligible: boolean, now = Date.now()) {
    if (!eligible || !provider) { this.reset(); return; }
    if (!reason) {
      const p = this.pending;
      if (p?.reported && p.provider === provider) this.emit(p, now, true);
      this.reset(); return;
    }
    let p = this.pending;
    // A suspended tab/phone is not 30 seconds spent waiting in Reader.
    if (!p || p.provider !== provider || p.reason !== reason || now - p.last > 45_000 || now < p.last) {
      p = this.pending = { provider, reason, since: now, last: now, attempts: 0, reported: false };
    }
    p.last = now; p.attempts++;
    if (!p.reported && ((p.attempts >= 3 && now - p.since >= 30_000) || reason === "response_too_large")) {
      p.reported = true; this.emit(p, now, false);
    }
  }
  private emit(p: NonNullable<ReaderHealth["pending"]>, now: number, recovered: boolean) {
    try { this.report({ provider: p.provider, reason: p.reason, attempts: p.attempts, durationMs: Math.max(0, now - p.since), recovered }); } catch { /* Reporting cannot break Reader. */ }
  }
}

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const token = (v: unknown, pattern: RegExp, max = 128) => typeof v === "string" && v.length <= max && pattern.test(v) ? v : undefined;
const version = (v: unknown) => token(v, /^\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?$/, 64);
const label = (v: unknown, values: readonly string[]) => typeof v === "string" && values.includes(v) ? v : undefined;
const UUID = /^[0-9a-f-]{32,36}$/i;
function codeFile(v: unknown): string | undefined {
  if (typeof v !== "string") return;
  // Preserve only bundled executable names, never a user's source/document path.
  const name = v.split(/[?#]/, 1)[0]!.split(/[\\/]/).pop();
  return name && /^(?:main|index|entry|[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8,})\.(?:js|jsbundle)$/.test(name) ? `app:///${name}` : undefined;
}
function stack(value: unknown) {
  return { frames: list(row(value).frames).slice(-80).map(raw => {
    const f = row(raw);
    return { filename: codeFile(f.filename ?? f.abs_path), lineno: number(f.lineno), colno: number(f.colno),
      function: token(f.function, /^[a-zA-Z_$][a-zA-Z0-9_$.<>: ]*$/, 120), in_app: typeof f.in_app === "boolean" ? f.in_app : undefined };
  }) };
}

/**
 * An error's message with what could be someone's own words taken out.
 *
 * Messages used to be dropped whole, and the owner found a fatal crash in
 * Sentry that said only "Native application error (message omitted for
 * privacy)", with no type and no reason: nothing to fix it from (October
 * 2026). What makes a message private is its parts, not the message, so
 * those are replaced: links, email addresses, paths (anything with two
 * slashes), long numbers, long identifiers and tokens, and quoted text that
 * is not code. A quoted identifier stays, because that is how engines name
 * the code that failed: "undefined is not an object (evaluating 'pane.title')".
 * Words in the message itself are the code's, not the person's. The same
 * rules run in Swift for native crashes (`mobile/plugins/sentry-redaction.swift`),
 * checked against the same vectors (`error-redaction-vectors.json`).
 */
export function redactErrorMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "Application error";
  const text = value.replace(/\s+/g, " ").trim()
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/gi, "<url>")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/(^|[\s(:=[,])(["'`“‘])([^"'`“”‘’]{0,200}?)(["'`”’])(?=$|[\s).,:;\]])/g,
      (_, before: string, open: string, inner: string, close: string, at: number, whole: string) =>
        before + (ENGINE_QUOTE.test(whole.slice(Math.max(0, at - 16), at + before.length)) && CODE.test(inner) ? open + inner + close : "<text>"))
    .replace(/(?:~|\.{1,2})?\/[^\s"'`<>]*\/[^\s"'`<>]*/g, "<path>")
    // Secrets and identifiers mix letters and digits; a long code name does not.
    .replace(/[A-Za-z0-9+/_-]{24,}={0,2}/g, (word) => /\d/.test(word) && /[A-Za-z]/.test(word) ? "<id>" : word)
    // Whole numbers only: a memory address such as 0x0000000102a3b4c8 is not one.
    .replace(/\b\d{7,}\b/g, "<number>");
  return [...text].slice(0, 300).join("");
}
/** An identifier or member chain, the way an engine quotes failing code. */
const CODE = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\[\d+\])*(?:\(\))?$/;
/**
 * Where an engine quotes code: "(evaluating 'pane.title')", "Property 'title'
 * doesn't exist". Anywhere else a quoted word may be the person's — a file
 * name, a word from a transcript — so it is replaced even when it looks like code.
 */
const ENGINE_QUOTE = /(?:evaluating|property) ?$/i;
/** An exception type is a name; anything else is not trusted to be one. */
const EXCEPTION_TYPE = /^[A-Za-z_][A-Za-z0-9_.:]{0,79}$/;

/** Rebuild from an allowlist. Future SDK fields are private until reviewed. */
export function sanitizeDiagnosticEvent(input: unknown): (Row & { type: undefined }) | null {
  const e = row(input);
  if (e.type && e.type !== "error") return null;
  const tags = row(e.tags), extra = row(e.extra), contexts = row(e.contexts);
  const provider = readerProvider(tags.provider);
  const reason = label(tags.reader_reason, ["reader_session_missing", "reader_transcript_missing", "reader_unavailable", "empty_result", "response_too_large", "server_error", "request_failed"]);
  const reader = provider && reason;
  const exceptions = list(row(e.exception).values).slice(0, 4).map(raw => {
    const x = row(raw), mechanism = row(x.mechanism);
    return { type: token(x.type, EXCEPTION_TYPE, 80) ?? "Error",
      value: redactErrorMessage(x.value), stacktrace: stack(x.stacktrace),
      mechanism: { type: "generic", handled: mechanism.handled !== false } };
  });
  if (!reader && !exceptions.length && e.message !== "Shahi diagnostics verification") return null;
  const os = row(contexts.os), app = row(contexts.app), device = row(contexts.device);
  return {
    type: undefined,
    event_id: token(e.event_id, /^[a-f0-9]{32}$/i), timestamp: number(e.timestamp),
    platform: label(e.platform, ["javascript", "cocoa"]), level: label(e.level, ["error", "fatal", "warning", "info"]),
    release: token(e.release, /^shahi[-a-zA-Z0-9@.+_]+$/, 120), dist: token(e.dist, /^[a-zA-Z0-9.-]+$/, 80),
    environment: label(e.environment, ["production", "testflight", "development", "verification"]),
    ...(reader ? { message: tags.reader_recovered === "true" ? "Reader recovered" : "Reader conversation unavailable",
      fingerprint: ["reader", provider, reason, tags.reader_recovered === "true" ? "recovered" : "failed"] } :
      exceptions.length ? { exception: { values: exceptions } } : { message: "Shahi diagnostics verification" }),
    tags: { client: label(tags.client, ["ios", "android", "web"]), provider: provider ?? undefined, reader_reason: reason,
      reader_recovered: label(tags.reader_recovered, ["true", "false"]), transport: label(tags.transport, ["relay", "ssh", "direct"]),
      computer_version: version(tags.computer_version), herdr_version: version(tags.herdr_version) },
    extra: reader ? { attempts: number(extra.attempts), duration_ms: number(extra.duration_ms) } : {},
    contexts: { os: { name: label(os.name, ["iOS", "Android", "Windows", "Mac OS X", "Linux"]), version: version(os.version) },
      app: { app_version: version(app.app_version), app_build: token(app.app_build, /^\d+$/, 12) },
      device: { model: token(device.model, /^(?:iPhone|iPad|iPod)[0-9,]+$/, 32) } },
    debug_meta: { images: list(row(e.debug_meta).images).slice(0, 4).map(raw => {
      const d = row(raw); return { type: label(d.type, ["sourcemap"]), code_file: codeFile(d.code_file), debug_id: token(d.debug_id, UUID) };
    }).filter(d => d.type && d.code_file && d.debug_id) },
    // A neutral address prevents auto-detection; project IP storage is disabled too.
    user: { ip_address: "0.0.0.0" },
  };
}

/** Cap incidents on a broken device; Sentry's monthly quota remains the fleet cap. */
export class DiagnosticBudget {
  private start = 0;
  private count = 0;
  allow(now = Date.now()): boolean {
    if (now - this.start >= 3_600_000 || now < this.start) { this.start = now; this.count = 0; }
    return this.count++ < 20;
  }
}
