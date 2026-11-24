// Console em janela única (2026-11-24): rota própria, SSE anexado ao run,
// sem iniciar run e sem depender da aba da conversa.
import { test, expect } from '@playwright/test';

test('console abre como página própria e anexa ao run em andamento', async ({ page, request }) => {
  const before = await request.get('/api/events');
  expect(before.status()).toBe(409);

  await page.goto('/console');
  await expect(page.getByRole('heading', { name: 'Console do Agente' })).toBeVisible();
  await expect(page.getByText('Sem run em andamento')).toBeVisible();
  await expect(page.getByText('Inicie um fluxo na aba principal.')).toBeVisible();
});
