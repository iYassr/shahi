import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { DiagnosticBudget, sanitizeDiagnosticEvent, type ReaderIncident } from "@shahi/shared/diagnostics";
import { SENTRY_MOBILE_DSN } from "@shahi/shared/diagnostics-config";

interface NativeDiagnostics { isEnabled(): boolean; setEnabled(value: boolean): void }
const native = () => requireOptionalNativeModule<NativeDiagnostics>("ShahiDiagnostics");
const budget = new DiagnosticBudget();
let started = false;
export function diagnosticsEnabled() { return native()?.isEnabled() ?? false; }
export function setDiagnosticsEnabled(enabled: boolean) {
  native()?.setEnabled(enabled);
  if (enabled) initializeDiagnostics();
  const client = Sentry.getClient();
  if (client) client.getOptions().enabled = enabled;
}

export function initializeDiagnostics() {
  if (started || !SENTRY_MOBILE_DSN || __DEV__ || !diagnosticsEnabled()) return;
  started = true;
  Sentry.init({
    dsn: SENTRY_MOBILE_DSN, enabled: diagnosticsEnabled(),
    release: `shahi-ios@${Constants.expoConfig?.version ?? "0.0.0"}`,
    dist: Constants.nativeBuildVersion ?? undefined, environment: "production",
    // Native is initialized by ShahiSentry with its own privacy filter.
    autoInitializeNativeSdk: false,
    initialScope: { tags: { client: Platform.OS } },
    sendDefaultPii: false, maxBreadcrumbs: 0, beforeBreadcrumb: () => null,
    enableAutoSessionTracking: false, enableAutoPerformanceTracing: false,
    enableAppStartTracking: false, enableNativeFramesTracking: false,
    enableCaptureFailedRequests: false, enableLogs: false, enableMetrics: false, enableAutoConsoleLogs: false,
    enableMemoryIntrospection: false, attachScreenshot: false, attachViewHierarchy: false,
    tracePropagationTargets: [], sendClientReports: false,
    integrations: defaults => defaults.filter(i => !["Breadcrumbs", "HttpContext", "ExpoContext", "ExpoConstants", "ExpoUpdatesListener", "MobileReplay"].includes(i.name)),
    beforeSend(event) {
      if (!diagnosticsEnabled()) return null;
      const safe = sanitizeDiagnosticEvent(event);
      return safe && budget.allow() ? safe as Sentry.ErrorEvent : null;
    },
  });
}

export function reportRenderError(error: Error) {
  if (diagnosticsEnabled()) Sentry.captureException(error, { tags: { client: Platform.OS } });
}
export function reportReaderIncident(incident: ReaderIncident, context: { transport: "relay" | "ssh" | "direct"; computerVersion?: string; herdrVersion?: string }) {
  if (!diagnosticsEnabled()) return;
  Sentry.captureMessage("Reader conversation unavailable", {
    level: incident.recovered ? "info" : "warning",
    tags: { client: Platform.OS, provider: incident.provider, reader_reason: incident.reason, reader_recovered: String(incident.recovered),
      transport: context.transport, computer_version: context.computerVersion, herdr_version: context.herdrVersion },
    extra: { attempts: incident.attempts, duration_ms: incident.durationMs },
  });
}
