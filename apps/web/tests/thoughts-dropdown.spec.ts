// Botão Pensamentos abre um dropdown com o raciocínio cru do run.
import { test, expect } from '@playwright/test';

test('Pensamentos abre dropdown com os pensamentos do agente', async ({ page }) => {
  const body = [
    `event: runner\ndata: ${JSON.stringify({ type: 'run_started' })}\n\n`,
    `event: runner\ndata: ${JSON.stringify({
      type: 'thought', nodeId: 'agente', thoughtId: 'agente:1',
      text: 'Vou verificar o host antes de executar', final: true,
    })}\n\n`,
  ].join('');
  await page.route('**/api/run', (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body }));
  await page.goto('/');
  await page.getByRole('combobox', { name: 'Workflow' }).click();
  await page.getByRole('option', { name: 'especialista-ti' }).click();
  await page.getByRole('button', { name: 'Runner' }).click();
  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();

  const btn = page.getByRole('button', { name: 'Pensamentos' });
  await btn.click();
  const menu = page.getByRole('region', { name: 'Pensamentos do agente' });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Vou verificar o host antes de executar');
  await btn.click();
  await expect(menu).toHaveCount(0);
});
