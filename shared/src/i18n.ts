import { coreTranslations } from "./locales/core";
import { mobileTranslations } from "./locales/mobile";
import { webTranslations } from "./locales/web";

export type AppLocale = "en" | "ar" | "es";
export type LocalePreference = AppLocale | "system";
export type TranslationValues = Record<string, string | number>;
export const SUPPORTED_LOCALES = [
  { locale: "en", label: "English", direction: "ltr" },
  { locale: "ar", label: "العربية", direction: "rtl" },
  { locale: "es", label: "Español", direction: "ltr" },
] as const;

function catalog(...sources: Record<string, string>[]): Record<string, string> {
  // JSX often supplies surrounding spaces. Keep those at the call site rather
  // than making a leading-space catalog entry impossible to find.
  return Object.fromEntries(sources.flatMap(source => Object.entries(source).map(([key, value]) => [key.trim(), value.trim()])));
}
export const uiTranslations: Record<"ar" | "es", Record<string, string>> = {
  ar: catalog(webTranslations.ar, mobileTranslations.ar, coreTranslations.ar),
  es: catalog(webTranslations.es, mobileTranslations.es, coreTranslations.es),
};

function supportedLocale(value: string | null | undefined): AppLocale | undefined {
  const language = value?.trim().toLowerCase().split(/[-_]/)[0];
  return language === "en" || language === "ar" || language === "es" ? language : undefined;
}

export function normalizeLocale(value?: string | null): AppLocale {
  return supportedLocale(value) ?? "en";
}

export function resolveLocale(preference: LocalePreference, systemLocales: readonly string[] | string): AppLocale {
  if (preference !== "system") return normalizeLocale(preference);
  for (const value of typeof systemLocales === "string" ? [systemLocales] : systemLocales) {
    const locale = supportedLocale(value);
    if (locale) return locale;
  }
  return "en";
}

export function localeDirection(locale: AppLocale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** Only explicitly authored UI copy enters this function; agent content stays untouched. */
export function translate(locale: AppLocale, source: string, values?: TranslationValues): string {
  const key = source.trim();
  if (!key) return source;
  const leading = source.slice(0, source.length - source.trimStart().length);
  const trailing = source.slice(source.trimEnd().length);
  const catalog = locale === "en" ? null : uiTranslations[locale];
  const translated = leading + (catalog && Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key]! : key) + trailing;
  return translated.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (placeholder, name: string) =>
    values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder);
}
