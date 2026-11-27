// Regressão: modo "Aplicações" NÃO pode apagar o app configurado no flow.
// Se input virar '', o capture-sck grava TODOS os apps e recaptura o afplay da própria tradução.
import { test, expect } from '@playwright/test';

test('start em Aplicações preserva input=Google Chrome no /api/run', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('falador.inputMode', 'apps'));
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'tradutor-omni', exact: true }).click();
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
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect.poll(() => payload !== null).toBe(true);

  const params = payload!.flow.nodes.find((n) => n.id === 'capture1')!.params;
  expect(params.backend).toBe('sck');
  expect(params.input).toBe('Google Chrome');
});
