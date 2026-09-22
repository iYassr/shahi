import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorSessionFromStore, findCursorTranscript, normaliseCursor, readCursorLog } from "./cursor-log";
import { previewOf } from "./session-log";
const id = "11111111-2222-4333-8444-555555555555";
const user = (text: string) => ({role:"user",message:{content:[{type:"text",text}]}});
const agent = (text: string) => ({role:"assistant",message:{content:[{type:"text",text},{type:"tool_use",name:"Read",input:{path:"/tmp/sample.txt"}}]}});
test("Cursor calls with missing results are explicit, not perpetually running", () => {
 const log=normaliseCursor([user("hello"),agent("reply"),{type:"turn_ended",status:"completed"}]);
 expect(log.map(x=>x.role)).toEqual(["you","agent"]);
 expect(log[1]!.blocks[1]).toMatchObject({kind:"tool",file:{path:"/tmp/sample.txt",name:"sample.txt"},outputUnavailable:true,result:null});
 expect(log.map(x=>x.at)).toEqual([0,0]);
});
// The real shape, reconstructed from a tag-name census of local transcripts:
// Cursor records the context it sends the model, so every user bubble showed
// its <timestamp>/<user_query> wrappers and a tool catalogue showed as a
// message the person sent (review finding, September 2026).
test("Cursor user turns show what was typed, not the timestamp and tool-catalogue wrappers", () => {
 const typed = user("<timestamp>Monday, Sep 21, 2026, 10:14 AM (UTC+3)</timestamp>\n<user_query>\nfix the login bug\n</user_query>\n");
 const stamp = user("<timestamp>Monday, Sep 21, 2026, 10:15 AM (UTC+3)</timestamp>\n");
 const tools = user(`<dynamic_tools>\n${"<tool><name>t</name><description>d</description></tool>\n".repeat(50)}</dynamic_tools>`);
 const log = normaliseCursor([tools, typed, agent("On it."), stamp]);
 expect(log.map(m => [m.role, m.blocks[0]])).toEqual([
  ["you", { kind: "text", text: "fix the login bug" }],
  ["agent", { kind: "text", text: "On it." }],
 ]);
 expect(previewOf(log.slice(0, 1))).toBe("You: fix the login bug");
 expect(normaliseCursor([user("<timestamp>now</timestamp>\nplain words")])[0]!.blocks[0]).toEqual({ kind: "text", text: "plain words" });
});
test("store lookup requires an exact Cursor database path",()=>{
 expect(cursorSessionFromStore(`/tmp/cursor/chats/project/${id}/store.db`,"/tmp/cursor")).toBe(id);
 for(const p of [`/tmp/cursor-other/chats/project/${id}/store.db`,`/tmp/cursor/chats/project/${id}/store.db-wal`,`/tmp/cursor/chats/project/../../other/store.db`]) expect(cursorSessionFromStore(p,"/tmp/cursor")).toBeNull();
});
test("pagination keeps stable identities, ignores partial writes, and discovers exact sessions",async()=>{
 const root=await mkdtemp(join(tmpdir(),"shahi-cursor-test-"));
 try {
  const dir=join(root,"projects","sample","agent-transcripts",id); await mkdir(dir,{recursive:true});
  const path=join(dir,`${id}.jsonl`);
  await writeFile(path,[user("one"),agent("two"),{type:"turn_ended"},user("three"),agent("four")].map(x=>JSON.stringify(x)+"\n").join(""));
  expect(await findCursorTranscript(id,root)).toBe(await realpath(path));
  expect(await findCursorTranscript("../other",root)).toBeNull();
  const tail=await readCursorLog(path,{limit:2}); const older=await readCursorLog(path,{before:2,limit:2});
  expect(tail?.total).toBe(4); expect(tail?.messages.map(x=>x.id)).toEqual([`${id}:cursor-2`,`${id}:cursor-3`]);
  expect(older?.messages.map(x=>x.id)).toEqual([`${id}:cursor-0`,`${id}:cursor-1`]);
  await appendFile(path,JSON.stringify(user("last"))); expect((await readCursorLog(path))?.total).toBe(4);
  await appendFile(path,"\n"); expect((await readCursorLog(path))?.total).toBe(5);
  const outside=join(root,"outside.jsonl");await writeFile(outside,"{}");await rm(path);await symlink(outside,path);
  expect(await findCursorTranscript(id,root)).toBeNull();
 } finally {await rm(root,{recursive:true,force:true});}
});

// A herdr pane outlives the chat in it, and both clients merge a fresh page into
// the pane's cached messages by id. Every Cursor transcript numbered its
// messages from cursor-0, so a new chat in the same pane matched the old one's
// ids: the phone kept the old chat's messages and the web reader showed both
// chats as one thread (review finding, September 2026).
test("a new Cursor chat in the same pane shares no message ids with the previous one", async () => {
 const root=await mkdtemp(join(tmpdir(),"shahi-cursor-switch-"));
 const next="99999999-8888-4777-8666-555555555555";
 try {
  const dir=join(root,"projects","sample","agent-transcripts"); await mkdir(dir,{recursive:true});
  const chat=(name:string,words:string[])=>writeFile(join(dir,`${name}.jsonl`),words.map((w,i)=>JSON.stringify(i%2?agent(w):user(w))+"\n").join(""));
  await chat(id,["old question","old answer"]); await chat(next,["new question","new answer","new follow-up"]);
  const before=(await readCursorLog(join(dir,`${id}.jsonl`)))!; const after=(await readCursorLog(join(dir,`${next}.jsonl`)))!;
  expect(after.sessionId).not.toBe(before.sessionId);
  const old=new Set(before.messages.map(m=>m.id));
  expect(after.messages.filter(m=>old.has(m.id))).toEqual([]);
  // Still stable within one chat, which is what the clients' merge relies on.
  expect((await readCursorLog(join(dir,`${next}.jsonl`)))!.messages.map(m=>m.id)).toEqual(after.messages.map(m=>m.id));
 } finally {await rm(root,{recursive:true,force:true});}
});

test("older flat Cursor transcripts keep their actual session ID", async () => {
 const root=await mkdtemp(join(tmpdir(),"shahi-cursor-flat-"));
 try {
  const dir=join(root,"projects","sample","agent-transcripts"); await mkdir(dir,{recursive:true});
  const path=join(dir,`${id}.jsonl`); await writeFile(path,JSON.stringify(agent("A reply"))+"\n");
  expect(await findCursorTranscript(id,root)).toBe(await realpath(path));
  expect((await readCursorLog(path))?.sessionId).toBe(id);
 } finally {await rm(root,{recursive:true,force:true});}
});
