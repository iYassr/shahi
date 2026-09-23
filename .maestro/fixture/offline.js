// Takes the fixture's box off its relay, like a computer that is asleep or
// whose Shahi is stopped: the relay then refuses a phone for it with "box
// offline". The next reset.js (any new pairing) brings it back.
var response = http.post("http://127.0.0.1:" + FIXTURE_PORT + "/__hosted/offline", { body: "" });
if (!response.ok) throw new Error("the fixture refused to go offline: HTTP " + response.status);
