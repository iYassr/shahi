import { useState } from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { Dimensions, TextInput } from "react-native";
import { Text, TypographyProvider } from "./text";

test("changing text size preserves the mounted screen and its unsent input", () => {
  let mounts = 0;
  function Screen() {
    const [draft, setDraft] = useState(() => { mounts++; return ""; });
    return <><Text>Conversation title</Text><TextInput accessibilityLabel="Draft" value={draft} onChangeText={setDraft} /></>;
  }
  const before = Dimensions.get("window");
  const screen = Dimensions.get("screen");
  const view = render(<TypographyProvider><Screen /></TypographyProvider>);
  fireEvent.changeText(view.getByLabelText("Draft"), "Keep this message");
  try {
    act(() => Dimensions.set({ window: { ...before, fontScale: 2.4 }, screen }));
    expect(view.getByDisplayValue("Keep this message")).toBeTruthy();
    expect(view.getByText("Conversation title")).toBeTruthy();
    expect(mounts).toBe(1);
  } finally { act(() => Dimensions.set({ window: before, screen })); }
});
