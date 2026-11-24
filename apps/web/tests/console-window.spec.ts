// Console em janela única (2026-11-24): rota própria, SSE anexado ao run,
// sem iniciar run e sem depender da aba da conversa.
import { test, expect } from '@playwright/test';

test('console abre como página própria e anexa ao run em andamento', async ({ page, request }) => {
  const before = await request.get('/api/events');
  expect(before.status()).toBe(409);

  await page.goto('/console');
  await expect(page.getByRole('heading', { name: 'Console do Agente' })).toBeVisible();
  await expect(page.getByText('Sem run em andamento')).toBeVisible();
  await expect(page.getByText('Inicie um fluxo na aba principal.')).toBeVisible();
});

test('gate tem Aprovar/Editar/Rejeitar à direita e a recusa envia o texto escrito', async ({ page }) => {
  const gate = {
    type: 'gate', nodeId: 'aprovacao', text: 'Executar uptime?',
    meta: { command: 'uptime', host: 'srv-01' }, ts: Date.now(),
  };
  await page.route('**/api/events', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: `event: runner\ndata: ${JSON.stringify(gate)}\n\n`,
  }));
  let sent: Record<string, unknown> = {};
  await page.route('**/api/gate', async (route) => {
    sent = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto('/console');
  await expect(page.getByRole('button', { name: 'PARAR' })).toBeVisible();
  const card = page.getByRole('region', { name: 'Aprovação pendente aprovacao' });
  const actions = card.locator('.console-actions');
  await expect(actions.getByRole('button')).toHaveText(['Aprovar e executar', 'Editar', 'Rejeitar']);
  const inputBox = await card.getByRole('textbox').boundingBox();
  const actionsBox = await actions.boundingBox();
  // Botões na MESMA linha do comando, imediatamente depois do campo.
  expect(Math.abs((actionsBox?.y ?? 0) - (inputBox?.y ?? 0))).toBeLessThan(8);
  expect((actionsBox?.x ?? 0)).toBeGreaterThan((inputBox?.x ?? 0) + (inputBox?.width ?? 0) - 4);

  await card.getByRole('textbox').fill('use outro host');
  await actions.getByRole('button', { name: 'Rejeitar' }).click();
  expect(sent.nodeId).toBe('aprovacao');
  expect(sent.text).toBeNull();
  expect(sent.rejectionText).toBe('use outro host');
});

test('aprovação no console preserva o host do gate no payload', async ({ page }) => {
  const gate = {
    type: 'gate', nodeId: 'exec_ssh', text: 'Comando fora da allowlist. Aprovar?',
    meta: { command: 'uptime', host: '192.168.64.7', reason: 'Aprovação válida apenas para esta execução' },
    ts: Date.now(),
  };
  await page.route('**/api/events', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: `event: runner\ndata: ${JSON.stringify(gate)}\n\n`,
  }));
  let sent: Record<string, unknown> = {};
  await page.route('**/api/gate', async (route) => {
    sent = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto('/console');
  const card = page.getByRole('region', { name: 'Aprovação pendente exec_ssh' });
  await expect(card).toContainText('Host: 192.168.64.7');
  await card.getByRole('textbox').fill('uname -a');
  await card.getByRole('button', { name: 'Aprovar e executar' }).click();
  expect(sent.nodeId).toBe('exec_ssh');
  expect(JSON.parse(String(sent.text))).toEqual({
    command: 'uname -a', host: '192.168.64.7', reason: 'Aprovação válida apenas para esta execução',
  });
});
