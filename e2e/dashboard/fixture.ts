export function fixture(range = '1h') {
  const now = new Date().toISOString();
  const seconds = range === '7d' ? 604800 : range === '24h' ? 86400 : 3600;
  const bucketSeconds = range === '7d' ? 21600 : range === '24h' ? 3600 : 300;
  const checks = Object.fromEntries(['website', 'browser_app', 'signup_api', 'relay_http', 'relay_tunnel', 'analytics', 'signup_delivery_errors', 'relay_errors', 'connection_rejections', 'authentication_failures', 'reconnect_storm', 'service_latency'].map(k => [k, { healthy: true, durationMs: 40 }]));
  return {
    errors: [], generatedAt: now,
    monitor: { checkedAt: now, checks, incidents: {}, deliveryFailures: 0 },
    stats: { range, seconds, bucketSeconds, generatedAt: now, boxesOnlineEstimate: 142,
      eventsByKind: [{ kind: 'connect', n: 934 }, { kind: 'phone_open', n: 642 }, { kind: 'internal_error', n: 0 }],
      traffic: { upBytes: 54100000, downBytes: 4320000000, upFrames: 1260, downFrames: 49000 },
      boxHandshake: { meanMs: 234, maxMs: 845 }, connectsByColo: [{ colo: 'RUH', n: 315 }, { colo: 'FRA', n: 284 }],
      refusalsByReason: [{ reason: 'box offline', n: 2 }], phoneCloseCodes: [{ code: 1000, n: 98 }], signupWindow: [{ status: 200, n: 12, meanMs: 284 }],
      timeline: Array.from({ length: 12 }, (_, i) => ({ at: new Date(Math.floor(Date.now() / (bucketSeconds * 1000)) * bucketSeconds * 1000 - (11 - i) * bucketSeconds * 1000).toISOString(), kind: 'connect', n: [24, 39, 29, 60, 85, 42, 95, 126, 83, 142, 78, 131][i] })) },
  };
}
