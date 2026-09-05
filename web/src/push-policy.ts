interface Connection { generation: number; remembered: boolean; identity: unknown }

/** Browser permission belongs to an origin; consent here belongs to one computer. */
export function checkPushConnection(hosted: boolean, current: Connection, expectedGeneration: number): void {
  if (!hosted) return;
  if (current.generation !== expectedGeneration || !current.identity) throw new DOMException("The connection changed. Enable notifications again for this computer.", "AbortError");
  if (!current.remembered) throw new Error("Pair again with Remember this browser selected to enable notifications.");
}
