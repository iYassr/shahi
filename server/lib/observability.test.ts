import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Observability, rotatingLog, routeLabel } from "./observability";

test("private request content cannot become a log field or unbounded metric label", () => {
  const rows: object[] = [];
  const metrics = new Observability((r) => rows.push(r));
  for (let i = 0; i < 1000; i++) {
    metrics.request(new Request(`http://localhost/api/panes/private-${i}/prompt?secret=private-content`), "relay", 500, 1200);
    metrics.event("relay.link_closed", { reason: "private-content", headers: "private-content", body: "private-content" });
  }
  expect(JSON.stringify(rows)).not.toContain("private-");
  expect(metrics.requests.size).toBe(1);
  expect(rows.length).toBeLessThanOrEqual(240);
  expect(metrics.droppedLogs).toBeGreaterThan(0);
  expect(routeLabel("/api/file")).toBe("file");
  expect(routeLabel("/api/panes/secret/arbitrary")).toBe("panes/:id/other");
  expect([...metrics.requests.values()][0]!.errors).toBe(1000);
});

test("local alerts fire on transitions and recover without repeating every tick", () => {
  const rows: object[] = [];
  const m = new Observability((r) => rows.push(r));
  m.tick(false, 0, 1); m.tick(false, 0, 180002); m.tick(false, 0, 240002);
  expect(m.alerts.has("relay_offline")).toBe(true);
  expect(rows.filter((r: any) => r.event === "alert.firing")).toHaveLength(1);
  m.tick(true);
  expect(m.alerts.has("relay_offline")).toBe(false);
  expect(rows.filter((r: any) => r.event === "alert.recovered")).toHaveLength(1);
});

test("rotated logs have a fixed disk budget and private file permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "shahi-logs-"));
  try {
    const path = join(dir, "operations.jsonl");
    const write = rotatingLog(path, 100);
    for (let i = 0; i < 40; i++) write({ event: "runtime.summary", count: i });
    expect(readdirSync(dir)).toHaveLength(4);
    for (const file of readdirSync(dir)) {
      expect(statSync(join(dir, file)).size).toBeLessThanOrEqual(100);
      expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
      for (const line of readFileSync(join(dir, file), "utf8").trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    }
  } finally { rmSync(dir, { recursive: true }); }
});
