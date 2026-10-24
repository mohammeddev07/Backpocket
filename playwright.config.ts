import { defineConfig, devices } from '@playwright/test';

// End-to-end checks for the Daily Queue (npm run test:e2e). Uses the
// installed Chrome, so there's no browser download; each test seeds its own
// IndexedDB, so it never touches anyone's real saves.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173/Backpocket/',
    channel: 'chrome',
    colorScheme: 'dark',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], channel: 'chrome' } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173/Backpocket/',
    reuseExistingServer: true,
  },
});
