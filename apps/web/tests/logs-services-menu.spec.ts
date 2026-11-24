// Regressão (2026-11-24): menu aberto do dropdown "Selecionar componentes" do
// Logs/Auditoria ficava cortado pela borda do painel (`.logs-panel`/`.logs-panel-head`
// tinham overflow != visible — bug idêntico ao runner bar, 2026-11-23).
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1920, height: 1000 } });

test('logs services dropdown menu renders outside the panel bounds', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();

  const panel = page.locator('.logs-panel');
  await expect(panel).toBeVisible();

  await page.locator('.logs-panel-services button').first().click();
  const menu = page.locator('.logs-panel-services .cds--list-box__menu');
  await expect(menu).toBeVisible();

  // o último item do menu precisa ter ponto central hittável (não coberto/cortado)
  const lastItem = menu.locator('.cds--list-box__menu-item').last();
  const ib = await lastItem.boundingBox();
  expect(ib).toBeTruthy();
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return Boolean(el?.closest('.cds--list-box__menu-item'));
  }, [ib!.x + ib!.width / 2, ib!.y + ib!.height / 2]);
  expect(hit, 'último item do menu do Logs visível e clicável').toBe(true);
});
