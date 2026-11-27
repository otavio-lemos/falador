import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('builder loads a real workflow and canvas', async ({ page }) => {
  // o app abre no Runner; o Builder é a tela de criação
  await page.getByRole('button', { name: 'Builder' }).click();
  // top bar Carbon: alternância Builder/Workflow + seletor de workflow real
  await expect(page.getByRole('tablist', { name: 'Modo da interface' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Workflow', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Testar' })).toBeVisible();
  // a aba Runner é o "live": só habilita com flow carregado
  await expect(page.getByRole('button', { name: 'Runner' })).toBeEnabled();
  // o flow default é carregado do /api/flows com nome real e contagem de nós
  await expect(page.getByRole('heading', { name: 'especialista-ti' })).toBeVisible();
  await expect(page.getByText(/14 nós[\s·]*14 conexões/)).toBeVisible();
  // paleta unificada Input com capture.ffmpeg único (sem input.chat)
  const inputCat = page.locator('.pal-cat').filter({ has: page.locator('.pal-cat-head', { hasText: 'Input' }) }).first();
  await expect(inputCat).toBeVisible();
  await expect(inputCat.locator('.pal-item-id', { hasText: 'capture.ffmpeg' })).toBeVisible();
  await expect(page.locator('.palette .pal-item-id', { hasText: 'input.chat' })).toHaveCount(0);
  // paleta unificada Output com sink.captions único (sem sink.playback / tts.sts)
  const outputCat = page.locator('.pal-cat').filter({ has: page.locator('.pal-cat-head', { hasText: 'Output' }) }).first();
  await expect(outputCat).toBeVisible();
  await expect(outputCat.locator('.pal-item-id', { hasText: 'sink.captions' })).toBeVisible();
  await expect(page.locator('.palette .pal-item-id', { hasText: 'sink.playback' })).toHaveCount(0);
  await expect(page.locator('.palette .pal-item-id', { hasText: 'tts.sts' })).toHaveCount(0);
  await expect(page.locator('.fnode-title-main', { hasText: /^Input 1$/ })).toBeVisible();
  await expect(page.locator('.fnode-title-main', { hasText: /^Transcription 1$/ })).toBeVisible();
  await expect(page.locator('.fnode-title-main', { hasText: /^Output 2$/ })).toBeVisible();
  // nós reais do canvas (rótulo visível é o id curto do nó)
  await expect(page.getByText('capture.ffmpeg').first()).toBeVisible();
  await expect(page.getByText('asr.realtime').first()).toBeVisible();
});

test('model manager groups models and searches', async ({ page }) => {
  await page.getByRole('button', { name: 'Builder' }).click();
  await page.getByRole('button', { name: 'Modelos' }).click();
  await expect(page.getByText('Modelos instalados')).toBeVisible();
  await page.getByPlaceholder('Buscar modelo…').fill('d1');
  await expect(page.getByText('Decisão (System-1)')).toBeVisible();
});

test('node editor exposes capture app reload and language controls', async ({ page }) => {
  await page.getByRole('button', { name: 'Builder' }).click();
  await page.locator('.react-flow__node').filter({ hasText: 'capture.ffmpeg' }).click();
  await expect(page.getByRole('dialog', { name: 'Propriedades de capture.ffmpeg' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recarregar apps com áudio ativo' })).toBeVisible();
  await page.getByRole('button', { name: 'Fechar editor' }).click();

  await page.locator('.react-flow__node').filter({ hasText: 'asr.realtime' }).click();
  await expect(page.getByRole('dialog', { name: 'Propriedades de asr.realtime' })).toBeVisible();
  await expect(page.getByText('Nenhum modelo encontrado', { exact: false })).not.toBeVisible();
});

test('new workflow action is exposed in the flow menu', async ({ page }) => {
  await page.getByRole('button', { name: 'Builder' }).click();
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
  // Use existing chat-only flow 'agente-workflows' and inject ASR + TTS + playback nodes for the test
  await page.route('**/api/flows/agente-workflows', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    if (!payload.flow.nodes.some((n: any) => n.id === 'asr')) {
      payload.flow.nodes.push({ id: 'asr', type: 'asr.realtime', params: {} });
      payload.flow.edges.push({ from: 'asr.out', to: 'agente.parcs' });
    }
    payload.flow.nodes.push(
      { id: 'voz', type: 'tts.sts', params: {} },
      { id: 'alto', type: 'sink.playback', params: {} },
    );
    payload.flow.edges.push(
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
    { type: 'node_error', nodeId: 'agente', code: 'EXEC_ERROR', message: 'Falha simulada na ferramenta' },
    { type: 'gate', nodeId: 'agente', text: 'Sugestão que precisa de revisão humana.' },
  ];
  const body = events.map((ev) => `event: runner\ndata: ${JSON.stringify(ev)}\n\n`).join('')
    + 'event: ended\ndata: {"code":0}\n\n';
  const gatePayloads: unknown[] = [];
  await page.route('**/api/gate', async (route) => {
    gatePayloads.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body,
  }));

  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'agente-workflows' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();

  await expect(page.locator('.live-chat-entry--user')).toContainText('opa blz?');
  await expect(page.locator('.live-chat-entry--stt')).toContainText('fala transcrita ao vivo');
  await expect(page.locator('.live-chat-entry--stt')).toContainText('Input 1');
  await expect(page.locator('.live-chat-entry--stt')).toContainText('ASR');
  await expect(page.locator('.live-chat-entry--agent')).toContainText('Opa, tudo bem? Como posso ajudar?');
  await expect(page.locator('.live-chat-entry--agent')).toContainText('Agent');
  await expect(page.locator('.live-chat-entry--agent-step')).toContainText('Passo 1');
  await expect(page.locator('.live-chat-entry--agent-step')).toContainText('search_docs');
  await expect(page.locator('.live2 .live2-error')).toHaveCount(0);
  await expect(page.locator('.live-chat-entry--error')).toContainText('Erro');
  await expect(page.locator('.live-chat-entry--error')).toContainText('Falha simulada na ferramenta');
  await expect(page.locator('[data-node-id="voz"]')).toContainText('TTS');
  await expect(page.locator('[data-node-id="voz"]')).toContainText('fala: "Opa, tudo bem?" (42 KB)');
  await expect(page.locator('[data-node-id="alto"]')).toContainText('Playback');
  await expect(page.locator('[data-node-id="alto"]')).toContainText('playback ok (1,2s)');
  await expect(page.locator('.live-chat-entry--thought')).toHaveCount(0);
  await expect(page.getByText('Orquestrador', { exact: true })).toHaveCount(0);

  const userBox = await page.locator('.live-chat-entry--user').boundingBox();
  const agentBox = await page.locator('.live-chat-entry--agent').boundingBox();
  expect(userBox?.x).toBe(agentBox?.x);

  const gateEntry = page.locator('.live-chat-entry.live-chat-entry--gate');
  await expect(gateEntry).toBeVisible();
  await expect(gateEntry.getByRole('button', { name: 'Aprovar & Falar', exact: true })).toBeVisible();
  await expect(gateEntry.getByRole('button', { name: 'Editar', exact: true })).toBeVisible();
  await expect(gateEntry.getByRole('button', { name: 'Regerar', exact: true })).toBeVisible();
  await expect(gateEntry.getByRole('button', { name: 'Rejeitar', exact: true })).toBeVisible();

  const thoughtsToggle = page.getByRole('button', { name: 'Pensamentos', exact: true });
  await thoughtsToggle.click();
  await expect(thoughtsToggle).toHaveAttribute('aria-pressed', 'true');
  const thought = page.locator('.live-chat-entry--thought').first();
  await expect(thought).toBeVisible();
  await expect(thought.getByText('Analisar a intenção antes de responder.')).toBeVisible();
  await thoughtsToggle.click();
  await expect(page.locator('.live-chat-entry--thought')).toHaveCount(0);

  await gateEntry.getByRole('button', { name: 'Aprovar & Falar', exact: true }).click();
  await expect.poll(() => gatePayloads.length).toBe(1);
  expect(gatePayloads[0]).toEqual({ nodeId: 'agente', text: 'Sugestão que precisa de revisão humana.' });
  await expect(gateEntry).toHaveCount(0);

  const logsPanel = page.locator('.live2 .logs-panel');
  const viewTabs = logsPanel.locator('.logs-panel-view');
  await expect(viewTabs.getByRole('tab', { name: 'Logs' })).toBeVisible();
  await expect(viewTabs.getByRole('tab', { name: /^Auditoria/ })).toBeVisible();
  await logsPanel.locator('.logs-panel-services button').first().click();
  await expect(logsPanel.locator('.logs-panel-services').getByText('Auditoria')).toHaveCount(0);
  await page.keyboard.press('Escape');

  const title = await viewTabs.boundingBox();
  const clear = await logsPanel.getByRole('button', { name: 'Limpar logs' }).boundingBox();
  const collapseButtons = logsPanel.getByRole('button', { name: 'Recolher logs' });
  expect(await collapseButtons.count()).toBe(2);
  const collapseLeft = await collapseButtons.first().boundingBox();
  const collapseRight = await collapseButtons.last().boundingBox();
  const thoughts = await thoughtsToggle.boundingBox();
  expect(collapseLeft!.x + collapseLeft!.width).toBeLessThanOrEqual(title!.x);
  expect(thoughts!.x).toBeGreaterThan(clear!.x + clear!.width);
  expect(collapseRight!.x).toBeGreaterThan(thoughts!.x + thoughts!.width);
  expect(await logsPanel.locator('.logs-panel-count').count()).toBe(0);

  // Status tag OK / NOK presente no cabeçalho do bloco de serviço
  const statusTags = logsPanel.locator('.logs-status-tag');
  await expect(statusTags.first()).toBeVisible();
  await expect(statusTags.first()).toHaveText(/^(OK|NOK)$/);

  const head = await logsPanel.locator('.logs-panel-head').boundingBox();
  expect(head!.height).toBeLessThanOrEqual(42);
});

test('unified Input and Output stages use instance selectors and sync with topbar', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('falador.inputMode', 'apps');
    localStorage.setItem('falador.outputMode', 'write');
  });
  await page.reload();

  await page.getByRole('button', { name: 'Runner' }).click();
  // mini-mapa mostra o mesmo nome do componente no workflow (especialista-ti tem Output 1 e Output 2)
  await expect(page.locator('.wf-minimap text', { hasText: /^Output 2$/ })).toBeVisible();

  const inputStage = page.locator('.stage-dd').filter({ has: page.locator('.stage-dd-label', { hasText: 'Input' }) }).first();
  await expect(inputStage).toBeVisible();
  await expect(page.locator('.stage-dd').filter({ hasText: 'Captura' })).toHaveCount(0);

  const inputInstCombo = inputStage.getByRole('combobox').nth(0);
  const inputModeCombo = inputStage.getByRole('combobox').nth(1);
  await expect(inputStage.getByRole('combobox')).toHaveCount(2);
  await expect(inputInstCombo).toContainText('1');
  await expect(inputModeCombo).toContainText('Aplicações');
  await expect(page.getByRole('button', { name: 'Recarregar apps de áudio' })).toHaveCount(0);

  await inputModeCombo.click();
  await expect(inputStage.getByRole('option')).toHaveText(['Aplicações', 'Microfone', 'Chat']);

  await page.getByRole('option', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.wf-minimap .wf-mm-node')).toHaveCount(14);
  const useVoiceBtn = page.getByRole('button', { name: 'Usar voz' });
  await expect(useVoiceBtn).toBeVisible();
  await expect(useVoiceBtn).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('falador.inputMode'))).toBe('chat');

  await inputModeCombo.click();
  await page.getByRole('option', { name: 'Microfone', exact: true }).click();
  const useChatBtn = page.getByRole('button', { name: 'Usar chat' });
  await expect(useChatBtn).toBeVisible();
  await expect(useChatBtn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('falador.inputMode'))).toBe('mic');

  await useChatBtn.click();
  await expect(inputModeCombo).toContainText('Chat');
  await expect(page.getByRole('button', { name: 'Usar voz' })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('falador.inputMode'))).toBe('chat');

  await page.getByRole('button', { name: 'Usar voz' }).click();
  await expect(inputModeCombo).toContainText('Microfone');
  await expect(page.getByRole('button', { name: 'Usar chat' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('falador.inputMode'))).toBe('mic');

  // Output unificado com instâncias (entrevista tem 3 Outputs; padrão é Output 2)
  const outputStage = page.locator('.stage-dd').filter({ has: page.locator('.stage-dd-label', { hasText: 'Output' }) }).first();
  await expect(outputStage).toBeVisible();
  await expect(outputStage.getByRole('combobox')).toHaveCount(2);
  const outInstCombo = outputStage.getByRole('combobox').nth(0);
  const outModeCombo = outputStage.getByRole('combobox').nth(1);
  await expect(outInstCombo).toContainText('2');
  await expect(outModeCombo).toContainText('Escrever');

  // Alterar Output 1 não altera Output 2 (padrão)
  await outInstCombo.click();
  await expect(outputStage.getByRole('option')).toHaveText(['1', '2']);
  await outputStage.getByRole('option', { name: '1', exact: true }).click();
  await outModeCombo.click();
  await outputStage.getByRole('option', { name: 'Falar', exact: true }).click();
  await expect(outModeCombo).toContainText('Falar');

  // Botão UserSpeaker na topbar volta o seletor de instância para o padrão (Output 2) e alterna para Falar
  const speakBtn = page.getByRole('button', { name: 'Falar' });
  await expect(speakBtn).toHaveAttribute('aria-pressed', 'false');
  await speakBtn.click();
  await expect(outInstCombo).toContainText('2');
  await expect(outModeCombo).toContainText('Falar');
  const writeBtn = page.getByRole('button', { name: 'Só escrever' });
  await expect(writeBtn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('falador.outputMode'))).toBe('speak');

  await writeBtn.click();
  await expect(outModeCombo).toContainText('Escrever');
  await expect(page.getByRole('button', { name: 'Falar' })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('falador.outputMode'))).toBe('write');
});

test('console modal, plan progress indicator, goal validation, gate history and audit validation tab', async ({ page }) => {
  // Verifica no Builder que agent.tools não exibe tag falsa DRY-RUN / EXEC ATIVO
  await page.getByRole('button', { name: 'Builder' }).click();
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'especialista-ti' }).click();
  const agentNode = page.locator('.react-flow__node').filter({ hasText: 'agent.tools' });
  await expect(agentNode).toBeVisible();
  await expect(agentNode.getByText('DRY-RUN')).toHaveCount(0);
  await expect(agentNode.getByText('EXEC ATIVO')).toHaveCount(0);

  const events = [
    { type: 'run_started' },
    {
      type: 'audit',
      runId: 'run-test-1',
      seq: 1,
      ts: 1700000001000,
      op: 'plan',
      nodeId: 'agente',
      plan: [
        { id: 'p1', description: 'Checar uptime', verification: 'exec uptime', status: 'verified', evidence: 'up 10 days' },
        { id: 'p2', description: 'Subir nginx', verification: 'systemctl is-active nginx', status: 'pending' },
        { id: 'p3', description: 'Validar porta 80', verification: 'curl -I localhost', status: 'failed' },
      ],
    },
    {
      type: 'agent_step',
      nodeId: 'agente',
      step: 1,
      phase: 'result',
      tool: 'exec_ssh',
      args: { command: 'uptime' },
      host: 'srv-01',
      transport: 'ssh',
      output: 'up 10 days',
      exitCode: 0,
      ok: true,
      durationMs: 12,
    },
    {
      type: 'audit',
      runId: 'run-test-1',
      seq: 2,
      ts: 1700000002000,
      op: 'goal_validation',
      nodeId: 'agente',
      step: 1,
      goal: 'Garantir nginx ativo',
      validation: {
        achieved: false,
        confidence: 0.45,
        gaps: ['Serviço nginx ainda parado'],
        nextActions: ['Executar systemctl start nginx'],
      },
    },
    {
      type: 'audit',
      runId: 'run-test-1',
      seq: 3,
      ts: 1700000003000,
      op: 'agent_final',
      nodeId: 'agente',
      step: 2,
      maxStepsReached: true,
      goalAchieved: false,
      text: 'Limite de passos atingido.',
    },
    {
      type: 'gate',
      nodeId: 'agente',
      text: 'systemctl start nginx',
      meta: { tool: 'exec_ssh', host: 'srv-01', command: 'systemctl start nginx', decision: 'sensivel' },
    },
  ];
  const body = events.map((ev) => `event: runner\ndata: ${JSON.stringify(ev)}\n\n`).join('')
    + 'event: ended\ndata: {"code":0}\n\n';

  await page.context().route('**/api/gate', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  );
  await page.route('**/api/run', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body }),
  );
  const gateFrame = 'event: runner\ndata: ' + JSON.stringify(events[events.length - 1]) + '\n\n'
    + 'event: attached\ndata: {}\n\n';
  await page.context().route('**/api/events', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: gateFrame }),
  );

  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();

  // ContainedList do plano com dropdown recolhível e resumo em linha única
  const planPanel = page.locator('.live-plan-panel');
  await expect(planPanel).toBeVisible();
  await expect(planPanel.locator('[role="list"]')).toBeVisible();
  await expect(planPanel).toContainText('Checar uptime');
  await expect(planPanel).toContainText('exec uptime');
  const planToggle = planPanel.locator('.live-plan-header');
  await planToggle.click();
  await expect(planToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(planPanel.locator('[role="list"]')).toHaveCount(0);
  await expect(planPanel.locator('.live-plan-current-text')).toBeVisible();
  await planToggle.click();
  await expect(planToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(planPanel.locator('[role="list"]')).toBeVisible();
  // Botão do card agent-step abre o painel Terminal embutido (não popup)
  const stepCard = page.locator('.live-chat-entry--agent-step').first();
  await expect(stepCard).toBeVisible();
  // O primeiro step pode ser rag.search ou exec_ssh dependendo da ordem
  await expect(stepCard).toContainText(/rag\.search|exec_ssh/);
  await expect(stepCard.getByRole('button', { name: 'Abrir no Console' })).toBeVisible();
  await stepCard.getByRole('button', { name: 'Abrir no Console' }).click();
  // Verifica que o painel Terminal foi aberto (aba Terminal ativa)
  await expect(page.locator('.live2 .logs-panel').locator('.logs-panel-view').getByRole('tab', { name: /^Terminal/ })).toHaveAttribute('aria-selected', 'true');

  // Abre a janela popup /console diretamente (não há botão Console no LogsPanel)
  const consolePage = await page.context().newPage();
  await consolePage.goto('/console');
  await expect(consolePage).toHaveURL(/\/console$/);
  await expect(consolePage.getByRole('heading', { name: 'Console do Agente' })).toBeVisible();
  const gateCard = consolePage.getByRole('region', { name: 'Aprovação pendente agente' });
  await expect(gateCard).toContainText('systemctl start nginx');

  // Aprovação feita no console espelha o histórico na conversa (BroadcastChannel).
  await gateCard.getByRole('button', { name: 'Aprovar e executar' }).click();
  await expect(gateCard).toHaveCount(0);

  // Cards Validação de Objetivo na Conversa
  const validationCards = page.locator('.live-chat-entry--goal-validation');
  await expect(validationCards).toHaveCount(2);
  await expect(validationCards.first()).toContainText('Pendente');
  await expect(validationCards.first()).toContainText('45%');
  await expect(validationCards.first()).toContainText('Serviço nginx ainda parado');
  // nextActions não são exibidos no card (apenas gaps)
  await expect(validationCards.last()).toContainText('Limite de passos atingido');

  // Aba Validação no AuditPanel
  const logsPanel = page.locator('.live2 .logs-panel');
  await logsPanel.locator('.logs-panel-view').getByRole('tab', { name: /^Auditoria/ }).click();
  const auditPanel = logsPanel.locator('.audit-panel');
  await auditPanel.getByRole('tab', { name: /^Validação/ }).click();
  await expect(auditPanel).toContainText('Serviço nginx ainda parado');
  await expect(auditPanel).toContainText('Limite de passos atingido.');

  // Histórico de Gate na Conversa após aprovação
  const gateEntry = page.locator('.live-chat-entry.live-chat-entry--gate');
  await expect(gateEntry).toBeVisible();
  await gateEntry.getByRole('button', { name: 'Aprovar e Executar' }).click();
  await expect(gateEntry).toHaveCount(0);
  const gateHistoryEntry = page.locator('.live-chat-entry--gate-history').first();
  await expect(gateHistoryEntry).toBeVisible();
  await expect(gateHistoryEntry).toContainText('Aprovado');
  await expect(gateHistoryEntry).toContainText('systemctl start nginx');
});

test('console anexado ao run mostra stream, bastion, filtros e cancelamento', async ({ page }) => {
  const ev = (type: string, extra: Record<string, unknown> = {}) =>
    `event: runner\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
  const id = 'exec1:1700000000000:1';
  const body = ev('exec_start', {
    id, nodeId: 'exec1', host: 'app-01', bastion: 'jump1.corp,jump2.corp',
    command: 'tail -n 20 /var/log/app.log', dryRun: false, transport: 'ssh', ts: 1700000000000,
  }) + ev('exec_chunk', { id, stream: 'stdout', text: 'linha stdout ok\n', ts: 1700000000100 })
    + ev('exec_chunk', { id, stream: 'stderr', text: 'aviso stderr\n', ts: 1700000000200 })
    + ev('exec_end', { id, exitCode: 0, durationMs: 120, ok: true, ts: 1700000000300 })
    + ev('exec_start', {
      id: 'exec1:1700000000400:2', nodeId: 'exec1', host: 'app-02', command: 'uptime',
      dryRun: false, transport: 'ssh', ts: 1700000000400,
    });
  await page.route('**/api/events', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body }));
  let stopCalled = false;
  await page.route('**/api/stop', async (route) => {
    stopCalled = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto('/console');
  const card = page.locator('.console-card').filter({ hasText: 'tail -n 20 /var/log/app.log' });
  await expect(card).toContainText('EXEC ATIVO');
  await expect(card).toContainText('Bastion: jump1.corp,jump2.corp');
  const output = card.locator('.console-output');
  await expect(output).toContainText('linha stdout ok');
  await expect(output).toContainText('aviso stderr');

  await page.locator('.console-filters').getByRole('button', { name: 'stdout' }).click();
  await expect(output).toContainText('linha stdout ok');
  await expect(output).not.toContainText('aviso stderr');
  await page.locator('.console-filters').getByRole('button', { name: 'stderr' }).click();
  await expect(output).toContainText('aviso stderr');
  await expect(output).not.toContainText('linha stdout ok');
  await page.locator('.console-filters').getByRole('button', { name: 'all' }).click();
  await expect(output).toContainText('linha stdout ok');
  await expect(output).toContainText('aviso stderr');

  // exec_end fechou a 1ª exec; a 2ª ainda está rodando e pode ser cancelada da janela.
  await expect(card).toContainText('saída 0');
  const running = page.locator('.console-card').filter({ hasText: 'uptime' });
  await expect(running).toContainText('executando');
  await page.getByRole('button', { name: 'PARAR' }).click();
  await expect.poll(() => stopCalled).toBe(true);
});

test('especialista-ti runner bar, 2-lane minimap with 14 nodes, ask_user gate and Carbon/a11y updates', async ({ page }) => {
  // 1. Carrega especialista-ti no Builder (canvas visível)
  await page.getByRole('button', { name: 'Builder' }).click();
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'especialista-ti' }).click();

  const canvas = page.locator('.react-flow');
  await expect(canvas).toBeVisible();

  // 2. Vai para Runner
  await page.getByRole('button', { name: 'Runner' }).click();

  // Verifica conformidade WCAG 2.2 AA na barra de navegação de modo em LiveView
  const navTabs = page.locator('.live2 .nav-mode-tabs');
  await expect(navTabs).toHaveAttribute('role', 'group');
  await expect(navTabs).toHaveAttribute('aria-label', 'Modo da interface');

  // 2. MiniMap com 14 nós em layout de 2 raias
  const minimapNodes = page.locator('.wf-minimap .wf-mm-node');
  await expect(minimapNodes).toHaveCount(14);

  // Valida nós da Raia 1 vs Raia 2 (Raia 2 tem Y maior que Raia 1)
  const agentMiniNode = minimapNodes.filter({ hasText: /Agent/ }).first();
  const execMiniNode = minimapNodes.filter({ hasText: /Command/ }).first();
  await expect(agentMiniNode).toBeVisible();
  await expect(execMiniNode).toBeVisible();
  const agentBox = await agentMiniNode.boundingBox();
  const execBox = await execMiniNode.boundingBox();
  expect(execBox!.y).toBeGreaterThan(agentBox!.y);

  // 3. Barra de Etapas do Runner completa
  const stageLabels = page.locator('.live2-stages .stage-dd-label');
  await expect(stageLabels.filter({ hasText: 'Input' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'Agent' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'Decision' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'Approval' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'Validator' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'Exec/SSH' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'RAG' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'WebSearch' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'Crawler' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'MCP' }).first()).toBeVisible();
  await expect(stageLabels.filter({ hasText: 'Output' }).first()).toBeVisible();

  // Exec/SSH possui dropdown com Transport (Local / SSH) e modo (DRY-RUN / EXEC ATIVO)
  const execStage = page.locator('.stage-dd').filter({ has: page.locator('.stage-dd-label', { hasText: 'Exec/SSH' }) }).first();
  await expect(execStage).toBeVisible();
  await expect(execStage.getByRole('combobox')).toHaveCount(3); // instancia, modo, transport

  // 4. TabPanel com conteúdo real em LogsPanel (3 abas: Logs, Auditoria, Terminal)
  const tabPanels = page.locator('.live2 .logs-panel [role="tabpanel"]');
  await expect(tabPanels).toHaveCount(3);
  await expect(tabPanels.first()).not.toBeEmpty();
  await expect(tabPanels.nth(1)).not.toBeEmpty();
  await expect(tabPanels.nth(2)).not.toBeEmpty();

  // 5. Simulação de execução com pergunta guiada (ask_user), busca estruturada com Accordion e AILabel
  const events = [
    { type: 'run_started' },
    {
      type: 'agent_step',
      nodeId: 'agente',
      step: 1,
      phase: 'result',
      tool: 'rag.search',
      args: { query: 'instrucoes deploy', topK: 3 },
      ok: true,
      durationMs: 45,
    },
    {
      type: 'caption',
      nodeId: 'final_output',
      text: 'Preciso confirmar se podemos prosseguir.',
      final: true,
    },
    {
      type: 'gate',
      nodeId: 'agente',
      text: '{"tool":"ask_user","prompt":"Qual o ambiente de destino (staging ou prod)?"}',
      meta: { tool: 'ask_user' },
    },
    {
      type: 'audit',
      runId: 'run-ti-1',
      seq: 1,
      ts: 1700000005000,
      op: 'goal_validation',
      nodeId: 'validador_objetivo',
      validation: {
        achieved: true,
        confidence: 0.95,
        gaps: [],
        nextActions: [],
      },
    },
  ];

  const body = events.map((ev) => `event: runner\ndata: ${JSON.stringify(ev)}\n\n`).join('');
  let answeredText = '';
  await page.route('**/api/gate', async (route) => {
    const postData = route.request().postDataJSON() as { text?: string };
    answeredText = postData?.text ?? '';
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body,
  }));

  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();

  // Card do agent-step (sem accordion - estrutura simplificada)
  const stepCard = page.locator('.live-chat-entry--agent-step');
  await expect(stepCard).toBeVisible();
  await expect(stepCard).toContainText('rag.search');
  await expect(stepCard.getByRole('button', { name: 'Abrir no Console' })).toBeVisible();

  // AILabel nos cards de Agent e Validação de Objetivo
  const agentCard = page.locator('.live-chat-entry--agent');
  await expect(agentCard).toBeVisible();
  await expect(agentCard.locator('.cds--ai-label')).toBeVisible();

  const valCard = page.locator('.live-chat-entry--goal-validation');
  await expect(valCard).toBeVisible();
  await expect(valCard.locator('.cds--ai-label')).toBeVisible();

  // Card de Pergunta Guiada (ask_user)
  const askGateCard = page.locator('.live-chat-entry--gate');
  await expect(askGateCard).toBeVisible();
  await expect(askGateCard).toContainText('Pergunta do Agente');
  await expect(askGateCard).toContainText('Qual o ambiente de destino (staging ou prod)?');

  const answerInput = askGateCard.locator('#ask-user-gate-input');
  await expect(answerInput).toBeVisible();
  await answerInput.fill('staging');
  await askGateCard.getByRole('button', { name: 'Responder' }).click();

  await expect.poll(() => answeredText).toBe('staging');
  await expect(askGateCard).toHaveCount(0);
});
