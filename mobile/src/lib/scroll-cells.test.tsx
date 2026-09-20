import { fireEvent, render, renderHook } from "@testing-library/react-native";
import { useScrollCells } from "./scroll-cells";

test("frame changes reach the latest observer after FlatList receives its measurement", () => {
  const order: string[] = [];
  const first = jest.fn(() => { order.push("first"); });
  const latest = jest.fn(() => { order.push("latest"); });
  const hook = renderHook(({ observer }) => useScrollCells<{ id: string }>((item) => item.id, observer), {
    initialProps: { observer: first },
  });
  const Cell = hook.result.current.CellRendererComponent;
  const cell = render(<Cell testID="cell" item={{ id: "message" }} cellKey="message" index={0}
    onLayout={() => { order.push("native"); }} />);
  const layout = (y: number) => fireEvent(cell.getByTestId("cell"), "layout", {
    nativeEvent: { layout: { x: 0, y, width: 400, height: 500 } },
  });

  layout(100);
  expect(order).toEqual(["native", "first"]);
  expect(first).toHaveBeenLastCalledWith("message", { y: 100, height: 500 });

  hook.rerender({ observer: latest });
  expect(hook.result.current.CellRendererComponent).toBe(Cell);
  layout(430);
  expect(order.slice(-2)).toEqual(["native", "latest"]);
  expect(latest).toHaveBeenLastCalledWith("message", { y: 430, height: 500 });
  expect(hook.result.current.frames.current.get("message")).toEqual({ y: 430, height: 500 });

  layout(430);
  expect(latest).toHaveBeenCalledTimes(1);
  expect(order.at(-1)).toBe("native");
  cell.unmount();
  expect(hook.result.current.frames.current.has("message")).toBe(false);
  hook.unmount();
});
