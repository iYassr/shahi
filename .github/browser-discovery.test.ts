import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

interface Suite { suites?: Suite[]; specs?: { file: string; tests: { projectName: string }[] }[] }
function discovered(config: string, projects: string[] = []) {
  const result = Bun.spawnSync(['bun', 'node_modules/@playwright/test/cli.js', 'test', '--config', config, '--list', '--reporter=json', ...projects.map(p => `--project=${p}`)], {
    cwd: resolve(import.meta.dir, '..'), env: { ...process.env, CI: '1' }, stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString() || result.stdout.toString());
  const data = JSON.parse(result.stdout.toString()) as { suites: Suite[]; errors?: unknown[] };
  expect(data.errors ?? []).toHaveLength(0);
  const specs: { file: string; tests: { projectName: string }[] }[] = [];
  function visit(suite: Suite) { specs.push(...suite.specs ?? []); suite.suites?.forEach(visit); }
  data.suites.forEach(visit);
  return specs;
}

test('app and dashboard scenarios are discovered only by their own fixture suites', () => {
  const app = discovered('e2e/playwright.config.ts', ['phone', 'ios']);
  expect(app.length).toBeGreaterThan(150);
  expect(app.some(s => /(?:^|[\\/])(?:dashboard|hosted|live)[\\/]/.test(s.file))).toBe(false);
  const dashboard = discovered('e2e/dashboard/playwright.config.ts');
  expect(dashboard.length).toBeGreaterThanOrEqual(5);
  expect(dashboard.every(s => s.file.endsWith('dashboard.spec.ts'))).toBe(true);
  expect([...new Set(dashboard.flatMap(s => s.tests.map(t => t.projectName)))].sort()).toEqual(['dashboard-chromium', 'dashboard-webkit']);
}, 15000);
