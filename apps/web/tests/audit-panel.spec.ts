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

test('Expandir painel aumenta altura do LogsPanel e Restaurar altura retorna ao tamanho menor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'Runner' }).click();

  const logs = page.locator('.live2 .logs-panel');
  await expect(logs).toBeVisible();
  const initialBox = await logs.boundingBox();
  expect(initialBox).not.toBeNull();
  const initialHeight = initialBox!.height;

  await logs.getByRole('button', { name: 'Expandir painel' }).click();
  const expandedBox = await logs.boundingBox();
  expect(expandedBox).not.toBeNull();
  expect(expandedBox!.height).toBeGreaterThan(450);

  await logs.getByRole('button', { name: 'Restaurar altura' }).click();
  const restoredBox = await logs.boundingBox();
  expect(restoredBox).not.toBeNull();
  expect(restoredBox!.height).toBeLessThan(450);
  expect(Math.abs(restoredBox!.height - initialHeight)).toBeLessThan(20);
});
