// Fila de gates do Console: o gate ativo vem do BroadcastChannel da conversa,
// sem depender do SSE, e a aprovação é validada antes de tocar o host.
import { test, expect, type Page } from '@playwright/test';

async function openConsole(page: Page): Promise<void> {
  // Sem run: prova que o card nasce do BroadcastChannel, não do SSE.
  await page.route('**/api/events', (route) => route.fulfill({
    status: 409, contentType: 'application/json', body: '{"error":"sem run"}',
  }));
  await page.goto('/console');
  await expect(page.getByRole('heading', { name: 'Console do Agente' })).toBeVisible();
  await expect(page.getByTestId('pending-count')).toHaveText('0');
}

async function postGate(page: Page, gate: Record<string, unknown> | null): Promise<void> {
  await page.evaluate((g) => {
    const bc = new BroadcastChannel('falador-console');
    bc.postMessage({ type: 'gate_active', gate: g, ts: Date.now() });
    bc.close();
  }, gate);
}

test('gate_active no BroadcastChannel cria o card no Console sem SSE de gate', async ({ page }) => {
  await openConsole(page);
  await postGate(page, { nodeId: 'bc-gate', text: 'Aprovar uptime?', ts: Date.now(), meta: { command: 'uptime' } });

  const card = page.getByRole('region', { name: 'Aprovação pendente bc-gate' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('textbox')).toHaveValue('uptime');
  await expect(page.getByTestId('pending-count')).toHaveText('1');

  await postGate(page, null);
  await expect(card).toBeHidden();
  await expect(page.getByTestId('pending-count')).toHaveText('0');
});

test('contador zera ao aprovar e campo vazio usa o comando do gate com {host,reason}', async ({ page }) => {
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/gate', async (route) => {
    sent = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await openConsole(page);
  await postGate(page, {
    nodeId: 'ssh-gate', text: 'Comando fora da allowlist. Aprovar?', ts: Date.now(),
    meta: { command: 'uptime', host: '192.168.64.7', reason: 'Aprovação válida apenas para esta execução' },
  });

  const card = page.getByRole('region', { name: 'Aprovação pendente ssh-gate' });
  await expect(card).toContainText('Host: 192.168.64.7');
  await expect(card).toContainText('Motivo: Aprovação válida apenas para esta execução');
  await expect(page.getByTestId('pending-count')).toHaveText('1');

  await card.getByRole('textbox').fill(''); // fallback: comando original do gate
  await card.getByRole('button', { name: 'Aprovar e executar' }).click();

  await expect(page.getByTestId('pending-count')).toHaveText('0');
  expect(sent).not.toBeNull();
  expect(sent?.nodeId).toBe('ssh-gate');
  expect(JSON.parse(String(sent?.text))).toEqual({
    command: 'uptime', host: '192.168.64.7', reason: 'Aprovação válida apenas para esta execução',
  });
});

test('payload JSON com command vazio NÃO é enviado', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/gate', async (route) => {
    calls += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await openConsole(page);
  await postGate(page, { nodeId: 'bad-gate', text: 'Aprovar?', ts: Date.now(), meta: { command: 'uptime' } });

  const card = page.getByRole('region', { name: 'Aprovação pendente bad-gate' });
  await card.getByRole('textbox').fill('{"command":"  "}');
  await card.getByRole('button', { name: 'Aprovar e executar' }).click();

  await expect(card.locator('.console-gate-error')).toContainText('command deve ser uma string não-vazia');
  await expect(page.getByTestId('pending-count')).toHaveText('1');
  expect(calls).toBe(0);
});
