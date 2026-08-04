import { Redirect } from "expo-router";

/** "/" was the Agents tab before each tab became its own stack. */
export default function Index() {
  return <Redirect href="/agents" />;
}
