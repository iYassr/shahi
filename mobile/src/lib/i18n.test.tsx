import { useEffect, useState } from "react";
import { NativeModules, TextInput, View, StyleSheet } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { I18nProvider, LANGUAGE_KEY, useI18n } from "./i18n";
import { LanguagePicker } from "@/components/language-picker";
import { UiText } from "@/components/ui-text";
import { Text } from "@/components/text";
import { readSecret, writeSecret } from "./keychain";
import { ReplyChips } from "@/components/composer-shortcuts";

jest.mock("./keychain", () => ({ readSecret: jest.fn(async () => null), writeSecret: jest.fn(async () => {}) }));
const read = jest.mocked(readSecret), write = jest.mocked(writeSecret);
beforeEach(() => {
  jest.clearAllMocks(); read.mockResolvedValue(null); write.mockResolvedValue(undefined);
  NativeModules.SettingsManager = { settings: { AppleLanguages: ["en-US"] } };
});

function Screen({ mounted }: { mounted: () => void }) {
  const [draft, setDraft] = useState("");
  const { direction } = useI18n();
  useEffect(() => { mounted(); }, [mounted]);
  return <View testID="screen" style={{ direction }}>
    <LanguagePicker /><UiText testID="translated">Settings</UiText>
    <Text testID="agent">Settings</Text>
    <TextInput testID="draft" value={draft} onChangeText={setDraft} />
  </View>;
}

it("switches Arabic and Spanish labels in place, persists the choice and preserves drafts and raw agent content", async () => {
  const mounted = jest.fn();
  const result = render(<I18nProvider><Screen mounted={mounted} /></I18nProvider>);
  fireEvent.changeText(result.getByTestId("draft"), "unsent user draft");
  fireEvent.press(result.getByTestId("language-ar"));
  await waitFor(() => expect(result.getByTestId("translated").props.children).toBe("الإعدادات"));
  expect(write).toHaveBeenCalledWith(LANGUAGE_KEY, "ar");
  expect(result.getByTestId("language-ar").props.accessibilityState.checked).toBe(true);
  expect(StyleSheet.flatten(result.getByTestId("translated").props.style)).toMatchObject({ direction: "rtl", writingDirection: "rtl", textAlign: "left" });
  expect(result.getByTestId("screen").props.style.direction).toBe("rtl");
  expect(result.getByTestId("agent").props.children).toBe("Settings");
  expect(result.getByTestId("draft").props.value).toBe("unsent user draft");
  fireEvent.press(result.getByTestId("language-es"));
  await waitFor(() => expect(result.getByTestId("translated").props.children).toBe("Ajustes"));
  expect(result.getByTestId("screen").props.style.direction).toBe("ltr");
  expect(result.getByTestId("draft").props.value).toBe("unsent user draft");
  expect(mounted).toHaveBeenCalledTimes(1);
});

it("restores the saved choice on a new launch", async () => {
  read.mockResolvedValue("es");
  const result = render(<I18nProvider><UiText>Settings</UiText><LanguagePicker /></I18nProvider>);
  await waitFor(() => expect(result.getByText("Ajustes")).toBeTruthy());
  expect(result.getByTestId("language-es").props.accessibilityState.checked).toBe(true);
});

it("uses the first supported device language and can restore automatic selection", async () => {
  NativeModules.SettingsManager = { settings: { AppleLanguages: ["fr-FR", "ar-SA", "es-ES"] } };
  const result = render(<I18nProvider><UiText>Settings</UiText><LanguagePicker /></I18nProvider>);
  expect(result.getByText("الإعدادات")).toBeTruthy();
  fireEvent.press(result.getByTestId("language-en"));
  await waitFor(() => expect(result.getByText("Settings")).toBeTruthy());
  fireEvent.press(result.getByTestId("language-system"));
  await waitFor(() => expect(result.getByText("الإعدادات")).toBeTruthy());
  expect(write).toHaveBeenLastCalledWith(LANGUAGE_KEY, "system");
});

it("reports a failed save without claiming the language persisted", async () => {
  write.mockRejectedValue(new Error("Keychain unavailable"));
  const result = render(<I18nProvider><UiText>Settings</UiText><LanguagePicker /></I18nProvider>);
  fireEvent.press(result.getByTestId("language-ar"));
  await waitFor(() => expect(result.getByText("Couldn't save language. Try again.")).toBeTruthy());
  expect(result.getByText("Settings")).toBeTruthy();
  expect(result.getByTestId("language-system").props.accessibilityState.checked).toBe(true);
});

it("does not let a delayed startup read overwrite a newer user choice", async () => {
  let finish!: (value: string) => void;
  read.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const result = render(<I18nProvider><UiText>Settings</UiText><LanguagePicker /></I18nProvider>);
  fireEvent.press(result.getByTestId("language-es"));
  await waitFor(() => expect(result.getByText("Ajustes")).toBeTruthy());
  await act(async () => { finish("ar"); });
  expect(result.getByText("Ajustes")).toBeTruthy();
});

it("sends the same translated quick reply that the user selected", async () => {
  read.mockResolvedValue("ar");
  const onReply = jest.fn();
  const result = render(<I18nProvider><ReplyChips slash={false} replies onSlash={() => {}} onReply={onReply} /></I18nProvider>);
  await waitFor(() => expect(result.getByText("متابعة")).toBeTruthy());
  fireEvent.press(result.getByText("متابعة"));
  expect(onReply).toHaveBeenCalledWith("متابعة");
});
