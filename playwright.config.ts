import { defineConfig, devices } from '@playwright/test';
import { E2E_PORT } from './e2e/config.js';

// Browser tests of the main flows (docs/05 section 5). The web server builds the UI and starts the
// real app on its own schema of the test database; the specs share it, so they run one at a time.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 60_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    // Forms take times in the browser's zone; the plant is in India (LB-19).
    timezoneId: 'Asia/Kolkata',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite build && npx tsx e2e/server.ts',
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
