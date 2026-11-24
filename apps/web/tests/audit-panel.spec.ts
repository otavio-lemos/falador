import { test, expect } from '@playwright/test';

const sse = (events: Record<string, unknown>[]) =>
  events.map((ev) => `event: runner\ndata: ${JSON.stringify(ev)}\n\n`).join('')
  + 'event: ended\ndata: {"code":0}\n\n';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('aba Todos (default) mostra eventos run_started e chat_input na Auditoria', async ({ page }) => {
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: sse([
      { type: 'run_started' },
      { type: 'audit', runId: 'r1', seq: 1, ts: 1700000000000, op: 'run_started', nodeId: 'run' },
      { type: 'audit', runId: 'r1', seq: 2, ts: 1700000001000, op: 'chat_input', nodeId: 'input', text: 'verificar disco' },
    ]),
  }));

  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();

  const logs = page.locator('.live2 .logs-panel');
  const auditTab = logs.locator('.logs-panel-view').getByRole('tab', { name: 'Auditoria (2)' });
  await expect(auditTab).toBeVisible();
  await auditTab.click();

  const auditPanel = logs.locator('.audit-panel');
  await expect(auditPanel.getByRole('tab', { name: 'Todos (2)' })).toHaveAttribute('aria-selected', 'true');
  await expect(auditPanel.getByText('Execução iniciada')).toBeVisible();
  await expect(auditPanel.getByText('verificar disco')).toBeVisible();
  await expect(auditPanel.getByText('Nenhuma decisão registrada.')).not.toBeVisible();
});

// (teste do botão "Expandir painel" removido em 2026-11-24: a seta de expandir foi
// removida por pedido do dono — o painel continua redimensionável pelo resizer.)
