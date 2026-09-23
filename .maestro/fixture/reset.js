// Resets the recording fixture (e2e/hosted/server.ts): a new single-use
// pairing code, no paired devices, no recorded writes, and the stub on its
// "busy" scenario — or on SCENARIO, when the flow names one. The code comes
// back as output.pairingCode for the flow to open.
var fixture = "http://127.0.0.1:" + FIXTURE_PORT;
var reset = http.post(fixture + "/__hosted/reset", { body: "" });
if (!reset.ok) {
  throw new Error("no recording fixture answered on port " + FIXTURE_PORT + " (HTTP " + reset.status + "); start e2e/hosted/server.ts there");
}
output.pairingCode = json(reset.body).code;

if (SCENARIO !== "busy") {
  // The fixture's own stub listens on the port above it.
  var stub = "http://127.0.0.1:" + (Number(FIXTURE_PORT) + 1);
  var chosen = http.post(stub + "/__stub/scenario", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: SCENARIO }),
  });
  if (!chosen.ok) throw new Error("the fixture refused scenario " + SCENARIO + ": HTTP " + chosen.status);
}
