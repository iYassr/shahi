// The stub records every write; the last one must be the option posted to
// `/answer`, with the label the card showed. A digit on `/keys` would be the
// old behaviour — and, for a cursor menu, a keystroke that does nothing.
const response = http.get("http://localhost:7272/__stub/writes");
const writes = json(response.body).writes;
const last = writes[writes.length - 1];
if (!last || !/\/api\/panes\/[^/]+\/answer$/.test(last.path)) {
  throw new Error("expected the last write on /answer, got " + JSON.stringify(last));
}
if (!last.body || last.body.label !== LABEL) {
  throw new Error("expected the answer to carry the label " + LABEL + ", got " + JSON.stringify(last.body));
}
