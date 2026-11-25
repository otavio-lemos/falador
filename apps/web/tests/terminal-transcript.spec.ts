import { test, expect } from '@playwright/test';

// A aba Terminal recebe os `executions` mas mostrava só o shell PTY (ignorava os
// comandos). Agora renderiza um TRANSCRITO sequencial: comando + saída + exit
// (regressão 2026-11-24).

test('aba Terminal mostra os comandos executados em sequência', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 800 });
  const steps: Record<string, unknown>[] = [
    { type: 'agent_step', nodeId: 'agente', step: 3, phase: 'result', tool: 'exec_ssh', transport: 'ssh', host: '192.168.64.7', args: { host: '192.168.64.7', command: 'hostname' }, output: 'srvapp01.local\n', exitCode: 0, durationMs: 387, ok: true },
    { type: 'agent_step', nodeId: 'agente', step: 4, phase: 'result', tool: 'exec_ssh', transport: 'ssh', host: '192.168.64.7', args: { host: '192.168.64.7', command: 'cat /etc/os-release' }, output: 'NAME="Red Hat Enterprise Linux"\nVERSION="10.2"\n', exitCode: 0, durationMs: 185, ok: true },
    { type: 'agent_step', nodeId: 'agente', step: 5, phase: 'result', tool: 'exec_ssh', transport: 'ssh', host: '192.168.64.7', args: { host: '192.168.64.7', command: 'systemctl status' }, output: '', stderr: 'Permission denied (publickey).\n', exitCode: 255, durationMs: 12, ok: false },
  ];
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: 'event: runner\ndata: ' + JSON.stringify({ type: 'run_started' }) + '\n\n'
      + steps.map((s) => `event: runner\ndata: ${JSON.stringify(s)}\n\n`).join('')
      + 'event: ended\ndata: {"code":0}\n\n',
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await page.waitForTimeout(600);
  const logs = page.locator('.live2 .logs-panel');
  await logs.locator('.logs-panel-view').getByRole('tab', { name: /^Terminal/ }).click();
  await page.waitForTimeout(400);
  const transcript = page.locator('.falador-terminal-transcript');
  await expect(transcript).toBeVisible();
  await expect(transcript).toContainText('hostname');
  await expect(transcript).toContainText('srvapp01.local');
  await expect(transcript).toContainText('exit 255');
});
