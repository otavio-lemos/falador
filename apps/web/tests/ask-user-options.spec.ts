// ask_user: o card de gate já aceita OPÇÕES do agente (options) — assim não é
// preciso digitar: é possível selecionar. Verificação de regressão.
import { test, expect } from '@playwright/test';

test('ask_user card renders selectable options and answers via POST /api/gate', async ({ page }) => {
  await page.goto('/');
  const question = 'O host 192.168.64.7 é acessível diretamente ou precisa de bastion para acesso?';
  const body = [
    `event: runner\ndata: ${JSON.stringify({ type: 'run_started' })}\n\n`,
    `event: runner\ndata: ${JSON.stringify({
      type: 'gate',
      nodeId: 'agente',
      text: question,
      meta: { tool: 'ask_user', kind: 'respond', args: { question, options: ['Acesso Direto', 'Bastion'] }, step: 1 },
    })}\n\n`,
    `event: ended\ndata: ${JSON.stringify({ code: 0 })}\n\n`,
  ].join('');
  await page.route('**/api/run', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body }),
  );
  const gatePayloads: Array<Record<string, unknown>> = [];
  await page.route('**/api/gate', (route) => {
    gatePayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();

  const card = page.locator('.live-chat-entry.live-chat-entry--gate');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Acesso Direto' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Bastion' })).toBeVisible();

  await card.getByRole('button', { name: 'Bastion' }).click();
  await expect.poll(() => gatePayloads.length).toBe(1);
  expect(gatePayloads[0]?.text).toBe('Bastion');
});
