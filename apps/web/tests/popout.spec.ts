// Janelas pop-out (1b/2a/interativo): cada painel abre em janela própria, idêntico à
// página central e vivo (anexa ao run por SSE, sem iniciar run). Cobre:
//  - botão ↗ da conversa e do painel de logs abrindo a URL/janela certas;
//  - /popout/chat renderizando a conversa e enviando mensagem (interativo);
//  - /popout/terminal abrindo no Terminal e SEM botão de pop-out (não abre a si mesmo).
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const FLOW_NAME = 'teste-popout';

const CHAT_FLOW = {
  name: FLOW_NAME,
  description: 'fluxo de chat para teste',
  approvalLevel: 'non_readonly',
  nodes: [
    { id: 'entrada', type: 'input.chat', params: { placeholder: 'Escreva', isDefault: true } },
    { id: 'assistente', type: 'llm.omlx', params: { model: 'LFM3-1.7B-MLX-4bit' } },
    { id: 'legenda', type: 'sink.captions', params: { outputMode: 'write' } },
  ],
  edges: [
    { from: 'entrada', to: 'assistente' },
    { from: 'assistente', to: 'legenda' },
  ],
};

const sse = (events: Record<string, unknown>[]) =>
  events.map((ev) => `event: runner\ndata: ${JSON.stringify(ev)}\n\n`).join('')
  + 'event: ended\ndata: {"code":0}\n\n';

async function mockFlow(context: BrowserContext) {
  await context.route('**/api/flows', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ flows: [{ name: FLOW_NAME, description: CHAT_FLOW.description }] }),
  }));
  await context.route(`**/api/flows/${FLOW_NAME}`, (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ flow: CHAT_FLOW }),
  }));
}

// Substitui window.open para inspecionar exatamente o que cada botão ↗ pede.
async function stubWindowOpen(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __open: { url: string; name: string }[] }).__open = [];
    window.open = ((url?: string | URL, name?: string) => {
      (window as unknown as { __open: { url: string; name: string }[] }).__open
        .push({ url: String(url ?? ''), name: String(name ?? '') });
      return null;
    }) as typeof window.open;
  });
}

const openedWindows = (page: Page) =>
  page.evaluate(() => (window as unknown as { __open: { url: string; name: string }[] }).__open);

// SSE de verdade, aberto (sem 'ended') — o pop-out fica "running" e o input habilitado.
let sseServer: http.Server;
let ssePort = 0;
test.beforeAll(async () => {
  sseServer = http.createServer((req, res) => {
    if (!req.url?.startsWith('/events')) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      Connection: 'keep-alive',
    });
    res.write('event: runner\ndata: {"type":"run_started"}\n\n');
    res.write('event: runner\ndata: {"type":"chat_sent","nodeId":"entrada","text":"olá do popup"}\n\n');
    const ka = setInterval(() => res.write(': keep-alive\n\n'), 1000);
    req.on('close', () => clearInterval(ka));
  });
  await new Promise<void>((r) => sseServer.listen(0, '127.0.0.1', () => r()));
  ssePort = (sseServer.address() as AddressInfo).port;
});
test.afterAll(async () => { await new Promise<void>((r) => sseServer.close(() => r())); });

const streamEvents = (context: BrowserContext) =>
  context.route('**/api/events', (r) => r.continue({ url: `http://127.0.0.1:${ssePort}/events` }));

test('botão ↗ da conversa abre /popout/chat com o fluxo atual', async ({ page, context }) => {
  await mockFlow(context);
  await stubWindowOpen(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();

  const btn = page.locator('.live2-popout-bar button');
  await expect(btn).toHaveCount(1);
  await btn.click();

  const opened = await openedWindows(page);
  expect(opened).toHaveLength(1);
  expect(opened[0].url).toBe(`/popout/chat?flow=${FLOW_NAME}`);
  expect(opened[0].name).toBe('falador-popout-chat');
});

test('botões ↗ do painel de logs abrem Logs e Terminal', async ({ page, context }) => {
  await mockFlow(context);
  await stubWindowOpen(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Runner' }).click();

  const popoutBtn = page.locator('.logs-panel-head').getByRole('button', { name: 'Abrir em janela' });
  await expect(popoutBtn).toHaveCount(1);
  await popoutBtn.click();
  let opened = await openedWindows(page);
  expect(opened.at(-1)?.url).toBe(`/popout/logs?flow=${FLOW_NAME}`);
  expect(opened.at(-1)?.name).toBe('falador-popout-logs');

  await page.locator('.logs-panel-head').getByRole('tab', { name: /^Terminal/ }).click();
  await popoutBtn.click();
  opened = await openedWindows(page);
  expect(opened.at(-1)?.url).toBe(`/popout/terminal?flow=${FLOW_NAME}`);
  expect(opened.at(-1)?.name).toBe('falador-popout-terminal');
});

test('janela /popout/chat mostra a conversa e envia mensagem (interativa)', async ({ page, context }) => {
  await mockFlow(context);
  await streamEvents(context);
  const chats: Record<string, unknown>[] = [];
  await context.route('**/api/run/chat', (r) => {
    chats.push(r.request().postDataJSON() as Record<string, unknown>);
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.goto(`/popout/chat?flow=${FLOW_NAME}`);
  await expect(page.locator('.live2--popout-chat')).toBeVisible();
  await expect(page.locator('.live-chat')).toBeVisible();
  await expect(page.locator('.live-chat-entry--user')).toContainText('olá do popup');
  // No pop-out não há botão que abra outro pop-out.
  await expect(page.locator('.live2-popout-bar')).toBeHidden();

  await page.locator('.live2--popout-chat #live-chat-input').first().fill('mensagem do popup');
  await page.locator('.live2--popout-chat #live-chat-input').first().press('Enter');
  await expect.poll(() => chats.length).toBe(1);
  expect(chats[0].text).toBe('mensagem do popup');
  expect(chats[0].nodeId).toBe('entrada');
});

test('janela /popout/terminal abre no Terminal e não tem botão de pop-out', async ({ page, context }) => {
  await mockFlow(context);
  await context.route('**/api/events', (r) => r.fulfill({
    status: 200, contentType: 'text/event-stream',
    body: sse([
      { type: 'run_started' },
      { type: 'execution', id: 'e1', nodeId: 'exec', tool: 'exec_local', transport: 'local', command: 'uptime', output: 'up 3 days', exitCode: 0, ts: Date.now() },
    ]),
  }));

  await page.goto(`/popout/terminal?flow=${FLOW_NAME}`);
  await expect(page.locator('.live2--popout-terminal')).toBeVisible();
  await expect(page.locator('.logs-panel-head').getByRole('tab', { name: /^Terminal/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.logs-panel')).toContainText('uptime');
  await expect(page.locator('.logs-panel-head').getByRole('button', { name: 'Abrir em janela' })).toHaveCount(0);
});

test('janela /popout/logs sem fluxo mostra erro honesto', async ({ page }) => {
  await page.goto('/popout/logs');
  await expect(page.getByRole('alert')).toContainText('Fluxo não informado');
});
