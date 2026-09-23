// The fixture's stub records every write; the last one must be the option
// posted to `/answer`, with the label the card showed. A digit on `/keys`
// would be the old behaviour — and, for a cursor menu, a keystroke that does
// nothing.
var writes = json(http.get("http://127.0.0.1:" + FIXTURE_PORT + "/__hosted/writes").body).writes;
var last = writes[writes.length - 1];
if (!last || !/\/api\/panes\/[^/]+\/answer$/.test(last.path)) {
  throw new Error("expected the last write on /answer, got " + JSON.stringify(last));
}
if (!last.body || last.body.label !== LABEL) {
  throw new Error("expected the answer to carry the label " + LABEL + ", got " + JSON.stringify(last.body));
}
