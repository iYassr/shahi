/** Equal jitter spreads reconnect storms without allowing a zero-delay loop. */
export function retryDelay(ceilingMs: number, random = Math.random): number {
  return Math.round(ceilingMs * (0.5 + Math.max(0, Math.min(1, random())) * 0.5));
}
