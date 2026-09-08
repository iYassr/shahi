import { getRandomBytes } from "expo-crypto";
import { RelayLink as SharedRelayLink, type RelayTarget } from "@shahi/shared/relay-client";
export * from "@shahi/shared/relay-client";

/** Native CSPRNG adapter; protocol and transport are shared with the browser. */
export class RelayLink extends SharedRelayLink {
  constructor(target: RelayTarget) { super(target, { randomBytes: getRandomBytes }); }
}

/** A link belongs to one credential target, independent of the selected screen. */
const links = new Map<RelayTarget, RelayLink>();
export function relayLink(target: RelayTarget): RelayLink {
  let link = links.get(target);
  if (!link) { link = new RelayLink(target); links.set(target, link); }
  return link;
}
export function closeRelay(target?: RelayTarget): void {
  if (target) { links.get(target)?.close(); links.delete(target); }
  else { for (const link of links.values()) link.close(); links.clear(); }
}
