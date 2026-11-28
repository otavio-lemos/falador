import { test, expect } from '@playwright/test';

const MOCK_MODELS = {
  omlx: ['LFM3-Omni-2B-MLX-8bit', 'LiquidAI--LFM3-1.7B-MLX-4bit', 'd1-2B-MLX-4bit'],
  cache: [
    'LiquidAI--LFM3-Audio-2B-MLX-8bit',
    'mlx-community--Voxtral-Mini-4B-Realtime-2602-4bit',
    'silero-vad',
  ],
  details: [
    { id: 'LiquidAI--LFM3-1.7B-MLX-4bit', model_type: 'llm' },
    { id: 'd1-2B-MLX-4bit', model_type: 'decision' },
  ],
};

test('Mutar esta janela fica habilitado e funcional mesmo em workflow sem Output (tradutor-omni)', async ({ page }) => {
  const muteCalls: boolean[] = [];
  let runMutedPayload: boolean | undefined;

  await page.route('**/api/audio-mute', async (route) => {
    const data = route.request().postDataJSON() as { muted?: boolean };
    muteCalls.push(Boolean(data?.muted));
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/run', async (route) => {
    const data = route.request().postDataJSON() as { muted?: boolean };
    runMutedPayload = data?.muted;
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: runner\ndata: {"type":"run_started"}\n\nevent: ended\ndata: {"code":0}\n\n',
    });
  });

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'tradutor-omni', exact: true }).click();

  // Confirma que tradutor-omni tem Transcription em MLX-AUDIO:8090 e Output em NODE.JS:8787 (write default)
  await expect(page.locator('.stage-dd').filter({ hasText: 'Transcription' }).locator('.stage-dd-solution')).toHaveText('MLX-AUDIO:8090');
  await expect(page.locator('.stage-dd').filter({ has: page.locator('.stage-dd-label', { hasText: 'Output' }) }).locator('.stage-dd-solution')).toHaveText('NODE.JS:8787');

  const muteBtn = page.getByRole('button', { name: 'Mutar esta janela' });
  await expect(muteBtn).toBeVisible();
  await expect(muteBtn).toBeEnabled();
  await expect(muteBtn).toHaveAttribute('aria-pressed', 'false');

  await muteBtn.click();
  const unmuteBtn = page.getByRole('button', { name: 'Desmutar esta janela' });
  await expect(unmuteBtn).toBeEnabled();
  await expect(unmuteBtn).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('falador.windowMuted'))).toBe('1');
  await expect.poll(() => muteCalls.includes(true)).toBe(true);

  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect.poll(() => runMutedPayload).toBe(true);

  await unmuteBtn.click();
  await expect(page.getByRole('button', { name: 'Mutar esta janela' })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('falador.windowMuted'))).toBe('0');
});

test('Runner (tradutor): etapa Output exibe Modelo + Idioma e alterna portas NODE.JS:8787 → MLX-AUDIO:8091 → MLX-VLM:8092', async ({ page }) => {
  await page.route('**/api/models**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_MODELS),
    }),
  );

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'tradutor', exact: true }).click();

  const outputStage = page.locator('.stage-dd').filter({ has: page.locator('.stage-dd-label', { hasText: 'Output' }) }).first();
  await expect(outputStage).toBeVisible();
  await expect(outputStage).toHaveClass(/stage-dd--triple/);
  await expect(outputStage.getByRole('combobox')).toHaveCount(3);

  const modelCombo = outputStage.getByRole('combobox').nth(1);
  const langCombo = outputStage.getByRole('combobox').nth(2);
  const portLabel = outputStage.locator('.stage-dd-solution');

  // Inicialmente em modo write: "— (só escrever)" e NODE.JS:8787
  await expect(portLabel).toHaveText('NODE.JS:8787');
  await expect(modelCombo).toContainText('— (só escrever)');
  await expect(langCombo).toBeDisabled();
  await expect(langCombo).toContainText('— (só escrever)');

  // Dropdown lista somente modelos reais de voz/TTS (exclui STT puro como Voxtral-Realtime, LLMs, d1 e silero-vad)
  await modelCombo.click();
  const optionsText = await outputStage.getByRole('option').allInnerTexts();
  expect(optionsText).toEqual([
    '— (só escrever)',
    'LFM3-Omni-2B-MLX-8bit',
    'LiquidAI/LFM3-Audio-2B-MLX-8bit',
  ]);

  // Selecionar LFM3-Audio → MLX-AUDIO:8091 + Idioma habilitado
  await outputStage.getByRole('option', { name: 'LiquidAI/LFM3-Audio-2B-MLX-8bit', exact: true }).click();
  await expect(portLabel).toHaveText('MLX-AUDIO:8091');
  await expect(langCombo).toBeEnabled();
  await expect(langCombo).toContainText('Português');

  await langCombo.click();
  await outputStage.getByRole('option', { name: 'Inglês', exact: true }).click();
  await expect(langCombo).toContainText('Inglês');

  // Selecionar LFM3-Omni → MLX-VLM:8092
  await modelCombo.click();
  await outputStage.getByRole('option', { name: 'LFM3-Omni-2B-MLX-8bit', exact: true }).click();
  await expect(portLabel).toHaveText('MLX-VLM:8092');

  // Voltar para "— (só escrever)" → NODE.JS:8787
  await modelCombo.click();
  await outputStage.getByRole('option', { name: '— (só escrever)', exact: true }).click();
  await expect(portLabel).toHaveText('NODE.JS:8787');
  await expect(langCombo).toBeDisabled();
});

test('Builder (tradutor): canvas entra centralizado e Output (sink.captions) mostra todos os 15 parâmetros com rótulos visíveis', async ({ page }) => {
  await page.route('**/api/models**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_MODELS),
    }),
  );

  await page.goto('/');
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'tradutor', exact: true }).click();
  await page.getByRole('button', { name: 'Builder' }).click();

  const wrap = page.locator('.canvas-wrap');
  await expect(wrap).toBeVisible();
  const rfNodes = page.locator('.react-flow__node');
  await expect(rfNodes.first()).toBeVisible();

  // Aguarda fitView estabilizar e verifica que todos os nós estão dentro e centralizados na área do canvas
  await expect.poll(async () => {
    const wrapBox = await wrap.boundingBox();
    const count = await rfNodes.count();
    if (!wrapBox || count === 0) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const b = await rfNodes.nth(i).boundingBox();
      if (!b) return false;
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.width);
      maxY = Math.max(maxY, b.y + b.height);
    }
    const allInside =
      minX >= wrapBox.x - 4 &&
      maxX <= wrapBox.x + wrapBox.width + 4 &&
      minY >= wrapBox.y - 4 &&
      maxY <= wrapBox.y + wrapBox.height + 4;
    const graphCenterX = (minX + maxX) / 2;
    const wrapCenterX = wrapBox.x + wrapBox.width / 2;
    const centeredHorizontally = Math.abs(graphCenterX - wrapCenterX) < wrapBox.width * 0.25;
    return allInside && centeredHorizontally;
  }).toBe(true);

  // Clicar no nó Output (sink.captions) exibe TODOS os 15 parâmetros com rótulos visíveis
  await page.locator('.react-flow__node').filter({ hasText: 'sink.captions' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Propriedades de sink.captions' });
  await expect(dialog).toBeVisible();

  const expectedParams = [
    'model',
    'outputMode',
    'isDefault',
    'language',
    'voice',
    'ttsUrl',
    'sampleRateHz',
    'timeoutMs',
    'maxTextChars',
    'player',
    'playbackRate',
    'maxQueue',
    'mode',
    'showParcials',
    'outputFile',
  ];

  for (const paramName of expectedParams) {
    const visibleLabel = dialog
      .locator('.cds--label, .cds--toggle__label-text')
      .filter({ hasText: new RegExp(`^${paramName}(\\s*\\(.*\\))?$`) })
      .first();
    await expect(visibleLabel, `rótulo visível para ${paramName}`).toBeVisible();
    await expect(visibleLabel, `rótulo de ${paramName} não pode ter cds--visually-hidden`).not.toHaveClass(/cds--visually-hidden/);
    const box = await visibleLabel.boundingBox();
    expect(box && box.width > 8 && box.height > 8, `dimensões reais do rótulo ${paramName}`).toBe(true);
  }
});
