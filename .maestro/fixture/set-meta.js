// Tells the fixture's stub to speak a contract range other than the app's,
// so the app meets a computer it cannot talk to. MIN and MAX arrive from the
// flow; reset.js (any new pairing) puts the stub back on the app's version.
var stub = "http://127.0.0.1:" + (Number(FIXTURE_PORT) + 1);
var response = http.post(stub + "/__stub/meta", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ api: { min: Number(MIN), max: Number(MAX) } }),
});
if (!response.ok) throw new Error("the stub refused the contract override: HTTP " + response.status);
