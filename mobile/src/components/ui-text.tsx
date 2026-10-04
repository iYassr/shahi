import { StyleSheet, type TextStyle } from "react-native";
import type { ComponentProps } from "react";
import { Text } from "./text";
import { useI18n } from "@/lib/i18n";

/** Only authored interface copy uses this component. User/agent text uses Text. */
export function UiText({ children, style, ...props }: Omit<ComponentProps<typeof Text>, "children"> & { children?: string | number | null | false }) {
  const { t, direction } = useI18n();
  const existing = StyleSheet.flatten(style) as TextStyle | undefined;
  const alignment = existing?.textAlign;
  // React Native mirrors left/right alignment for an RTL Yoga text node.
  // Keep the authored alignment logical; flipping it here mirrors it twice.
  const textAlign = alignment ?? "left";
  return <Text {...props} style={[style, { direction, writingDirection: direction, textAlign }]}>{typeof children === "string" ? t(children) : children}</Text>;
}
