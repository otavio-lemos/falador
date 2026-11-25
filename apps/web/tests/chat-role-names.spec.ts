import { test, expect } from '@playwright/test';

// O nome exibido na conversa TEM que ser o nome do COMPONENTE (display name do nó,
// ver nodeDisplayNames/ADR-011), nunca o rótulo genérico por tipo ("Agent",
// "Playback", "Decisão", "Transcription"). Regressão 2026-11-24.
test('o papel da entrada na conversa é o nome do componente, não o rótulo genérico', async ({ page }) => {
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: 'event: runner\ndata: ' + JSON.stringify({ type: 'run_started' }) + '\n\n'
      + 'event: runner\ndata: ' + JSON.stringify({
        type: 'agent_step', nodeId: 'agente', step: 1, phase: 'result',
        tool: 'exec_ssh', args: { host: '192.168.64.7', command: 'uptime' }, ok: true, durationMs: 12,
      }) + '\n\n'
      + 'event: runner\ndata: ' + JSON.stringify({ type: 'chat_sent', nodeId: 'input', text: 'ola' }) + '\n\n'
      + 'event: ended\ndata: {"code":0}\n\n',
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await page.waitForTimeout(500);

  const step = page.locator('.live-chat-entry--agent-step').first();
  await expect(step).toBeVisible();
  // "Agent 1" (nome do componente) e NÃO "Agent" (rótulo genérico).
  await expect(step.locator('.live-chat-entry-role')).toHaveText(/^Agent \d+$/);
  // mensagem do humano continua "Você".
  await expect(page.locator('.live-chat-entry--user').first().locator('.live-chat-entry-role')).toHaveText('Você');
});
