import { test, expect } from '@playwright/test';

// Nível de aprovação global A/B/C: seletor na barra da Conversa; o run leva
// `flow.approvalLevel` (o runner mapeia para agent.tools/exec.command).
test('seletor A/B/C aparece, default B, e o run leva approvalLevel=approve_all', async ({ page }) => {
  let posted: { flow?: { approvalLevel?: string } } | null = null;
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

  const wrap = page.locator('.approval-level-wrap');
  await expect(wrap).toBeVisible();
  // default = B (non_readonly)
  await expect(wrap.getByText(/Só destrutivos/)).toBeVisible();

  // escolhe C · Aprovar tudo
  await wrap.click();
  await page.getByRole('option', { name: /Aprovar tudo/ }).click();
  await expect(wrap.getByText(/Aprovar tudo/)).toBeVisible();

  await page.getByRole('button', { name: 'Iniciar', exact: true }).click();
  await expect.poll(() => posted?.flow?.approvalLevel).toBe('approve_all');
});
