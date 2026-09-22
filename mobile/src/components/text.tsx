import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { Text as NativeText, useWindowDimensions } from "react-native";

const FontScale = createContext(1);
export function TypographyProvider({ children }: { children: ReactNode }) {
  const { fontScale } = useWindowDimensions();
  return <FontScale.Provider value={fontScale}>{children}</FontScale.Provider>;
}

/**
 * Accessibility text sizes: AX1 and up, a font scale above 1.4. Past this a
 * title sharing its line with metadata is squeezed to a few characters, so
 * every list row and card that names a conversation stacks its lines here.
 * One threshold for all of them, so they change layout at the same size.
 */
export function useLargeText() {
  return useWindowDimensions().fontScale > 1.4;
}

/** iOS can resize glyphs without invalidating their previous measured box.
 * Replace only the text host when Dynamic Type changes, keeping screen, input,
 * draft and navigation state mounted. Context also reaches memoized list rows. */
export function Text(props: ComponentProps<typeof NativeText>) {
  const scale = useContext(FontScale);
  return <NativeText key={scale} {...props} />;
}
