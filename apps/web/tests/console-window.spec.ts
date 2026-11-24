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
  const box = await card.boundingBox();
  const btn = await actions.boundingBox();
  expect(btn!.x).toBeGreaterThan(box!.x + box!.width / 2);

  await card.getByRole('textbox').fill('use outro host');
  await actions.getByRole('button', { name: 'Rejeitar' }).click();
  expect(sent.nodeId).toBe('aprovacao');
  expect(sent.text).toBeNull();
  expect(sent.rejectionText).toBe('use outro host');
});
