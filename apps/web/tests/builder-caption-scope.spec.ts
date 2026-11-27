// Regressão: legendas de um run do Runner NÃO podem aparecer na barra inferior do Builder.
import { test, expect } from '@playwright/test';

test('Builder não mostra legendas do run anterior do Runner', async ({ page }) => {
  const body = [
    `event: runner\ndata: ${JSON.stringify({ type: 'run_started' })}\n\n`,
    `event: runner\ndata: ${JSON.stringify({
      type: 'caption', nodeId: 'final_output', text: 'LEGENDA DO RUNNER', final: true,
    })}\n\n`,
  ].join('');
  await page.route('**/api/run', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body }));
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'especialista-ti' }).click();
  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();

  await expect(page.getByText('LEGENDA DO RUNNER').first()).toBeVisible();
  await page.getByRole('button', { name: 'Builder' }).click();
  await expect(page.locator('.builder-output')).toHaveCount(0);
});
