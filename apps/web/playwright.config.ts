import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.FALADOR_WEB_PORT ?? 8787);

export default defineConfig({
  testDir: './tests',
  timeout: 20_000,
  retries: 0,
  workers: 1, // sequencial — evita contenção com o servidor único em :8787
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 1440, height: 900 },
    // não tirar screenshot em cada passo — só em falha
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // Sobe o host oficial sozinho (serve apps/web/dist). Se já houver um em :8787
  // (./faladorctl start), reaproveita; em CI ou porta customizada sobe um limpo.
  webServer: {
    command: 'node ../web-server.mjs',
    url: `http://127.0.0.1:${PORT}/api/catalog`,
    env: { ...process.env, FALADOR_WEB_PORT: String(PORT) },
    // FALADOR_WEB_REUSE=1 permite testar contra um host já subido em porta isolada
    // (útil quando :8787 é o host de produção do dono, com dist antigo).
    reuseExistingServer: !process.env.CI && (!process.env.FALADOR_WEB_PORT || process.env.FALADOR_WEB_REUSE === '1'),
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
