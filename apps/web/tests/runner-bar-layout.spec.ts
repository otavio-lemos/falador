// Regressão (2026-11-23): Runner bar quebrava em 2 linhas e o menu aberto do dropdown
// ficava cortado dentro da faixa (overflow-x:hidden). Garante: todas as etapas em 1 linha,
// sem scroll horizontal, e o menu aberto visível FORA da faixa com o nome completo.
import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1920, height: 1000 } });

for (const flow of ['especialista-ti', 'entrevista']) {
  test(`runner bar 1 linha + menu fora da faixa (${flow})`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
    await page.getByRole('option', { name: flow }).click();
    await page.getByRole('button', { name: 'Runner' }).click();

    const stages = page.locator('.live2-stages > .stage-dd');
    await expect(stages.first()).toBeVisible();
    const n = await stages.count();
    const tops = new Set<number>();
    for (let i = 0; i < n; i++) {
      const b = await stages.nth(i).boundingBox();
      tops.add(Math.round(b!.y));
    }
    expect(tops.size, 'todas as etapas na mesma linha').toBe(1);

    const bar = page.locator('.live2-stages-bar');
    const overflow = await bar.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, 'sem scroll horizontal').toBeLessThanOrEqual(1);

    // abre o dropdown principal da etapa Decision
    const decision = stages.filter({ hasText: 'Decision' }).first();
    await decision.locator('.stage-main-select button').click();
    const menu = decision.locator('.stage-main-select .cds--list-box__menu');
    await expect(menu).toBeVisible();
    const barBox = (await bar.boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.y + menuBox.height, 'menu sai da faixa').toBeGreaterThan(barBox.y + barBox.height + 20);

    // o ponto central do último item do menu precisa ser o próprio item (não coberto/cortado)
    const lastItem = menu.locator('.cds--list-box__menu-item').last();
    await lastItem.scrollIntoViewIfNeeded(); // a lista de modelos do omlx pode crescer e rolar
    const ib = (await lastItem.boundingBox())!;
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return Boolean(el?.closest('.cds--list-box__menu-item'));
    }, [ib.x + ib.width / 2, ib.y + ib.height / 2]);
    expect(hit, 'último item do menu visível e clicável').toBe(true);

    await page.screenshot({ path: `test-results/runner-bar-${flow}.png`, clip: { x: 0, y: 0, width: 1920, height: 400 } });
  });
}
