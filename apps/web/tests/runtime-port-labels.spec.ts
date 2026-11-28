// Runtime + porta reais nas etapas e nos cabeçalhos dos logs (Omni = mlx-vlm :8092).
import { test, expect, type Page } from '@playwright/test';

async function openRunner(page: Page, flow: string) {
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: flow, exact: true }).click();
  await page.getByRole('button', { name: 'Runner' }).click();
}
const stage = (page: Page, label: string) =>
  page.locator('.stage-dd').filter({ hasText: label }).locator('.stage-dd-solution');

test('Speech Translation com LFM3-Omni mostra MLX-VLM:8092, não mlx-audio', async ({ page }) => {
  await openRunner(page, 'tradutor-omni');
  await expect(stage(page, 'Speech Translation')).toHaveText('MLX-VLM:8092');
  await expect(stage(page, 'Input')).toHaveText('NODE.JS:8787');

  const runnerAccent = await page.locator('.stage-dd').filter({ hasText: 'Speech Translation' })
    .evaluate((el) => getComputedStyle(el).getPropertyValue('--accent').trim());
  expect(runnerAccent).toBe('#3b82f6');

  await page.getByRole('button', { name: 'Builder' }).click();
  const node = page.locator('.fnode').filter({ hasText: 'asr.realtime.translate' });
  await expect(node).toHaveCount(1);
  const builderAccent = await node.evaluate((el) => getComputedStyle(el).getPropertyValue('--accent').trim());
  expect(builderAccent).toBe('#3b82f6');
});

test('trocar modelo do Omni mantém a opção Omni no dropdown e troca a porta', async ({ page }) => {
  // catálogo determinístico: o teste não depende de omlx/cache estarem no ar.
  await page.route('**/api/models**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      omlx: ['LFM3-Omni-2B-MLX-8bit'],
      cache: ['LiquidAI/LFM3-Audio-2B-MLX-8bit', 'LFM3-Audio-2B-MLX-8bit'],
      details: [],
    }),
  }));
  await openRunner(page, 'tradutor-omni');
  const st = page.locator('.stage-dd').filter({ hasText: 'Speech Translation' });
  const modelCombo = st.getByRole('combobox').nth(1);

  await modelCombo.click();
  await expect(page.getByRole('option').filter({ hasText: 'LFM3-Omni-2B-MLX-8bit' })).toHaveCount(1);
  await page.getByRole('option').filter({ hasText: /^LFM3-Audio/ }).first().click();
  await expect(stage(page, 'Speech Translation')).toHaveText('MLX-AUDIO:8091');

  // O bug: depois de escolher outro, o Omni sumia do dropdown e não dava pra voltar.
  await modelCombo.click();
  await expect(page.getByRole('option').filter({ hasText: 'LFM3-Omni-2B-MLX-8bit' })).toHaveCount(1);
  await page.getByRole('option').filter({ hasText: 'LFM3-Omni-2B-MLX-8bit' }).first().click();
  await expect(stage(page, 'Speech Translation')).toHaveText('MLX-VLM:8092');
});

test('Transcription/Translate/Output mostram as portas dos respectivos serviços', async ({ page }) => {
  await openRunner(page, 'tradutor');
  await expect(stage(page, 'Transcription')).toHaveText('MLX-AUDIO:8090');
  await expect(stage(page, 'Translate')).toHaveText('OMLX:8080');
  // tradutor*.json sai em modo write (sem TTS repetindo o Chrome); o toggle volta a falar.
  await expect(stage(page, 'Output')).toHaveText('NODE.JS:8787');
  await page.getByRole('button', { name: 'Falar' }).click();
  await expect(stage(page, 'Output')).toHaveText('MLX-AUDIO:8091');
});

test('cabeçalhos dos logs são só RUNTIME:PORTA', async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem('falador.logServices', JSON.stringify(['web', 'asr', 'omlx', 'tts', 'omni'])));
  await openRunner(page, 'tradutor-omni');
  const titles = page.locator('.logs-block-title');
  await expect(titles).toContainText(['NODE.JS:8787', 'MLX-AUDIO:8090', 'OMLX:8080', 'MLX-AUDIO:8091', 'MLX-VLM:8092']);
  await expect(page.locator('.logs-color-swatch[aria-label="Speech Translation"]').first())
    .toHaveCSS('background-color', 'rgb(59, 130, 246)');
});
