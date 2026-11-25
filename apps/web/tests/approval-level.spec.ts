import { test, expect } from '@playwright/test';

test('box Approval na barra do Runner exibe A/B/C (default B), não existe duplicata ao lado de Pensamentos e o run leva mode=approve_all', async ({ page }) => {
  let posted: {
    flow?: {
      approvalLevel?: string;
      nodes?: Array<{ id: string; type: string; params?: Record<string, unknown> }>;
    };
  } | null = null;
  await page.route('**/api/run', async (route) => {
    posted = JSON.parse(route.request().postData() ?? '{}');
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: 'event: ended\ndata: {"code":0}\n\n',
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();

  // Não existe mais o dropdown duplicado ao lado de Pensamentos
  await expect(page.locator('.approval-level-wrap')).toHaveCount(0);

  // Box Approval na barra de etapas do Runner mostra default B · Só destrutivos/alteração
  const approvalStage = page.locator('.live2-stages > .stage-dd').filter({ hasText: 'Approval' }).first();
  await expect(approvalStage).toBeVisible();
  await expect(approvalStage.getByText(/B · Só destrutivos\/alteração/)).toBeVisible();

  // Escolhe C · Aprovar tudo no box Approval
  await approvalStage.locator('.stage-main-select button').click();
  await page.getByRole('option', { name: /C · Aprovar tudo/ }).click();
  await expect(approvalStage.getByText(/C · Aprovar tudo/)).toBeVisible();

  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect.poll(() => {
    const gateNode = posted?.flow?.nodes?.find((n) => n.type === 'human.approve');
    return gateNode?.params?.mode;
  }).toBe('approve_all');
});
