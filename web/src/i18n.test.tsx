import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useEffect, useState } from "react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { uiTranslations } from "../../shared/src/i18n";
import { initializeLocale, LanguagePicker, LocaleProvider, useLocale, type UiTranslator } from "./i18n";
import { Markdown } from "./components/Markdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const original = { navigator: globalThis.navigator, document: globalThis.document, window: globalThis.window, storage: globalThis.localStorage };
const stored = new Map<string, string>();
const rootElement = { lang: "en", dir: "ltr" };
let view: ReactTestRenderer | undefined;
let events: EventTarget;
let latest: ReturnType<typeof useLocale>;
let effects = 0;
let translator: UiTranslator | undefined;

function Content() {
  latest = useLocale();
  const [draft, setDraft] = useState("Settings is my literal project name");
  useEffect(() => { effects++; }, [latest.t]);
  translator ??= latest.t;
  return <><LanguagePicker /><p>{latest.t("Settings")}</p><input value={draft} onChange={event => setDraft(event.target.value)} /><Markdown text={"Settings\n\n`Send` is a command in this project."} /></>;
}
beforeEach(() => {
  stored.clear(); effects = 0; translator = undefined;
  events = new EventTarget();
  Object.assign(globalThis, {
    navigator: { languages: ["es-MX", "en-US"], language: "es-MX" },
    document: { documentElement: rootElement },
    window: events,
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
  });
});
afterEach(async () => {
  if (view) {
    await act(async () => latest.setPreference("en"));
    await act(async () => view!.unmount());
  }
  view = undefined;
  Object.assign(globalThis, { navigator: original.navigator, document: original.document, window: original.window, localStorage: original.storage });
});

test("device locale before first paint; chooser persists and switches RTL without remounting content", async () => {
  initializeLocale();
  expect(rootElement).toEqual({ lang: "es", dir: "ltr" });
  await act(async () => { view = create(<LocaleProvider><Content /></LocaleProvider>); });
  expect(latest.preference).toBe("system");
  expect(latest.t("Settings")).toBe("Ajustes");
  const pick = (locale: string) => view!.root.findByType("select").props.onChange({ target: { value: locale } });
  await act(async () => pick("ar"));
  expect(rootElement).toEqual({ lang: "ar", dir: "rtl" });
  expect(view!.root.findByType("select").props["aria-label"]).toBe("اللغة");
  expect(latest.t("Settings")).toBe("الإعدادات");
  expect(stored.get("shahi.language")).toBe("ar");
  expect(view!.root.findByType("input").props.value).toBe("Settings is my literal project name");
  expect(JSON.stringify(view!.toJSON())).toContain('"children":["Settings"]');
  expect(JSON.stringify(view!.toJSON())).toContain('"children":["Send"]');
  expect(latest.t).toBe(translator);
  expect(effects).toBe(1);
  await act(async () => pick("en"));
  expect(rootElement).toEqual({ lang: "en", dir: "ltr" });
  expect(latest.t("Settings")).toBe("Settings");
  expect(effects).toBe(1);
});

test("saved language wins over device; system language follows later device changes", async () => {
  stored.set("shahi.language", "ar");
  initializeLocale();
  expect(rootElement.lang).toBe("ar");
  await act(async () => { view = create(<LocaleProvider><Content /></LocaleProvider>); });
  await act(async () => latest.setPreference("system"));
  expect(latest.locale).toBe("es");
  Object.assign(globalThis.navigator, { languages: ["fr-FR", "ar-SA"], language: "fr-FR" });
  await act(async () => events.dispatchEvent(new Event("languagechange")));
  expect(latest.locale).toBe("ar");
  expect(rootElement.dir).toBe("rtl");
});

test("every literal authored web translation has both localized entries", () => {
  const files = ["App.tsx", "i18n.tsx", ...readdirSync(join(import.meta.dir, "components")).filter(file => file.endsWith(".tsx") && !file.includes(".test.")).map(file => `components/${file}`)];
  const missing: string[] = [];
  for (const file of files) for (const match of readFileSync(join(import.meta.dir, file), "utf8").matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
    const key = JSON.parse(match[1]!) as string;
    if (!Object.hasOwn(uiTranslations.ar, key) || !Object.hasOwn(uiTranslations.es, key)) missing.push(`${file}: ${key}`);
  }
  expect(missing).toEqual([]);
});
