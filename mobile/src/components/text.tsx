import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Text as NativeText, useWindowDimensions } from "react-native";

const FontScale = createContext(1);
export function TypographyProvider({ children }: { children: ReactNode }) {
  const { fontScale } = useWindowDimensions();
  return <FontScale.Provider value={fontScale}>{children}</FontScale.Provider>;
}

/** iOS can resize glyphs without invalidating their previous measured box.
 * Replace only the text host when Dynamic Type changes, keeping screen, input,
 * draft and navigation state mounted. Context also reaches memoized list rows. */
export function Text(props: ComponentProps<typeof NativeText>) {
  const scale = useContext(FontScale);
  return <NativeText key={scale} {...props} />;
}
