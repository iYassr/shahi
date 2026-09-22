import { readFileSync, writeFileSync } from "node:fs";
import { RelayLink, deviceTarget } from "../shared/src/relay-client";
import { SHAHI_API_VERSION } from "../shared/src/index";
const dir = process.env.HOME + "/.config/shahi-review-demo";
const identity = JSON.parse(readFileSync(dir + "/remote-device.json", "utf8"));
const link = new RelayLink(deviceTarget(identity));
const headers = { "x-shahi-api": String(SHAHI_API_VERSION) };
try {
 if (process.argv.includes("--restore")) {
  const { path, text } = JSON.parse(readFileSync(dir + "/uploaded-file.json", "utf8"));
  const response = await link.request({method:"GET",path:`/api/file?path=${encodeURIComponent(path)}`,headers,body:null},30000);
  if (!response.ok || await response.text() !== text) throw new Error("Upload did not survive restart");
  console.log("PASS saved pairing and uploaded file survived cloud restart");
 } else {
  const text = "Isolated demo upload verification\n".repeat(3000);
  const form = new FormData(); form.set("file",new File([text],"review-sample.txt",{type:"text/plain"}));
  const request = new Request("http://local",{method:"POST",body:form});
  const response = await link.request({method:"POST",path:"/api/uploads",headers:{...headers,"content-type":request.headers.get("content-type")!},body:new Uint8Array(await request.arrayBuffer())},60000);
  const upload=await response.json() as any;
  if (!response.ok || !upload.path) throw new Error("Demo file upload failed");
  writeFileSync(dir + "/uploaded-file.json",JSON.stringify({path:upload.path,text}),{mode:0o600});
  const download=await link.request({method:"GET",path:`/api/file?path=${encodeURIComponent(upload.path)}`,headers,body:null},30000);
  if (!download.ok || await download.text()!==text) throw new Error("Demo file content mismatch");
  console.log("PASS encrypted 99 KB upload and exact download verification");
 }
} finally { link.close(); }
