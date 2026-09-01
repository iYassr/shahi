// Puts the stub on a named scenario. NAME arrives from the flow's `env`; the
// port is the stub's, the same one every other flow signs in to.
const response = http.post("http://localhost:7272/__stub/scenario", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: NAME }),
});
if (!response.ok) {
  throw new Error("the stub refused scenario " + NAME + ": HTTP " + response.status);
}
