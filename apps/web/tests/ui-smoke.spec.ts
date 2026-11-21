import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('builder loads a real workflow and canvas', async ({ page }) => {
  await expect(page.getByText('Audio AI Pipeline Builder')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Testar Fluxo' })).toBeVisible();
  await expect(page.getByText('Captura da call')).toBeVisible();
  await expect(page.getByText('Transcrição em tempo real')).toBeVisible();
});

test('model manager groups models and searches', async ({ page }) => {
  await page.getByRole('button', { name: 'Modelos' }).click();
  await expect(page.getByText('Modelos instalados')).toBeVisible();
  await page.getByPlaceholder('Buscar modelo…').fill('d1');
  await expect(page.getByText('Decisão (System-1)')).toBeVisible();
});

test('node editor exposes capture app reload and language controls', async ({ page }) => {
  await page.locator('.react-flow__node').filter({ hasText: 'Captura da call' }).click();
  await expect(page.getByRole('dialog', { name: 'Propriedades de capture.ffmpeg' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recarregar apps com áudio ativo' })).toBeVisible();
  await page.getByRole('button', { name: 'Fechar editor' }).click();

  await page.locator('.react-flow__node').filter({ hasText: 'Transcrição em tempo real' }).click();
  await expect(page.getByRole('dialog', { name: 'Propriedades de asr.realtime' })).toBeVisible();
  await expect(page.getByText('Nenhum modelo encontrado', { exact: false })).not.toBeVisible();
});

test('new workflow action is exposed in the flow menu', async ({ page }) => {
  await page.locator('.topbar-flow-btn').click();
  await expect(page.getByText('Novo workflow')).toBeVisible();
});
