import { test, expect } from '@playwright/test';

// A aba Terminal dedica 100% da área útil ao transcrito da sessão de execução
// (sem a caixa de 170px do PTY local) e desduplica eventos exec_start/end + agent_step.

test('aba Terminal mostra os comandos executados em sequência sem caixa PTY local e sem duplicar', async ({ page }) => {
  await page.setViewportSize({ width: 1700, height: 800 });
  const events: Record<string, unknown>[] = [
    { type: 'exec_start', id: 'exec_ssh:1', nodeId: 'exec_ssh', transport: 'ssh', host: '192.168.64.7', command: 'df -h', dryRun: false, ts: Date.now() },
    { type: 'exec_chunk', id: 'exec_ssh:1', stream: 'stdout', text: '/dev/mapper/rhel-root 44G 2,5G 41G 6% /\n', ts: Date.now() },
    { type: 'exec_end', id: 'exec_ssh:1', exitCode: 0, durationMs: 200, ok: true, truncated: false, ts: Date.now() },
    { type: 'agent_step', nodeId: 'agente', step: 1, phase: 'result', tool: 'exec_ssh', transport: 'ssh', host: '192.168.64.7', args: { host: '192.168.64.7', command: 'df -h' }, output: '[EXEC ssh @ 192.168.64.7] df -h (exit=0, 200 ms)\n--- stdout ---\n/dev/mapper/rhel-root 44G 2,5G 41G 6% /\n', exitCode: 0, durationMs: 200, ok: true },
    { type: 'agent_step', nodeId: 'agente', step: 2, phase: 'result', tool: 'exec_ssh', transport: 'ssh', host: '192.168.64.7', args: { host: '192.168.64.7', command: 'hostname' }, output: 'srvapp01.local\n', exitCode: 0, durationMs: 12, ok: true },
    { type: 'agent_step', nodeId: 'agente', step: 3, phase: 'result', tool: 'exec_ssh', transport: 'ssh', host: '192.168.64.7', args: { host: '192.168.64.7', command: 'systemctl status' }, output: '', stderr: 'Permission denied (publickey).\n', exitCode: 255, durationMs: 12, ok: false },
  ];
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: 'event: runner\ndata: ' + JSON.stringify({ type: 'run_started' }) + '\n\n'
      + events.map((s) => `event: runner\ndata: ${JSON.stringify(s)}\n\n`).join('')
      + 'event: ended\ndata: {"code":0}\n\n',
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  const logs = page.locator('.live2 .logs-panel');
  await logs.locator('.logs-panel-view').getByRole('tab', { name: /^Terminal/ }).click();

  const transcript = page.locator('.falador-terminal-transcript');
  await expect(transcript).toBeVisible();
  await expect(page.locator('.falador-xterm-container')).toHaveCount(0);
  await expect(page.locator('.falador-terminal-bar')).toContainText('ssh · 192.168.64.7 · sessão persistente');
  // 3 comandos distintos (df -h não foi duplicado pelo par exec_start + agent_step)
  await expect(transcript.locator('.ftr-exec')).toHaveCount(3);
  await expect(transcript).not.toContainText('[EXEC ssh @');
  await expect(transcript).toContainText('df -h');
  await expect(transcript).toContainText('hostname');
  await expect(transcript).toContainText('srvapp01.local');
  await expect(transcript).toContainText('exit 255');
});
