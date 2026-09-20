import { DarkTheme } from "expo-router";
import { theme } from "./theme";

// Native headers derive their glass appearance from the navigation theme,
// independently of app.json's userInterfaceStyle. Without this, iOS 27 uses
// light button backgrounds on Shahi's dark screens.
export const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: theme.peach,
    background: theme.void,
    card: theme.void,
    text: theme.fg,
    border: theme.line,
    notification: theme.peach,
  },
};
