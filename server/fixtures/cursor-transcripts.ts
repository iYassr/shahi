/** Synthetic records in Cursor CLI 2026.09.26-dd393fe's JSONL export format.
 * Measured against its installed agent-transcript serializer: reasoning is
 * folded into text, attachments become labels, calls omit ids/results, and
 * turn_ended carries success/error/aborted. These are not private transcripts. */
export const cursorExport = [
  { role: "user", message: { content: [{ type: "text", text: "<dynamic_tools><tool>Context for the model</tool></dynamic_tools>" }] } },
  { role: "user", message: { content: [{ type: "text", text: "<timestamp>Sunday, Sep 27, 2026, 9:00 AM</timestamp>\n<user_query>Compare the screenshot with the document.</user_query>\n[Image]\n[File: spec.pdf]" }] } },
  { role: "assistant", message: { content: [
    { type: "text", text: "I will read the specification.\n\nThe two inputs describe the same page." },
    { type: "tool_use", name: "Read", input: { path: "/tmp/cursor-reader-fixture/spec.txt" } },
    { type: "tool_use", name: "Shell", input: { command: "printf READER_OK" } },
  ] } },
  { type: "turn_ended", status: "error", error: "The provider could not finish this request." },
  { role: "user", message: { content: [{ type: "text", text: "<user_query>Try again.</user_query>" }] } },
  { type: "turn_ended", status: "aborted", error: "User aborted/interrupted manually." },
];
