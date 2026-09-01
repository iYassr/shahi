// Puts the stub back on its default scenario, which also drops any contract
// override: an override left behind would fail every flow after it for a
// reason none of them names.
const response = http.post("http://localhost:7272/__stub/scenario", {
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "busy" }),
});
if (!response.ok) {
  throw new Error("the stub could not be reset: HTTP " + response.status);
}
