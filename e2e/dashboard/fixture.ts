export function fixture(range = '1h') {
  const now = new Date().toISOString();
  const seconds = range === '7d' ? 604800 : range === '24h' ? 86400 : 3600;
  const bucketSeconds = range === '7d' ? 21600 : range === '24h' ? 3600 : 300;
  const checks = Object.fromEntries(['website', 'browser_app', 'signup_api', 'relay_http', 'relay_tunnel', 'analytics', 'signup_delivery_errors', 'relay_errors', 'connection_rejections', 'authentication_failures', 'reconnect_storm', 'service_latency'].map(k => [k, { healthy: true, durationMs: 40 }]));
  return {
    errors: [], generatedAt: now,
    usage: { since: new Date(Date.now() - 7 * 86400000).toISOString(), until: now, generatedAt: now,
      shahi: { workerRequests: 12300, workerCpuMs: 5400, durableRequests: 33200, durableDurationGbSeconds: 4400, rowsRead: 200, rowsWritten: 300 },
      account: { workerRequests: 22300, workerCpuMs: 9400, durableRequests: 83200, durableDurationGbSeconds: 9400, rowsRead: 400, rowsWritten: 800 },
      model: { totalUsd: 17.5, costs: { subscription: 5, workerRequests: 0, workerCpu: 0, durableRequests: 0, durableDuration: 12.5, rowsRead: 0, rowsWritten: 0 } },
      workers: [{ name: 'shahi-relay', requests: 12300, cpuMs: 5400, errors: 0 }] },
    monitor: { checkedAt: now, checks, incidents: {}, deliveryFailures: 0 },
    stats: { range, seconds, bucketSeconds, generatedAt: now, boxesOnlineEstimate: 142,
      eventsByKind: [{ kind: 'connect', n: 934 }, { kind: 'phone_open', n: 642 }, { kind: 'internal_error', n: 0 }],
      traffic: { upBytes: 54100000, downBytes: 4320000000, upFrames: 1260, downFrames: 49000 },
      boxHandshake: { n: 200, meanMs: 234, maxMs: 845, p50Ms: 210, p95Ms: 510, p99Ms: 710 }, connectsByColo: [{ colo: 'RUH', n: 315 }, { colo: 'FRA', n: 284 }],
      capacity: [{ at: now, computers: 110, phones: 43, busiestComputer: 6 }],
      outcomes: [{ kind: 'box_auth', reason: '', n: 200 }, { kind: 'auth_failed', reason: 'unauthorized', n: 5 }, { kind: 'phone_open', reason: '', n: 642 }, { kind: 'refused', reason: 'box offline', n: 2 }],
      durations: [{ kind: 'phone_close', n: 98, p50Ms: 600000, p95Ms: 3600000 }],
      refusalsByReason: [{ reason: 'box offline', n: 2 }], phoneCloseCodes: [{ code: 1000, n: 98 }], signupWindow: [{ status: 200, n: 12, meanMs: 284 }],
      timeline: Array.from({ length: 12 }, (_, i) => ({ at: new Date(Math.floor(Date.now() / (bucketSeconds * 1000)) * bucketSeconds * 1000 - (11 - i) * bucketSeconds * 1000).toISOString(), kind: 'connect', n: [24, 39, 29, 60, 85, 42, 95, 126, 83, 142, 78, 131][i] })) },
  };
}
