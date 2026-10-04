import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { localeDirection, resolveLocale, translate, SUPPORTED_LOCALES, type AppLocale, type LocalePreference } from "@shahi/shared";
import { preferences } from "./preferences";

const PREFERENCE = "shahi.language";
const preference = (): LocalePreference => {
  const saved = preferences.get(PREFERENCE);
  return saved === "en" || saved === "ar" || saved === "es" ? saved : "system";
};
const deviceLanguages = () => typeof navigator === "undefined" ? ["en"] : navigator.languages?.length ? [...navigator.languages] : [navigator.language || "en"];
let currentLocale: AppLocale = "en";
export type UiTranslator = (source: string, params?: Record<string, string | number>) => string;
/** Stable across switches, so polling and write callbacks keep their identity. */
export const translateUi: UiTranslator = (source, params) => translate(currentLocale, source, params);
export function initializeLocale(): void {
  currentLocale = resolveLocale(preference(), deviceLanguages());
  document.documentElement.lang = currentLocale;
  document.documentElement.dir = localeDirection(currentLocale);
}
const LocaleContext = createContext({ locale: "en" as AppLocale, preference: "system" as LocalePreference, setPreference: (_next: LocalePreference) => {}, t: translateUi });

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState(preference);
  const [languages, setLanguages] = useState(deviceLanguages);
  const locale = resolveLocale(chosen, languages);
  currentLocale = locale;
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDirection(locale);
  }, [locale]);
  useEffect(() => {
    const changed = () => setLanguages(deviceLanguages());
    window.addEventListener("languagechange", changed);
    return () => window.removeEventListener("languagechange", changed);
  }, []);
  const value = useMemo(() => ({ locale, preference: chosen, t: translateUi, setPreference: (next: LocalePreference) => { preferences.set(PREFERENCE, next); setChosen(next); } }), [locale, chosen]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
export const useLocale = () => useContext(LocaleContext);

/** Available before pairing as well as in Settings; no credentials are needed. */
export function LanguagePicker() {
  const { t, preference, setPreference } = useLocale();
  return <label className="language-picker">{t("Language")}
    <select aria-label={t("Language")} value={preference} onChange={event => setPreference(event.target.value as LocalePreference)}>
      <option value="system">{t("Use device language")}</option>
      {SUPPORTED_LOCALES.map(item => <option key={item.locale} value={item.locale} lang={item.locale}>{item.label}</option>)}
    </select>
  </label>;
}
