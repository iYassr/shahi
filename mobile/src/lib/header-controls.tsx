import type { ReactElement } from "react";

/** Keep custom controls unboxed on iOS while retaining the Android header. */
export function plainHeaderRight(element: ReactElement) {
  return {
    headerRight: () => element,
    unstable_headerRightItems: () => [{
      type: "custom" as const,
      element,
      hidesSharedBackground: true,
    }],
  };
}
