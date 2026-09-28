import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', fullyParallel: false, workers: 1, retries: 0, timeout: 15000,
  outputDir: '../../test-results/dashboard', reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:7999', serviceWorkers: 'block', trace: 'retain-on-failure' },
  webServer: { command: 'bun e2e/dashboard/server.ts', cwd: '../..', url: 'http://127.0.0.1:7999', reuseExistingServer: false, timeout: 20000 },
  projects: [{ name: 'dashboard-chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'dashboard-webkit', use: { ...devices['iPhone 13'] } }],
});
