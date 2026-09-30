import * as Sentry from "@sentry/react";
import { DiagnosticBudget, sanitizeDiagnosticEvent, type ReaderIncident } from "@shahi/shared/diagnostics";
import { SENTRY_WEB_DSN } from "@shahi/shared/diagnostics-config";
import { preferences } from "./preferences";

const KEY = "shahi.diagnostics";
const budget = new DiagnosticBudget();
let enabled = preferences.get(KEY) !== "off";
let started = false;
export const diagnosticsEnabled = () => enabled;
export function setDiagnosticsEnabled(value: boolean) {
  enabled = value;
  preferences.set(KEY, value ? "on" : "off");
  if (value) initializeDiagnostics();
  const client = Sentry.getClient();
  if (client) client.getOptions().enabled = value;
}
export function initializeDiagnostics() {
  if (started || !enabled || !import.meta.env?.PROD || !SENTRY_WEB_DSN) return;
  started = true;
  Sentry.init({
    dsn: SENTRY_WEB_DSN, enabled, environment: "production",
    initialScope: { tags: { client: "web" } },
    sendDefaultPii: false, maxBreadcrumbs: 0, beforeBreadcrumb: () => null,
    sendClientReports: false, enableLogs: false, enableMetrics: false, tracePropagationTargets: [],
    integrations: defaults => defaults.filter(i => !["Breadcrumbs", "HttpContext", "BrowserSession", "SessionFlusher"].includes(i.name)),
    beforeSend(event) {
      if (!enabled) return null;
      const safe = sanitizeDiagnosticEvent(event);
      return safe && budget.allow() ? safe as Sentry.ErrorEvent : null;
    },
  });
}
export function reportRenderError(error: Error) {
  if (enabled) Sentry.captureException(error, { tags: { client: "web" } });
}
export function reportReaderIncident(incident: ReaderIncident, context: { transport: "relay" | "direct"; computerVersion?: string; herdrVersion?: string }) {
  if (!enabled) return;
  Sentry.captureMessage("Reader conversation unavailable", {
    level: incident.recovered ? "info" : "warning",
    tags: { client: "web", provider: incident.provider, reader_reason: incident.reason, reader_recovered: String(incident.recovered),
      transport: context.transport, computer_version: context.computerVersion, herdr_version: context.herdrVersion },
    extra: { attempts: incident.attempts, duration_ms: incident.durationMs },
  });
}
