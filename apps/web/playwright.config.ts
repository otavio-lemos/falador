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
  // webServer não gerencia o servidor — ele já deve estar rodando (faladorctl / web-server.mjs)
});
