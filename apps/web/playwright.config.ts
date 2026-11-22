import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 20_000,
  retries: 0,
  workers: 1, // sequencial — evita contenção com o servidor único em :8787
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8787',
    headless: true,
    viewport: { width: 1440, height: 900 },
    // não tirar screenshot em cada passo — só em falha
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Sobe o host oficial sozinho (serve apps/web/dist). Se já houver um em :8787
  // (./faladorctl start), reaproveita; em CI sempre sobe um limpo.
  webServer: {
    command: 'node ../web-server.mjs',
    url: 'http://127.0.0.1:8787/api/catalog',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
