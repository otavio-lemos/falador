// UX da conversa do Runner: status por turno, ponte gate→Console via BroadcastChannel,
// prompts iniciais e ligação conversa→Auditoria.
import { test, expect } from '@playwright/test';

const sse = (events: Record<string, unknown>[]) =>
  events.map((ev) => `event: runner\ndata: ${JSON.stringify(ev)}\n\n`).join('')
  + 'event: ended\ndata: {"code":0}\n\n';

async function startRun(page: import('@playwright/test').Page, events: Record<string, unknown>[]) {
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200, contentType: 'text/event-stream', body: sse(events),
  }));
  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('pill mostra Aguardando aprovação com gate pendente e linha de feedback', async ({ page }) => {
  await startRun(page, [{ type: 'run_started' }, {
    type: 'gate', nodeId: 'gate_humano', text: 'Aprovar comando?',
    meta: { tool: 'exec_ssh', host: 'srv-01', command: 'uptime' },
  }]);
  const status = page.getByTestId('turn-status');
  await expect(status).toHaveText('Aguardando aprovação');
  await expect(page.getByText('Revise e aprove ou rejeite a ação abaixo.')).toBeVisible();
});

test('gate_active é publicado no BroadcastChannel inclusive quando o gate é limpo', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __gates: unknown[] }).__gates = [];
    const bc = new BroadcastChannel('falador-console');
    bc.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'gate_active') (window as unknown as { __gates: unknown[] }).__gates.push(e.data);
    };
  });
  const gatePayloads: Record<string, unknown>[] = [];
  await page.route('**/api/gate', (route) => {
    gatePayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await startRun(page, [{ type: 'run_started' }, {
    type: 'gate', nodeId: 'gate_humano', text: 'uptime',
    meta: { tool: 'exec_ssh', host: 'srv-01', command: 'uptime' },
  }]);

  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __gates: { gate?: { nodeId?: string } }[] }).__gates
      .filter((m) => m.gate?.nodeId === 'gate_humano').length)).toBe(1);
  const active = await page.evaluate(() =>
    (window as unknown as { __gates: { gate?: { meta?: { host?: string } } }[] }).__gates
      .find((m) => m.gate?.nodeId === 'gate_humano'));
  expect(active?.gate?.meta?.host).toBe('srv-01');

  await page.locator('.live-chat-entry--gate').getByRole('button', { name: 'Aprovar e Executar' }).click();
  // payload composto preserva o host (já quebrou uma vez quando veio só o comando)
  expect(JSON.parse(String(gatePayloads[0]?.text)).host).toBe('srv-01');
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __gates: { gate: unknown }[] }).__gates.at(-1)?.gate)).toBeNull();
});

test('prompts de operação preenchem o input e somem quando há mensagens', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('falador.inputMode', 'chat'));
  await page.reload();
  // App abre no Runner; prompts aparecem quando não está rodando
  const prompts = [
    'O que está rodando agora?',
    'Mostre o último erro do run',
    'Resuma a auditoria desta sessão',
  ];
  // Aguarda a área de chat estar visível (inputMode=chat => chat input visível)
  await page.locator('#live-chat-input').waitFor({ state: 'visible' });
  for (const p of prompts) await expect(page.getByRole('button', { name: p })).toBeVisible();
  await page.getByRole('button', { name: prompts[0] }).click();
  await expect(page.locator('#live-chat-input')).toHaveValue(prompts[0]);

  await startRun(page, [{ type: 'run_started' }, { type: 'chat_sent', nodeId: 'entrada', text: 'olá' }]);
  await expect(page.locator('.live-chat-entry--user')).toContainText('olá');
  for (const p of prompts) await expect(page.getByRole('button', { name: p })).toHaveCount(0);
});

test('clique (e teclado) num passo abre Auditoria com filtro do nodeId', async ({ page }) => {
  await startRun(page, [
    { type: 'run_started' },
    { type: 'agent_step', nodeId: 'agente', step: 1, phase: 'result', tool: 'exec_local', ok: true },
    { type: 'audit', runId: 'r1', seq: 1, ts: 1700000000000, op: 'tool_call', nodeId: 'agente', tool: 'exec_local' },
  ]);
  const step = page.locator('.live-chat-entry--agent-step');
  await expect(step).toHaveAttribute('role', 'button');
  await step.focus();
  await page.keyboard.press('Enter');

  const logs = page.locator('.live2 .logs-panel');
  await expect(logs.locator('.logs-panel-view').getByRole('tab', { name: /^Auditoria/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#audit-filter-decisions')).toHaveValue('agente');
});

test('ask_user com fields estruturados mostra Aguardando resposta e envia via botão Enviar', async ({ page }) => {
  const gatePayloads: Record<string, unknown>[] = [];
  await page.route('**/api/gate', (route) => {
    gatePayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await startRun(page, [{ type: 'run_started' }, {
    type: 'gate',
    nodeId: 'gate_ask_user',
    text: 'Informe o host',
    meta: { tool: 'ask_user', args: { fields: [{ name: 'host', label: 'IP ou Hostname', type: 'text' }] } },
  }]);

  const status = page.getByTestId('turn-status');
  await expect(status).toHaveText('Aguardando resposta');
  await expect(status).not.toHaveText('Aguardando aprovação');
  await expect(page.getByText('Responda à pergunta do agente abaixo para continuar.')).toBeVisible();

  await page.locator('#field-host').fill('192.168.64.7');
  await page.locator('.live-chat-entry--gate').getByRole('button', { name: 'Enviar' }).click();

  await expect.poll(() => gatePayloads.length).toBe(1);
  expect(JSON.parse(String(gatePayloads[0]?.text)).host).toBe('192.168.64.7');
});

test('ask_user com fields estruturados envia POST /api/gate ao pressionar Enter no campo', async ({ page }) => {
  const gatePayloads: Record<string, unknown>[] = [];
  await page.route('**/api/gate', (route) => {
    gatePayloads.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await startRun(page, [{ type: 'run_started' }, {
    type: 'gate',
    nodeId: 'gate_ask_user',
    text: 'Informe o host',
    meta: { tool: 'ask_user', args: { fields: [{ name: 'host', label: 'IP ou Hostname', type: 'text' }] } },
  }]);

  await page.locator('#field-host').fill('192.168.64.7');
  await page.locator('#field-host').press('Enter');

  await expect.poll(() => gatePayloads.length).toBe(1);
  expect(JSON.parse(String(gatePayloads[0]?.text)).host).toBe('192.168.64.7');
});
