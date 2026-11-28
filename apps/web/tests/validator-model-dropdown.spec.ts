// Regressão: o campo validatorModel do agent.tools é do tipo "model"; sem passar
// a lista filtrada para ele, o editor mostrava "Nenhum modelo encontrado" com omlx no ar.
import { test, expect } from '@playwright/test';

test('agent.tools mostra modelos no campo validatorModel', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Builder' }).click();
  await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
  await page.getByRole('option', { name: 'agente-workflows', exact: true }).click();
  await page.locator('.react-flow__node').filter({ hasText: 'agent.tools' }).click();

  const editor = page.getByRole('dialog', { name: 'Propriedades de agent.tools' });
  await expect(editor).toBeVisible();
  const combo = editor.getByRole('combobox', { name: 'validatorModel' });
  await expect(combo).toBeVisible();
  await combo.click();
  await expect(page.getByRole('option', { name: /LFM3/ }).first()).toBeVisible();
  await expect(editor.locator('.pe-warn')).toHaveCount(0);
});
