// Puts the fixture's stub back on the app's own contract version, as updating
// the computer would, without spending or replacing the pairing code in hand.
var stub = "http://127.0.0.1:" + (Number(FIXTURE_PORT) + 1);
var response = http.post(stub + "/__stub/scenario", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "busy" }),
});
if (!response.ok) throw new Error("the stub refused the reset: HTTP " + response.status);
