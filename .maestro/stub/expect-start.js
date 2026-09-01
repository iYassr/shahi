// The stub records every write; the last one must be the agent start, in
// the space that was picked. WORKSPACE arrives from the flow's `env`.
const response = http.get("http://localhost:7272/__stub/writes");
const writes = json(response.body).writes;
const last = writes[writes.length - 1];
if (!last || last.path !== "/api/agents/start") {
  throw new Error("expected the last write to start an agent, got " + JSON.stringify(last));
}
if (!last.body || last.body.workspaceId !== WORKSPACE) {
  throw new Error("expected the agent in " + WORKSPACE + ", got " + JSON.stringify(last.body));
}
