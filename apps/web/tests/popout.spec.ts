// Janelas pop-out (1b/2a/interativo): cada painel abre em janela própria, idêntico à
// página central e vivo (anexa ao run por SSE, sem iniciar run). Cobre:
//  - botão ↗ da conversa e do painel de logs abrindo a URL/janela certas;
//  - botões ↗ individuais dos 4 serviços de log (web, asr, omlx, tts) abrindo 4 janelas independentes;
//  - /popout/chat e /popout/terminal com capture.ffmpeg (ADR-011, igual a especialista-ti) exibindo
//    o campo de digitação (#live-chat-input) + botão Enviar visíveis dentro do viewport e habilitados
//    assim que o SSE emite `event: attached`;
//  - /popout/log?service=omlx exibindo o bloco de log do omlx mesmo quando o localStorage só tem ['web'].
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const FLOW_NAME = 'teste-popout';

// Usa capture.ffmpeg (backend: 'chat') — exatamente como especialista-ti.json e demais flows reais (ADR-011).
const CHAT_FLOW = {
  name: FLOW_NAME,
  description: 'fluxo de chat para teste (ADR-011 capture.ffmpeg)',
  approvalLevel: 'non_readonly',
  nodes: [
    { id: 'input', type: 'capture.ffmpeg', params: { backend: 'chat', placeholder: 'Escreva', isDefault: true } },
    { id: 'assistente', type: 'llm.omlx', params: { model: 'LFM3-1.7B-MLX-4bit' } },
    { id: 'legenda', type: 'sink.captions', params: { outputMode: 'write', isDefault: true } },
  ],
  edges: [
    { from: 'input.out_text', to: 'assistente.in' },
    { from: 'assistente.out', to: 'legenda.in' },
  ],
};

const sse = (events: Record<string, unknown>[]) =>
  'event: attached\ndata: {}\n\n'
  + events.map((ev) => `event: runner\ndata: ${JSON.stringify(ev)}\n\n`).join('')
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

// SSE igual ao web-server.mjs real: envia `event: attached` ao conectar e mantém o stream aberto.
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
    res.write('event: attached\ndata: {}\n\n');
    res.write('event: runner\ndata: {"type":"chat_sent","nodeId":"input","text":"olá do popup"}\n\n');
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

test('botões ↗ do painel de logs abrem Logs, Auditoria e Terminal', async ({ page, context }) => {
  await mockFlow(context);
  await stubWindowOpen(page);
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('falador.logsView', 'terminal'));
  await page.getByRole('button', { name: 'Runner' }).click();

  // Botão do header na aba Terminal
  let popoutBtn = page.locator('.logs-panel-head').getByRole('button', { name: 'Abrir em janela' });
  await expect(popoutBtn).toHaveCount(1);
  await popoutBtn.click();
  let opened = await openedWindows(page);
  expect(opened.at(-1)?.url).toBe(`/popout/terminal?flow=${FLOW_NAME}`);
  expect(opened.at(-1)?.name).toBe('falador-popout-terminal');

  // Aba Auditoria
  await page.locator('.logs-panel-head').getByRole('tab', { name: /^Auditoria/ }).click();
  await popoutBtn.click();
  opened = await openedWindows(page);
  expect(opened.at(-1)?.url).toBe(`/popout/audit?flow=${FLOW_NAME}`);
  expect(opened.at(-1)?.name).toBe('falador-popout-audit');

  // Aba Logs
  await page.locator('.logs-panel-head').getByRole('tab', { name: /^Logs/ }).click();
  await expect(page.locator('.logs-panel-body')).toBeVisible();
  await popoutBtn.click();
  opened = await openedWindows(page);
  expect(opened.at(-1)?.url).toBe(`/popout/logs?flow=${FLOW_NAME}`);
  expect(opened.at(-1)?.name).toBe('falador-popout-logs');
});

test('janela /popout/chat mostra a conversa + barra única de input visível no viewport e envia mensagem', async ({ page, context }) => {
  await mockFlow(context);
  await streamEvents(context);
  const chats: Record<string, unknown>[] = [];
  await context.route('**/api/run/chat', (r) => {
    chats.push(r.request().postDataJSON() as Record<string, unknown>);
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.setViewportSize({ width: 720, height: 820 });
  await page.goto(`/popout/chat?flow=${FLOW_NAME}`);
  await expect(page.locator('.live2--popout-chat')).toBeVisible();
  await expect(page.locator('.live-chat')).toBeVisible();
  await expect(page.locator('.live-chat-entry--user')).toContainText('olá do popup');
  await expect(page.locator('.live2-popout-bar')).toBeHidden();

  // Deve existir EXATAMENTE 1 campo #live-chat-input visível dentro do viewport
  const input = page.locator('#live-chat-input');
  await expect(input).toHaveCount(1);
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  const box = await input.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(820);

  await input.fill('mensagem do popup');
  await input.press('Enter');
  await expect.poll(() => chats.length).toBe(1);
  expect(chats[0].text).toBe('mensagem do popup');
  expect(chats[0].nodeId).toBe('input');
});

test('janela /popout/terminal abre no Terminal com barra de chat visível no viewport e sem botão de pop-out', async ({ page, context }) => {
  await mockFlow(context);
  await streamEvents(context);
  const chats: Record<string, unknown>[] = [];
  await context.route('**/api/run/chat', (r) => {
    chats.push(r.request().postDataJSON() as Record<string, unknown>);
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });

  await page.setViewportSize({ width: 980, height: 640 });
  await page.goto(`/popout/terminal?flow=${FLOW_NAME}`);
  await expect(page.locator('.live2--popout-terminal')).toBeVisible();
  await expect(page.locator('.logs-panel-head').getByRole('tab', { name: /^Terminal/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.logs-panel-head').getByRole('button', { name: 'Abrir em janela' })).toHaveCount(0);

  // A barra de input do usuário não pode ser empurrada para fora da janela (overflow:hidden)
  const input = page.locator('#live-chat-input');
  await expect(input).toHaveCount(1);
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();
  const box = await input.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);

  await input.fill('comando via terminal popout');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect.poll(() => chats.length).toBe(1);
  expect(chats[0].text).toBe('comando via terminal popout');
});

test('janela /popout/logs sem fluxo mostra erro honesto', async ({ page }) => {
  await page.goto('/popout/logs');
  await expect(page.getByRole('alert')).toContainText('Fluxo não informado');
});

test('janela /popout/log?service=omlx abre só o serviço omlx mesmo com localStorage padrão (web)', async ({ page, context }) => {
  await mockFlow(context);
  await streamEvents(context);
  await page.goto(`/popout/log?flow=${FLOW_NAME}&service=omlx`);
  await expect(page.locator('.live2--popout-log')).toBeVisible();
  await expect(page.locator('.logs-panel-head').getByRole('tab', { name: /^Logs/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.logs-block')).toHaveCount(1);
  await expect(page.locator('.logs-block-title')).toContainText('omlx (:8080)');
  await expect(page.locator('.logs-block-path')).toHaveText('logs/omlx.log');
  await expect(page.locator('.logs-block-head').getByRole('button', { name: 'Abrir omlx em janela' })).toHaveCount(0);
});

test('janela /popout/log sem service mostra erro honesto', async ({ page }) => {
  await page.goto('/popout/log');
  await expect(page.getByRole('alert')).toContainText('Serviço de log não informado');
});

test('botões ↗ individuais de cada bloco de log abrem os 4 popups separados (web, asr, omlx, tts)', async ({ page, context }) => {
  await mockFlow(context);
  await stubWindowOpen(page);
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('falador.logsView', 'logs');
    localStorage.setItem('falador.logServices', JSON.stringify(['web', 'asr', 'omlx', 'tts']));
  });
  await page.reload();
  await page.getByRole('button', { name: 'Runner' }).click();

  await expect(page.locator('.logs-block')).toHaveCount(4);
  for (const svc of ['web', 'asr', 'omlx', 'tts']) {
    const btn = page.locator('.logs-block-head').getByRole('button', { name: `Abrir ${svc} em janela` });
    await expect(btn).toHaveCount(1);
    await btn.click();
  }

  const opened = await openedWindows(page);
  expect(opened).toEqual([
    { url: `/popout/log?flow=${FLOW_NAME}&service=web`, name: 'falador-popout-log-web' },
    { url: `/popout/log?flow=${FLOW_NAME}&service=asr`, name: 'falador-popout-log-asr' },
    { url: `/popout/log?flow=${FLOW_NAME}&service=omlx`, name: 'falador-popout-log-omlx' },
    { url: `/popout/log?flow=${FLOW_NAME}&service=tts`, name: 'falador-popout-log-tts' },
  ]);
});
