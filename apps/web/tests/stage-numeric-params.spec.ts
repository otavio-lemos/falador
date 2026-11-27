import { test, expect } from '@playwright/test';

// Regressão: o dropdown da barra de etapas devolve o id STRING do Carbon.
// Params numéricos (maxResults/topK/maxPages) têm que chegar ao /api/run como
// número — o validateFlow do motor exige typeof number e rejeita "3".
test('stage dropdown sends numeric params as numbers to /api/run', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'especialista-ti' }).click();
  await page.getByRole('button', { name: 'Runner' }).click();

  let payload: { flow: { nodes: Array<{ id: string; params: Record<string, unknown> }> } } | null = null;
  await page.route('**/api/run', async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: ended\ndata: {"code":0}\n\n',
    });
  });

  // troca WebSearch de 10 → 3 resultados (comportamento que reproduz o bug)
  const webStage = page
    .locator('.stage-dd')
    .filter({ has: page.locator('.stage-dd-label', { hasText: 'WebSearch' }) })
    .first();
  await expect(webStage).toBeVisible();
  await webStage.getByRole('combobox').last().click();
  await page.getByRole('option', { name: '3 resultados' }).click();

  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect.poll(() => payload !== null).toBe(true);

  const paramsOf = (id: string) => payload!.flow.nodes.find((n) => n.id === id)!.params;
  expect(paramsOf('web_search').maxResults).toBe(3); // número, não "3"
  expect(paramsOf('rag_search').topK).toBe(5); // intocado, continua número
  expect(paramsOf('crawler').maxPages).toBe(10); // intocado, continua número
});

test('exec stage "Exec ativo" grava dryRun boolean (não string "ativo")', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'especialista-ti' }).click();
  await page.getByRole('button', { name: 'Runner' }).click();

  let payload: { flow: { nodes: Array<{ id: string; params: Record<string, unknown> }> } } | null = null;
  await page.route('**/api/run', async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: ended\ndata: {"code":0}\n\n',
    });
  });

  // troca Exec/SSH de dry-run → EXEC ATIVO
  const execStage = page
    .locator('.stage-dd')
    .filter({ has: page.locator('.stage-dd-label', { hasText: 'Exec/SSH' }) })
    .first();
  await expect(execStage).toBeVisible();
  await execStage.locator('.stage-main-select').click();
  await page.getByRole('option', { name: 'EXEC ATIVO' }).click();
  await expect(execStage).toContainText('EXEC ATIVO');

  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect.poll(() => payload !== null).toBe(true);

  const params = payload!.flow.nodes.find((n) => n.id === 'exec_ssh')!.params;
  expect(typeof params.dryRun).toBe('boolean'); // era "ativo" (string) → INVALID_PARAM
  expect(params.dryRun).toBe(false);
});

test('modelo exibido no dropdown de Agent é exatamente o enviado ao /api/run (mesmo sem clicar no dropdown)', async ({ page }) => {
  await page.route('**/api/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        omlx: [
          'Inkling-2-Mini-oQ4e-mtp',
          'LiquidAI--LFM3-1.7B-MLX-4bit',
          'LiquidAI--d1-2B-MLX-4bit',
          'gemma-4-26B-A4B-it-QAT-MLX-4bit',
          'granite-4.2-30b-MLX-4bit',
          'granite-4.2-8b-MLX-8bit',
        ],
        cache: [],
        details: [
          { id: 'Inkling-2-Mini-oQ4e-mtp', model_type: 'vlm' },
          { id: 'LiquidAI--LFM3-1.7B-MLX-4bit', model_type: 'vlm' },
          { id: 'LiquidAI--d1-2B-MLX-4bit', model_type: 'decision' },
          { id: 'gemma-4-26B-A4B-it-QAT-MLX-4bit', model_type: 'vlm' },
          { id: 'granite-4.2-30b-MLX-4bit', model_type: 'llm' },
          { id: 'granite-4.2-8b-MLX-8bit', model_type: 'llm' },
        ],
      }),
    });
  });

  let payload: { flow: { nodes: Array<{ id: string; params: Record<string, unknown> }> } } | null = null;
  await page.route('**/api/run', async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: ended\ndata: {"code":0}\n\n',
    });
  });

  await page.goto('/');
  const agentStage = page.locator('.stage-dd').filter({ has: page.locator('.stage-dd-label', { hasText: 'Agent' }) }).first();
  await expect(agentStage).toBeVisible();
  await expect(agentStage.locator('.stage-main-select')).toContainText('Inkling-2-Mini-oQ4e-mtp');

  // Inicia sem clicar no dropdown: deve enviar Inkling-2-Mini-oQ4e-mtp (e nunca Qwen3-Coder-30B-A3B-Instruct-4bit)
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect.poll(() => payload !== null).toBe(true);
  expect(payload!.flow.nodes.find((n) => n.id === 'agente')?.params.model).toBe('Inkling-2-Mini-oQ4e-mtp');
  expect(payload!.flow.nodes.find((n) => n.id === 'decisor_d1')?.params.model).toBe('LiquidAI--d1-2B-MLX-4bit');

  // Troca no dropdown para gemma-4-26B-A4B-it-QAT-MLX-4bit e inicia
  payload = null;
  await agentStage.locator('.stage-main-select').click();
  await page.getByRole('option', { name: 'gemma-4-26B-A4B-it-QAT-MLX-4bit' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect.poll(() => payload !== null).toBe(true);
  expect(payload!.flow.nodes.find((n) => n.id === 'agente')?.params.model).toBe('gemma-4-26B-A4B-it-QAT-MLX-4bit');
});

