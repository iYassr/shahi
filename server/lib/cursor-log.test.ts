import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, appendFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorSessionFromStore, findCursorTranscript, normaliseCursor, readCursorLog } from "./cursor-log";
import { previewOf, readWindow } from "./session-log";
import { cursorExport } from "../fixtures/cursor-transcripts";
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
test("Cursor preserves exported attachment labels without inventing image bytes or file paths", () => {
 const log = normaliseCursor(cursorExport);
 expect(log[0]!.blocks).toEqual([{kind:"text",text:"Compare the screenshot with the document.\n\n[Image]\n\n[File: spec.pdf]"}]);
 expect(log[1]!.blocks).toEqual([
  {kind:"text",text:"I will read the specification.\n\nThe two inputs describe the same page."},
  {kind:"tool",name:"Read",summary:"/tmp/cursor-reader-fixture/spec.txt",file:{path:"/tmp/cursor-reader-fixture/spec.txt",name:"spec.txt"},result:null,outputUnavailable:true},
  {kind:"tool",name:"Shell",summary:"printf READER_OK",result:null,outputUnavailable:true},
 ]);
 const context = normaliseCursor([user("<dynamic_tools>\n[Image]\n[File: context.pdf]\n</dynamic_tools>\n<user_query>Only my text.</user_query>\n<instructions_update>[File: rules.txt]</instructions_update>")]);
 expect(context[0]!.blocks).toEqual([{kind:"text",text:"Only my text."}]);
 expect(normaliseCursor([user("[Image]\n[File]")])[0]!.blocks).toEqual([{kind:"text",text:"[Image]\n[File]"}]);
});
test("Cursor failure and cancellation details are system notes, not a user message or a running tool", () => {
 const log = normaliseCursor(cursorExport);
 expect(log.map(m => [m.id,m.role])).toEqual([["cursor-0","you"],["cursor-1","agent"],["cursor-2","system"],["cursor-3","you"],["cursor-4","system"]]);
 expect(log[2]!.blocks).toEqual([{kind:"text",text:"Agent turn failed: The provider could not finish this request."}]);
 expect(log[4]!.blocks).toEqual([{kind:"text",text:"Agent turn cancelled: User aborted/interrupted manually."}]);
 expect(normaliseCursor([{type:"turn_ended",status:"aborted"}])[0]!.blocks).toEqual([{kind:"text",text:"Agent turn cancelled."}]);
 expect(normaliseCursor([{type:"turn_ended",status:"error",error:{message:"unknown shape"}}])[0]!.blocks).toEqual([{kind:"text",text:"Agent turn failed."}]);
 expect(normaliseCursor([{type:"turn_ended",status:"success"},{type:"turn_ended",status:"unknown",error:"not a known failure"},{type:"metadata",metadata:{overview:"Not a message"}}])).toEqual([]);
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
  expect(tail?.total).toBe(4); expect(tail?.messages.map(x=>x.id.split(":").at(-1))).toEqual(["cursor-2","cursor-3"]);
  expect(older?.messages.map(x=>x.id.split(":").at(-1))).toEqual(["cursor-0","cursor-1"]);
  expect(tail?.sessionId).toBe(id); expect(older?.path).toBe(tail?.path);
  await appendFile(path,JSON.stringify(user("last")));
  const partial=await readCursorLog(path); expect(partial?.total).toBe(4); expect(partial?.path).toBe(tail?.path);
  await appendFile(path,"\n");
  const complete=await readCursorLog(path); expect(complete?.total).toBe(5); expect(complete?.path).toBe(tail?.path);
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

test("Cursor discovery refuses ambiguous sessions and non-files but accepts aliases of the same file", async () => {
 const root=await mkdtemp(join(tmpdir(),"shahi-cursor-ownership-"));
 try {
  const first=join(root,"projects","first","agent-transcripts",id);
  const second=join(root,"projects","second","agent-transcripts",id);
  await mkdir(first,{recursive:true}); await mkdir(second,{recursive:true});
  const path=join(first,`${id}.jsonl`), duplicate=join(second,`${id}.jsonl`);
  await writeFile(path,JSON.stringify(user("first"))+"\n");
  await writeFile(duplicate,JSON.stringify(user("second"))+"\n");
  expect(await findCursorTranscript(id,root)).toBeNull();
  await rm(duplicate); await symlink(path,duplicate);
  expect(await findCursorTranscript(id,root)).toBe(await realpath(path));
  await rm(duplicate); await rm(path); await mkdir(path);
  expect(await findCursorTranscript(id,root)).toBeNull();
 } finally {await rm(root,{recursive:true,force:true});}
});

test("Cursor discovery refuses an in-root symlink to another session", async () => {
 const root=await mkdtemp(join(tmpdir(),"shahi-cursor-session-link-"));
 try {
  const project=join(root,"projects","sample");
  const dir=join(project,"agent-transcripts");
  const otherId="99999999-8888-4777-8666-555555555555";
  const other=join(dir,`${otherId}.jsonl`);
  await mkdir(dir,{recursive:true}); await writeFile(other,JSON.stringify(user("Other session"))+"\n");
  await symlink(other,join(dir,`${id}.jsonl`));
  expect(await findCursorTranscript(id,root)).toBeNull();
  expect(await findCursorTranscript(otherId,root)).toBe(await realpath(other));
  await symlink(project,join(root,"projects","sample-alias"));
  expect(await findCursorTranscript(otherId,root)).toBe(await realpath(other));
 } finally {await rm(root,{recursive:true,force:true});}
});

test("Cursor paginates failure notes and follows its full rewrite when the next turn starts", async () => {
 const root=await mkdtemp(join(tmpdir(),"shahi-cursor-rewrite-"));
 try {
  const path=join(root,`${id}.jsonl`);
  await writeFile(path,cursorExport.map(row=>JSON.stringify(row)+"\n").join(""));
  const tail=(await readCursorLog(path,{limit:2}))!;
  const older=(await readCursorLog(path,{limit:2,before:tail.total-tail.messages.length}))!;
  expect(tail.total).toBe(5); expect(tail.messages.map(m=>m.id.split(":").at(-1))).toEqual(["cursor-3","cursor-4"]);
  expect(older.messages.map(m=>m.id.split(":").at(-1))).toEqual(["cursor-1","cursor-2"]);
  expect(older.path).toBe(tail.path);
  const resumed=[...cursorExport.filter(row=>!("type" in row)),user("<user_query>Continue.</user_query>"),agent("Finished."),{type:"turn_ended",status:"success"}];
  await writeFile(path,resumed.map(row=>JSON.stringify(row)+"\n").join(""));
  const next=(await readCursorLog(path))!;
  expect(next.sessionId).toBe(id); expect(next.total).toBe(5);
  expect(next.path).not.toBe(tail.path);
  expect(next.messages.some(m=>tail.messages.some(previous=>previous.id===m.id))).toBe(false);
  expect(next.messages.map(m=>m.role)).toEqual(["you","agent","you","you","agent"]);
  expect(next.messages.some(m=>m.blocks.some(b=>b.kind==="text"&&b.text.startsWith("Agent turn failed")))).toBe(false);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("Cursor's reader boundary resets retained history after a rewrite beyond the fetched tail", async () => {
 const root=await mkdtemp(join(tmpdir(),"shahi-cursor-history-"));
 try {
  const path=join(root,`${id}.jsonl`);
  const history=Array.from({length:100},(_,n)=>user(`Message ${n}`));
  const lines=(rows:object[])=>rows.map(row=>JSON.stringify(row)+"\n").join("");
  await writeFile(path,lines([...history,{type:"turn_ended",status:"error",error:"Interrupted earlier"}]));
  const retained=(await readCursorLog(path,{limit:200}))!;
  const plain=(await readWindow(path,{},normaliseCursor))!;
  expect(plain.path).toBe(path); expect(plain.messages[0]!.id).toBe("cursor-0");
  const seen=new Set(retained.messages.map(m=>m.id));
  await writeFile(path,lines([...history,...Array.from({length:80},(_,n)=>agent(`Reply ${n}`))]));
  const tail=(await readCursorLog(path,{limit:60}))!;
  // Both shipped readers compare sessionId + path before merging any page.
  // Namespaced ids also prevent collisions in older id-only reader caches.
  expect(tail.sessionId).toBe(retained.sessionId);
  expect(tail.path).not.toBe(retained.path);
  expect(tail.messages.filter(m=>seen.has(m.id))).toEqual([]);
  const earlier=(await readCursorLog(path,{limit:60,before:tail.total-tail.messages.length}))!;
  expect(earlier.path).toBe(tail.path);
  await appendFile(path,lines([agent("Appended response")]));
  const appended=(await readCursorLog(path,{limit:61}))!;
  expect(appended.path).toBe(tail.path);
  expect(appended.messages.slice(0,-1).map(m=>m.id)).toEqual(tail.messages.map(m=>m.id));
 } finally {await rm(root,{recursive:true,force:true});}
});

test("Cursor detects an in-place history rewrite even when size and the final 64 bytes are unchanged", async () => {
 const root=await mkdtemp(join(tmpdir(),"shahi-cursor-prefix-"));
 try {
  const path=join(root,`${id}.jsonl`);
  const line=(row:object)=>JSON.stringify(row)+"\n";
  const removed=line(user("Removed message"));
  const middle=Array.from({length:90},(_,n)=>user(`Message ${n}`));
  const ending=agent("The same final answer. ".repeat(20));
  const beforeText=removed+[...middle,ending].map(line).join("");
  await writeFile(path,beforeText);
  const before=(await readCursorLog(path,{limit:200}))!;
  const afterText=[user("x".repeat(removed.length)+"Message 0"),...middle.slice(1),ending].map(line).join("");
  expect(afterText.length).toBe(beforeText.length);
  expect(afterText.slice(-64)).toBe(beforeText.slice(-64));
  await writeFile(path,afterText);
  const after=(await readCursorLog(path,{limit:200}))!;
  expect(after.total).toBe(before.total-1);
  expect(after.path).not.toBe(before.path);
  expect(after.messages[0]!.blocks[0]).toEqual({kind:"text",text:"x".repeat(removed.length)+"Message 0"});
 } finally {await rm(root,{recursive:true,force:true});}
});
