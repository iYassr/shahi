// Tells the stub to speak a contract range other than the app's, so the app
// can be shown a server it cannot talk to. MIN and MAX arrive from the flow's
// `env`; the port is the stub's, the same one every other flow signs in to.
// Reset by `reset.js`, and by any scenario change.
const response = http.post("http://localhost:7272/__stub/meta", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ api: { min: Number(MIN), max: Number(MAX) } }),
});
if (!response.ok) {
  throw new Error("the stub refused the contract override: HTTP " + response.status);
}
