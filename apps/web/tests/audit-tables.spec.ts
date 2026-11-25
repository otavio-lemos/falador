import { test, expect } from '@playwright/test';

// Regressão: a aba Auditoria usava TableHeader/TableHead invertidos (Carbon:
// TableHead = <thead>, TableHeader = <th>), o que embaralhava o cabeçalho das
// tabelas. E o filtro de busca existia só em 3 das 8 sub-abas, com uma
// TableToolbar de 48px quase vazia por aba.
const sse = (events: Record<string, unknown>[]) =>
  events.map((ev) => `event: runner\ndata: ${JSON.stringify(ev)}\n\n`).join('')
  + 'event: ended\ndata: {"code":0}\n\n';

const AUDIT_EVENTS: Record<string, unknown>[] = [
  { type: 'run_started' },
  { type: 'audit', runId: 'r1', seq: 1, ts: 1700000000000, op: 'run_started', nodeId: 'run' },
  { type: 'audit', runId: 'r1', seq: 2, ts: 1700000001000, op: 'chat_input', nodeId: 'input', text: 'verificar disco' },
  { type: 'audit', runId: 'r1', seq: 3, ts: 1700000002000, op: 'tool_call', nodeId: 'agent', tool: 'exec_local', args: { command: 'df -h' }, risk: 'seguro', durationMs: 12, ok: true },
  { type: 'audit', runId: 'r1', seq: 4, ts: 1700000003000, op: 'exec', nodeId: 'exec', tool: 'exec_command', host: 'localhost', transport: 'local', args: { command: 'df -h' }, exitCode: 0, durationMs: 11, outputPreview: 'Filesystem 12%' },
  { type: 'audit', runId: 'r1', seq: 5, ts: 1700000004000, op: 'gate', nodeId: 'gate1', tool: 'exec_command', gate: 'approved', text: 'df -h', risk: 'sensivel' },
  { type: 'audit', runId: 'r1', seq: 6, ts: 1700000005000, op: 'goal_validation', nodeId: 'validator', step: 2, durationMs: 55, validation: { achieved: false, confidence: 0.31, gaps: ['sem evidencia'], nextActions: ['rodar df'] } },
  { type: 'audit', runId: 'r1', seq: 7, ts: 1700000006000, op: 'plan', nodeId: 'agent', plan: [{ id: 'p1', description: 'coletar uso de disco', verification: 'df saida', status: 'verified', evidence: 'df -h' }] },
  { type: 'audit', runId: 'r1', seq: 8, ts: 1700000007000, op: 'tool_call', nodeId: 'rag', tool: 'rag_search', rag: { query: 'procedimento disco', hits: 3, chunkIds: ['c1', 'c2'] }, durationMs: 1 },
];

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.route('**/api/run', (route) => route.fulfill({
    status: 200,
    contentType: 'text/event-stream',
    body: sse(AUDIT_EVENTS),
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  const logs = page.locator('.live2 .logs-panel');
  await logs.locator('.logs-panel-view').getByRole('tab', { name: /Auditoria/ }).click();
});

test('cabeçalho da tabela é thead > tr > th (sem thead dentro de th)', async ({ page }) => {
  const audit = page.locator('.audit-panel');
  await expect(audit.getByRole('tab', { name: 'Todos (8)' })).toHaveAttribute('aria-selected', 'true');

  // O bug produzia <th><div><tr><thead>…</thead></tr></div></th>. Nada de thead dentro de th:
  await expect(page.locator('.audit-panel th thead')).toHaveCount(0);
  // E o cabeçalho tem que existir como linha de th no thead da aba VISÍVEL
  // (o Carbon mantém os 8 TabPanels no DOM; os inativos ficam ocultos).
  const table = page.locator('.audit-panel table:visible');
  await expect(table).toHaveCount(1);
  await expect(table.locator('> thead > tr > th')).toHaveCount(6);

  const heads = await table.locator('> thead > tr > th').allInnerTexts();
  expect(heads.map((h) => h.trim())).toEqual(['Hora', 'Evento', 'Nó', 'Resumo / Detalhes', 'Status', 'Duração']);
});

test('aba Decisões renderiza cabeçalho correto', async ({ page }) => {
  const audit = page.locator('.audit-panel');
  await audit.getByRole('tab', { name: 'Decisões (2)' }).click();
  await expect(page.locator('.audit-panel th thead')).toHaveCount(0);
  const table = page.locator('.audit-panel table:visible');
  const heads = await table.locator('> thead > tr > th').allInnerTexts();
  expect(heads.map((h) => h.trim())).toEqual(['Step', 'Tool', 'Args', 'Risco d1', 'Gate', 'OK', 'Duração', 'Hora']);
});

test('busca única fica visível em todas as abas e filtra', async ({ page }) => {
  const audit = page.locator('.audit-panel');
  const search = page.locator('#audit-filter-decisions');

  for (const name of ['Gates (1)', 'RAG (1)', 'Plano (1)', 'Validação (1)', 'Latência', 'Execuções (2)']) {
    await audit.getByRole('tab', { name }).click();
    await expect(search).toBeVisible();
  }

  await audit.getByRole('tab', { name: 'Todos (8)' }).click();
  await expect(audit.getByText('Execução iniciada')).toBeVisible();
  await search.fill('exec_local');
  await expect(audit.getByText('Execução iniciada')).toHaveCount(0);
  await expect(audit.getByText('exec_local', { exact: false }).first()).toBeVisible();
});

test('faixa de sub-abas (.audit-bar) não oscila de largura entre re-renders periódicos', async ({ page }) => {
  const measure = () =>
    page.evaluate(() => {
      const list = document.querySelector('.audit-bar .cds--tab--list') as HTMLElement | null;
      const items = [...document.querySelectorAll('.audit-bar .cds--tabs__nav-item')] as HTMLElement[];
      const last = items.at(-1)?.getBoundingClientRect();
      return {
        clientW: list?.clientWidth ?? 0,
        scrollW: list?.scrollWidth ?? 0,
        lastRight: last ? Math.round(last.x + last.width) : 0,
      };
    });

  const s0 = await measure();
  expect(s0.scrollW).toBeLessThanOrEqual(s0.clientW);
  await page.waitForTimeout(3400); // atravessa poll de status (3s) e logs (1.5s)
  const s1 = await measure();
  expect(s1.scrollW).toBeLessThanOrEqual(s1.clientW);
  expect(s1.clientW).toBe(s0.clientW);
  expect(s1.lastRight).toBe(s0.lastRight);
});
