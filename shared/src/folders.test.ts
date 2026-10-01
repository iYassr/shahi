import { expect, test } from "bun:test";
import { breadcrumb, folderName } from "./folders";

test("a breadcrumb climbs from the folder back to home", () => {
  expect(breadcrumb("~/projects/shahi")).toEqual([
    { label: "Home", display: "~" },
    { label: "projects", display: "~/projects" },
    { label: "shahi", display: "~/projects/shahi" },
  ]);
  expect(breadcrumb("~")).toEqual([{ label: "Home", display: "~" }]);
});

test("a folder outside home is one step, as the computer cannot list above it", () => {
  expect(breadcrumb("/tmp/x")).toEqual([{ label: "/tmp/x", display: "/tmp/x" }]);
});

test("a space is named after its folder", () => {
  expect(folderName("/home/you/projects/shahi")).toBe("shahi");
  expect(folderName("~/projects/shahi/")).toBe("shahi");
  expect(folderName("~")).toBe("home");
});
