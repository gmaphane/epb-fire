import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    ...devices['Pixel 7'],
    permissions: ['geolocation'],
    geolocation: { latitude: 6.8287, longitude: -0.8093, accuracy: 6 },
    // Uses Playwright's own Chromium (npx playwright install chromium). Set CHROMIUM_PATH to use another browser binary.
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {},
    serviceWorkers: 'allow',
  },
  webServer: { command: 'npm run build:demo && npm run preview', url: 'http://localhost:4173', reuseExistingServer: true, timeout: 60_000 },
});
