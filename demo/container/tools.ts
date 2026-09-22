/** Three fixed demo tools. No arbitrary commands or user-controlled paths. */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
const root = "/home/demo/workspace";
const descriptions = { list_files: "List files in the sample project", read_readme: "Read the sample project's README", create_sample_file: "Create demo-note.txt in the sample project" };
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "shahi-demo-tools", version: "1.0.0" } };
    else if (request.method === "tools/list") result = { tools: Object.entries(descriptions).map(([name, description]) => ({ name, description, annotations: { readOnlyHint: name !== "create_sample_file", destructiveHint: false, openWorldHint: false }, inputSchema: { type: "object", properties: {}, additionalProperties: false } })) };
    else if (request.method === "tools/call") {
      let text: string;
      if (request.params?.name === "list_files") text = (await readdir(root)).join("\n");
      else if (request.params?.name === "read_readme") text = (await readFile(`${root}/README.md`, "utf8")).slice(0,8000);
      else if (request.params?.name === "create_sample_file") { await writeFile(`${root}/demo-note.txt`, "Created in the isolated Shahi demo.\n"); text = "Created demo-note.txt"; }
      else throw new Error("Unknown demo tool");
      result = { content: [{ type: "text", text }] };
    } else if (request.method === "ping") result = {};
    else { console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })); continue; }
    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  } catch { /* Never copy private file content into error diagnostics. */ }
}
