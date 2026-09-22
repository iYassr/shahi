import { expect, test } from "bun:test";
import { answer, events } from "./model";

test("every reply discloses simulation and uses no external model", () => {
  const response = answer({ input: [{ role: "user", content: "hello" }] });
  expect(response.content[0].text).toContain("Simulated demo agent");
  expect(events(response).at(-1)).toContain("response.completed");
});
test("tool demonstration never interpolates arbitrary prompt text into commands", () => {
  const response = answer({ input: [{ role: "user", content: "list files; rm -rf /" }], tools: [{ name: "exec_command" }] });
  expect(JSON.parse(response.arguments).cmd).toBe("ls -la");
});
test("a completed tool produces a final reply, not an endless tool loop", () => {
  const response = answer({ input: [{ role: "user", content: "list files" }, { type: "function_call_output", output: "README.md" }], tools: [{ name: "exec_command" }] });
  expect(response.type).toBe("message");
  expect(response.content[0].text).toContain("Simulated demo response");
});
test("tool requests respect the advertised name and schema", () => {
  const response = answer({ input: [{ role: "user", content: [{ text: "read the README" }] }], tools: [{ type: "namespace", tools: [{ name: "shell" }] }] });
  expect(response.name).toBe("shell");
  expect(JSON.parse(response.arguments).command).toEqual(["bash", "-lc", "cat README.md"]);
});

test("MCP tool namespaces survive the simulated response", () => {
  const result = answer({ input: [{ role: "user", content: "list files" }], tools: [{ type: "namespace", name: "mcp__shahi_demo", tools: [{ name: "list_files" }] }] });
  expect(result.namespace).toBe("mcp__shahi_demo");
  expect(result.name).toBe("list_files");
  expect(result.arguments).toBe("{}");
});
