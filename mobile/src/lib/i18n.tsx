import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, NativeModules } from "react-native";
import { localeDirection, resolveLocale, translate, type AppLocale, type LocalePreference, type TranslationValues } from "@shahi/shared";
import { readSecret, writeSecret } from "./keychain";

export const LANGUAGE_KEY = "shahi.language.v1";
export function systemLanguages(): string[] {
  const settings = NativeModules.SettingsManager?.settings;
  const languages = settings?.AppleLanguages;
  if (Array.isArray(languages) && languages.length) return languages;
  const locale = settings?.AppleLocale ?? NativeModules.I18nManager?.localeIdentifier;
  return [locale ?? Intl.DateTimeFormat().resolvedOptions().locale];
}

let activeLocale: AppLocale = resolveLocale("system", systemLanguages());
export function currentUiLocale(): AppLocale { return activeLocale; }
/** For authored alerts/error copy outside React; never pass agent or terminal content. */
export function ui(source: string, values?: TranslationValues): string {
  return translate(activeLocale, source, values);
}
type I18nState = { locale: AppLocale; preference: LocalePreference; direction: "ltr" | "rtl"; setPreference: (value: LocalePreference) => Promise<void>; t: typeof ui };
const I18nContext = createContext<I18nState>({ locale: activeLocale, preference: "system", direction: localeDirection(activeLocale), setPreference: async () => {}, t: ui });

/** Updates copy in place. Language never changes a navigator or screen's identity. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>("system");
  const [languages, setLanguages] = useState(systemLanguages);
  const choice = useRef(0);
  useEffect(() => {
    let mounted = true;
    void readSecret(LANGUAGE_KEY).then(value => {
      if (mounted && choice.current === 0 && (value === "en" || value === "ar" || value === "es" || value === "system")) setPreferenceState(value);
    }).catch(() => {});
    const subscription = AppState.addEventListener("change", state => { if (state === "active") setLanguages(systemLanguages()); });
    return () => { mounted = false; subscription.remove(); };
  }, []);
  const locale = resolveLocale(preference, languages);
  activeLocale = locale;
  const value = useMemo<I18nState>(() => ({
    locale, preference, direction: localeDirection(locale),
    t: (source, values) => translate(locale, source, values),
    setPreference: async next => {
      // Save first so a failed Keychain write does not imply a persisted choice.
      choice.current++;
      await writeSecret(LANGUAGE_KEY, next);
      setPreferenceState(next);
    },
  }), [locale, preference]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nState { return useContext(I18nContext); }
