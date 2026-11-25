import { test, expect } from '@playwright/test';

// Regressão 2026-11-24: `.live-chat-log` é uma coluna flex com overflow-y:auto.
// `overflow:hidden` num item de flex zera o piso de altura mínima, e o item passa
// a ENCOLHER no eixo principal → as linhas "diminuem" em vez de o container rolar.
// Guardado por `flex-shrink: 0` em `.live-chat-entry`/`.live-chat-thought`.
test('várias linhas na conversa mantêm a altura e o log rola (não encolhe)', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 700 });
  const events: Record<string, unknown>[] = [{ type: 'run_started' }];
  for (let i = 1; i <= 25; i++) {
    events.push({
      type: 'agent_step', nodeId: 'agente', step: i, phase: 'result',
      tool: 'exec_ssh', args: { host: '192.168.64.7', command: `cmd ${i}` }, ok: true, durationMs: 10 + i,
    });
  }
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: events.map((e) => `event: runner\ndata: ${JSON.stringify(e)}\n\n`).join('') + 'event: ended\ndata: {"code":0}\n\n',
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await page.waitForTimeout(600);

  const entries = page.locator('.live-chat-entry--agent-step');
  expect(await entries.count()).toBeGreaterThan(10);
  const heights = await entries.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  expect(Math.min(...heights)).toBeGreaterThan(24); // nenhuma linha encolhida

  const log = page.locator('.live-chat-log');
  const sc = await log.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(sc.scroll).toBeGreaterThan(sc.client); // o container rola
});
