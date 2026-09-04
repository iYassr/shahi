/**
 * The address a phone should use, guessed from this box.
 *
 * The box cannot know it for certain, so this is a guess with a stated order:
 * the Tailscale name if there is one (which
 * assumes `tailscale serve` fronts the loopback bind on 443, and the callers
 * probe it before trusting it), the bind address if it is not loopback, and
 * otherwise nothing, so the caller asks rather than prints a wrong one.
 *
 * Pure so that it can be tested against captured `tailscale status --json`
 * output; `tailscaleStatus()` is the one line that runs the binary.
 */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function phoneEndpoint(tailscaleStatusJson: string | null, host: string, port: number): string {
  if (tailscaleStatusJson) {
    try {
      const name = (JSON.parse(tailscaleStatusJson) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(
        /\.$/,
        "",
      );
      if (name) return `https://${name}`;
    } catch {
      // Not JSON — treat as no tailscale rather than fail the caller.
    }
  }
  return isLoopback(host) ? "" : `http://${host}:${port}`;
}

/** `tailscale status --json`, or null when there is no tailscale here. */
export async function tailscaleStatus(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}
