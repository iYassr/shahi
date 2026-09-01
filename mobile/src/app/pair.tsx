/**
 * `shahi://pair#…` lands here. It is the Connect screen under another name,
 * so the pairing link reaches `useURL()` inside it instead of expo-router's
 * unmatched-route page. A signed-in app redirects home from Connect, so a
 * link while signed in is ignored; sign out first to re-pair.
 */
export { default } from "./connect";
