import { expect, test } from "bun:test";
import { localeDirection, normalizeLocale, resolveLocale, SUPPORTED_LOCALES, translate, uiTranslations } from "./i18n";
import { relativeTime, rowTime } from "./relative-time";
import { messageTime } from "./message-time";
import { planWindowNow } from "./plan-usage";

test("supported device locales and explicit choice resolve without confusing Arabic and Spanish regions", () => {
  expect(SUPPORTED_LOCALES.map(item => item.locale)).toEqual(["en", "ar", "es"]);
  expect(normalizeLocale(" AR_sa ")).toBe("ar");
  expect(normalizeLocale("es-MX")).toBe("es");
  expect(normalizeLocale("fr")).toBe("en");
  expect(resolveLocale("system", ["fr-FR", "es-AR", "en-US"])).toBe("es");
  expect(resolveLocale("en", ["ar-SA"])).toBe("en");
  expect(resolveLocale("system", [])).toBe("en");
  expect(localeDirection("ar")).toBe("rtl");
  expect(localeDirection("es")).toBe("ltr");
});

test("authored copy translates while placeholders preserve computer names and literal dollar syntax", () => {
  expect(translate("ar", "Settings")).toBe("الإعدادات");
  expect(translate("es", "Settings")).toBe("Ajustes");
  expect(translate("ar", "Connecting to {computer}…", { computer: "dev-$&" })).toBe("جارٍ الاتصال بـ dev-$&…");
  expect(translate("en", "Connecting to {computer}…", { computer: "Mac" })).toBe("Connecting to Mac…");
  expect(translate("es", "Connecting to {computer}…")).toBe("Conectando con {computer}…");
  expect(translate("ar", "unknown authored copy")).toBe("unknown authored copy");
  expect(translate("ar", " Settings ")).toBe(" الإعدادات ");
  expect(translate("en", "\n Settings ")).toBe("\n Settings ");
  expect(translate("ar", " \n ")).toBe(" \n ");
  for (const source of ["toString", "constructor", "__proto__"]) expect(translate("ar", source)).toBe(source);
});

test("every translated sentence keeps exactly its original interpolation fields", () => {
  const fields = (value: string) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
  for (const catalog of Object.values(uiTranslations)) for (const [source, translated] of Object.entries(catalog)) {
    expect(source).toBe(source.trim());
    expect(translated.trim().length).toBeGreaterThan(0);
    expect(fields(translated)).toEqual(fields(source));
  }
});

test("list timestamps and plan resets follow the interface language and retain the clock value", () => {
  const now = new Date(2026, 9, 4, 14, 30).getTime();
  expect(relativeTime(now - 300_000, now, "es")).toBe("hace 5 min");
  expect(relativeTime(now - 300_000, now, "ar")).toBe("قبل 5 د");
  const yesterday = new Date(2026, 9, 3, 14, 30).getTime();
  expect(rowTime(yesterday, now, "es")).toBe("Ayer");
  expect(messageTime(yesterday, now, "ar")).toBe(`أمس ${new Date(yesterday).toLocaleTimeString("ar", { hour: "numeric", minute: "2-digit" })}`);
  expect(planWindowNow({ label: "Weekly", usedPercent: 60, resetsAt: yesterday }, now, "es")).toEqual({ percent: null, reset: "Se restableció desde la última lectura" });
});
