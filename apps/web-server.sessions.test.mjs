// apps/web-server.sessions.test.mjs — contrato das rotas GET /api/sessions.
// FALADOR_SESSIONS_DIR aponta para dir temporário: nunca toca nas sessões reais.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmpRoot = mkdtempSync(join(tmpdir(), 'falador-sessions-host-'));
const sessionsDir = join(tmpRoot, 'sessions');
mkdirSync(sessionsDir, { recursive: true });
process.env.FALADOR_SESSIONS_DIR = sessionsDir;
process.env.FALADOR_FLOWS_DIR = join(tmpRoot, 'flows');
process.env.FALADOR_LOGS_DIR = join(tmpRoot, 'logs');
process.env.FALADOR_CONTEXT_DIR = join(tmpRoot, 'context');
process.env.FALADOR_OMLX_URL = 'http://127.0.0.1:1';
process.env.FALADOR_ASR_URL = 'http://127.0.0.1:1';
process.env.FALADOR_TTS_URL = 'http://127.0.0.1:1';

const { createWebServer } = await import('./web-server.mjs');
const server = createWebServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('GET /api/sessions com diretório vazio devolve 200 { items: [] } no-store', async () => {
  const res = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { items: [] });
});

test('traversal, barras e symlink não leem arquivos fora de sessions/', async () => {
  const secret = join(tmpRoot, 'segredo.md');
  writeFileSync(secret, 'CONTEUDO SECRETO FORA DA PASTA');
  symlinkSync(secret, join(sessionsDir, 'link.md'));

  const badNames = ['..%2Fsegredo.md', '%2e%2e%2fsegredo.md', 'foo%2Fbar.md', '..%5Csegredo.md', 'link.md'];
  for (const name of badNames) {
    const res = await fetch(`${baseUrl}/api/sessions/${name}`);
    assert.ok(res.status === 400 || res.status === 404, `${name}: status ${res.status}`);
    const body = await res.json();
    assert.equal(typeof body.error, 'string', `${name}: erro JSON`);
    assert.ok(!JSON.stringify(body).includes('CONTEUDO SECRETO'), `${name}: vazou conteúdo`);
  }
  const listed = await (await fetch(`${baseUrl}/api/sessions`)).json();
  assert.deepEqual(listed.items, [], 'symlink não deve aparecer na lista');
});

test('ata real: lista com metadata e GET por nome devolve { name, content } JSON', async () => {
  const name = '2026-11-24_1200-entrevista.md';
  const md = '# Sessão de teste\n\nOlá, este é um teste ao vivo da pipeline.';
  writeFileSync(join(sessionsDir, name), md, 'utf-8');

  const listed = await (await fetch(`${baseUrl}/api/sessions`)).json();
  assert.equal(listed.items.length, 1);
  const item = listed.items[0];
  assert.equal(item.name, name);
  assert.equal(item.size, Buffer.byteLength(md, 'utf-8'));
  assert.equal(typeof item.updatedAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(item.updatedAt)));
  assert.ok(item.preview.includes('Olá, este é um teste'));
  assert.ok(!item.preview.includes('\n'));

  const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(item.name)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await res.json(), { name, content: md });
});

test('nome válido inexistente devolve 404 JSON', async () => {
  const res = await fetch(`${baseUrl}/api/sessions/2026-01-01_0000-inexistente.md`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(typeof body.error, 'string');
});
