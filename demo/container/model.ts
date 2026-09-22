/** Local, deterministic Responses endpoint. No AI service, credentials or network calls. */
const encoder = new TextEncoder();
export function answer(body: any) {
  const input = Array.isArray(body.input) ? body.input : [];
  const lastUser = input.findLastIndex((item: any) => item.role === "user");
  const message = input[lastUser];
  const text = typeof message?.content === "string" ? message.content : (message?.content ?? []).map((x: any) => x.text ?? "").join("\n");
  const toolFinished = input.slice(lastUser + 1).some((x: any) => /(?:function|custom_tool)_call_output/.test(x.type));
  const tools = (body.tools ?? []).flatMap((t: any) => t.type === "namespace" ? t.tools.map((child: any) => ({ ...child, namespace: t.name })) : [t]);
  const wanted = /create a sample file/i.test(text) ? "create_sample_file" : /read the readme/i.test(text) ? "read_readme" : "list_files";
  const demoTool = tools.find((t: any) => t.name?.includes(wanted));
  const tool = demoTool ?? tools.find((t: any) => t.name === "exec_command" || t.name === "shell_command" || t.name === "shell");
  let output: any;
  if (!toolFinished && tool && /list files|show files|read the readme|try a tool|create a sample file/i.test(text)) {
    const cmd = /create a sample file/i.test(text) ? "printf 'Created in the isolated Shahi demo.\\n' > demo-note.txt && cat demo-note.txt" : /read the readme/i.test(text) ? "cat README.md" : "ls -la";
    const args = demoTool ? {} : tool.name === "exec_command" ? { cmd, max_output_tokens: 600 } : tool.name === "shell_command" ? { command: cmd } : { command: ["bash", "-lc", cmd] };
    output = { type: "function_call", id: `fc_${crypto.randomUUID()}`, call_id: `call_${crypto.randomUUID()}`, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), arguments: JSON.stringify(args), status: "completed" };
  } else {
    const reply = toolFinished ? "**Simulated demo response.** The tool result is shown above. File and terminal operations run on this isolated computer. Try another message, switch between Read and Screen, or leave and reconnect." : "**Simulated demo agent — no AI service is connected.**\n\nYour message reached the isolated review computer through Shahi. These replies are scripted so you can test the interface without an AI account.\n\nTry **list files**, **read the README**, or **create a sample file** to exercise real tool activity. You can also send an attachment, create another agent, or reconnect. Replies to other prompts use this demonstration response.";
    output = { id: `msg_${crypto.randomUUID()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
  }
  return output;
}
export function events(output: any) {
  const response = { id: `resp_${crypto.randomUUID()}`, object: "response", created_at: Math.floor(Date.now()/1000), status: "completed", model: "shahi-demo", output: [output], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
  let sequence = 0;
  const event = (type: string, values: any) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...values })}\n\n`;
  const chunks = [event("response.created", { response: { ...response, output: [], status: "in_progress" } })];
  chunks.push(event("response.output_item.added", { output_index: 0, item: { ...output, status: "in_progress", ...(output.type === "message" ? { content: [] } : { arguments: "" }) } }));
  if (output.type === "message") {
    chunks.push(event("response.content_part.added", { item_id: output.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    for (const piece of output.content[0].text.match(/.{1,45}/gs) ?? []) chunks.push(event("response.output_text.delta", { item_id: output.id, output_index: 0, content_index: 0, delta: piece }));
    chunks.push(event("response.output_text.done", { item_id: output.id, output_index: 0, content_index: 0, text: output.content[0].text }));
    chunks.push(event("response.content_part.done", { item_id: output.id, output_index: 0, content_index: 0, part: output.content[0] }));
  } else chunks.push(event("response.function_call_arguments.delta", { item_id: output.id, output_index: 0, delta: output.arguments }));
  chunks.push(event("response.output_item.done", { output_index: 0, item: output }));
  chunks.push(event("response.completed", { response }));
  return chunks;
}
if (import.meta.main) Bun.serve({ hostname: "127.0.0.1", port: 9090, maxRequestBodySize: 8 * 1024 * 1024,
  async fetch(request) {
    if (new URL(request.url).pathname !== "/v1/responses" || request.method !== "POST") return new Response("Not found", { status: 404 });
    try {
      const chunks = events(answer(await request.json()));
      let index = 0;
      return new Response(new ReadableStream({ async pull(controller) {
        if (index === chunks.length) return controller.close();
        await Bun.sleep(65); controller.enqueue(encoder.encode(chunks[index++]));
      } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    } catch { return Response.json({ error: { message: "Invalid demo request" } }, { status: 400 }); }
  },
});
