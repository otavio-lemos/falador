import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('builder loads a real workflow and canvas', async ({ page }) => {
  // top bar Carbon: alternância Builder/Workflow + seletor de workflow real
  await expect(page.getByRole('tablist', { name: 'Modo da interface' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Testar' })).toBeVisible();
  // a aba Workflow é o "live": só habilita com flow carregado
  await expect(page.getByRole('button', { name: 'Workflow' })).toBeEnabled();
  // o flow default é carregado do /api/flows com nome real e contagem de nós
  await expect(page.getByRole('heading', { name: 'assistente-entrevista' })).toBeVisible();
  await expect(page.getByText(/10 nós[\s·]*10 conexões/)).toBeVisible();
  // nós reais do canvas (rótulo visível é o id curto do nó)
  await expect(page.getByText('capture.ffmpeg').first()).toBeVisible();
  await expect(page.getByText('asr.realtime').first()).toBeVisible();
});

test('model manager groups models and searches', async ({ page }) => {
  await page.getByRole('button', { name: 'Modelos' }).click();
  await expect(page.getByText('Modelos instalados')).toBeVisible();
  await page.getByPlaceholder('Buscar modelo…').fill('d1');
  await expect(page.getByText('Decisão (System-1)')).toBeVisible();
});

test('node editor exposes capture app reload and language controls', async ({ page }) => {
  await page.locator('.react-flow__node').filter({ hasText: 'capture.ffmpeg' }).click();
  await expect(page.getByRole('dialog', { name: 'Propriedades de capture.ffmpeg' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recarregar apps com áudio ativo' })).toBeVisible();
  await page.getByRole('button', { name: 'Fechar editor' }).click();

  await page.locator('.react-flow__node').filter({ hasText: 'asr.realtime' }).click();
  await expect(page.getByRole('dialog', { name: 'Propriedades de asr.realtime' })).toBeVisible();
  await expect(page.getByText('Nenhum modelo encontrado', { exact: false })).not.toBeVisible();
});

test('new workflow action is exposed in the flow menu', async ({ page }) => {
  // "Novo" persiste o flow em apps/tui/flows: intercepta o POST para o teste
  // não criar arquivos de verdade no repo.
  await page.route('**/api/flows', async (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
    return route.continue();
  });
  await page.getByRole('button', { name: 'Novo' }).click();
  const modal = page.getByRole('dialog', { name: 'Editar detalhes do workflow' });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Salvar alterações' })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Cancelar' })).toBeVisible();
  await modal.getByRole('button', { name: 'Cancelar' }).click();
});

test('chat derives STT, agent, TTS and playback; thoughts toggle uses collapsed accordions', async ({ page }) => {
  await page.route('**/api/flows/agente-suporte-ops', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.flow.nodes.push(
      { id: 'asr', type: 'asr.realtime', params: {} },
      { id: 'voz', type: 'tts.sts', params: {} },
      { id: 'alto', type: 'sink.playback', params: {} },
    );
    payload.flow.edges.push(
      { from: 'asr.out', to: 'agente.parcs' },
      { from: 'agente.out', to: 'voz.in' },
      { from: 'voz.out', to: 'alto.in' },
    );
    await route.fulfill({ response, json: payload });
  });

  const events = [
    { type: 'run_started' },
    { type: 'chat_sent', nodeId: 'chat', text: 'opa blz?' },
    { type: 'caption', nodeId: 'asr', kind: 'stt', text: 'fala transcrita ao vivo', final: true },
    { type: 'thought', nodeId: 'agente', thoughtId: 'agente:1:1', text: 'Analisar a intenção antes de responder.', final: true },
    { type: 'agent_step', nodeId: 'agente', step: 1, phase: 'result', tool: 'search_docs', args: { query: 'pedido' }, ok: true, durationMs: 6 },
    { type: 'caption', nodeId: 'resposta', text: 'Opa, tudo bem? Como posso ajudar?', final: true },
    { type: 'node_error', nodeId: 'voz', code: 'log_info', message: 'fala: "Opa, tudo bem?" (42 KB)' },
    { type: 'node_error', nodeId: 'alto', code: 'log_info', message: 'playback ok (1,2s)' },
    { type: 'gate', nodeId: 'agente', text: 'Sugestão que precisa de revisão humana.' },
  ];
  const body = events.map((ev) => `event: runner\ndata: ${JSON.stringify(ev)}\n\n`).join('')
    + 'event: ended\ndata: {"code":0}\n\n';
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body,
  }));

  await page.getByRole('button', { name: 'Workflow' }).click();
  await page.getByRole('combobox', { name: 'Workflow' }).click();
  await page.getByRole('option', { name: 'agente-suporte-ops' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();

  await expect(page.locator('.live-chat-entry--user')).toContainText('opa blz?');
  await expect(page.locator('.live-chat-entry--stt')).toContainText('fala transcrita ao vivo');
  await expect(page.locator('.live-chat-entry--stt')).toContainText('Transcrição');
  await expect(page.locator('.live-chat-entry--agent')).toContainText('Opa, tudo bem? Como posso ajudar?');
  await expect(page.locator('.live-chat-entry--agent')).toContainText('Agente');
  await expect(page.locator('[data-node-id="voz"]')).toContainText('Síntese de voz');
  await expect(page.locator('[data-node-id="alto"]')).toContainText('Reprodução de áudio');
  await expect(page.locator('.live-chat-thought')).toHaveCount(0);
  await expect(page.getByText('Orquestrador', { exact: true })).toHaveCount(0);

  const userBox = await page.locator('.live-chat-entry--user').boundingBox();
  const agentBox = await page.locator('.live-chat-entry--agent').boundingBox();
  expect(userBox?.x).toBe(agentBox?.x);

  await expect(page.getByRole('region', { name: 'Sugestão de resposta pendente' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aprovar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Regerar', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rejeitar', exact: true })).toBeVisible();

  const thoughtsToggle = page.getByRole('button', { name: 'Pensamentos', exact: true });
  await thoughtsToggle.click();
  await expect(thoughtsToggle).toHaveAttribute('aria-pressed', 'true');
  const thought = page.locator('.live-chat-thought').first();
  await expect(thought).toBeVisible();
  await expect(page.getByText('Analisar a intenção antes de responder.')).not.toBeVisible();
  await thought.getByRole('button').click();
  await expect(page.getByText('Analisar a intenção antes de responder.')).toBeVisible();
  await thought.getByRole('button').click();
  await expect(page.getByText('Analisar a intenção antes de responder.')).not.toBeVisible();
  await thoughtsToggle.click();
  await expect(page.locator('.live-chat-thought')).toHaveCount(0);

  const badges = await page.locator('.logs-service-badges').boundingBox();
  const title = await page.locator('.logs-panel-title').boundingBox();
  const clear = await page.getByRole('button', { name: 'Limpar logs' }).boundingBox();
  const collapseButtons = page.getByRole('button', { name: 'Recolher logs' });
  expect(await collapseButtons.count()).toBe(2);
  const collapseLeft = await collapseButtons.first().boundingBox();
  const collapseRight = await collapseButtons.last().boundingBox();
  const thoughts = await thoughtsToggle.boundingBox();
  expect(collapseLeft!.x + collapseLeft!.width).toBeLessThanOrEqual(title!.x);
  expect(badges!.x).toBeGreaterThan(title!.x);
  expect(badges!.x).toBeGreaterThan(clear!.x + clear!.width);
  expect(badges!.x).toBeGreaterThan(thoughts!.x + thoughts!.width);
  expect(collapseRight!.x).toBeGreaterThanOrEqual(badges!.x + badges!.width);
  expect(await page.locator('.logs-panel-count').count()).toBe(0);
  const head = await page.locator('.logs-panel-head').boundingBox();
  expect(head!.height).toBeLessThanOrEqual(42);
});

test('capture stage offers Aplicações/Microfone and persists the mic source', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('falador.captureSource', 'apps'));
  await page.reload();

  await page.getByRole('button', { name: 'Workflow' }).click();
  const captura = page.locator('.stage-dd').filter({ hasText: 'Captura' }).first();
  await expect(captura).toBeVisible();
  await expect(captura.getByRole('combobox').first()).toContainText('Aplicações');

  await captura.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'Microfone' }).click();

  await expect.poll(() => page.evaluate(() => localStorage.getItem('falador.captureSource'))).toBe('mic');
  await expect(captura.getByRole('combobox').nth(1)).toContainText('Microfone (MacBook Pro)');
});
