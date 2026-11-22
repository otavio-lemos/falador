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
  await expect(page.getByText(/8 nós[\s·]*7 conexões/)).toBeVisible();
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
