import { useCallback, useEffect, useRef } from "react";
import { View, type LayoutChangeEvent, type ViewProps } from "react-native";

export type ScrollAnchor = { id: string; offset: number };
export type CellFrame = { y: number; height: number };

/** A message may be many screens tall: its id alone is not a reading position. */
export function anchorAt(frames: Map<string, CellFrame>, y: number): ScrollAnchor | undefined {
  let first: [string, CellFrame] | undefined;
  let containing: [string, CellFrame] | undefined;
  for (const entry of frames) {
    if (!first || entry[1].y < first[1].y) first = entry;
    if (entry[1].y <= y && entry[1].y + entry[1].height > y) containing = entry;
  }
  const cell = containing ?? (first && y < first[1].y ? first : undefined);
  return cell ? { id: cell[0], offset: y - cell[1].y } : undefined;
}

/** Observe the actual cell container, not renderItem's child whose y is always zero. */
export function useScrollCells<T>(idOf: (item: T) => string) {
  const frames = useRef(new Map<string, CellFrame>());
  const identify = useRef(idOf);
  identify.current = idOf;
  const CellRendererComponent = useCallback(function ScrollCell({ item, children, onLayout, cellKey: _cellKey, index: _index, ...props }: ViewProps & { item: T; cellKey: string; index: number }) {
    const id = identify.current(item);
    useEffect(() => () => { frames.current.delete(id); }, [id]);
    return (
    <View {...props} onLayout={(event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      frames.current.set(id, { y, height });
      onLayout?.(event);
    }}>{children}</View>
  ); }, []);
  return { frames, CellRendererComponent };
}
