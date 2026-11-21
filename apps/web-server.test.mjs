// apps/web-server.test.mjs — testes automatizados do host HTTP (ADR-006 Fase 4/6 + ADR-007 Fase A)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';

describe('apps/web-server.mjs — RAG genérico, reset-history e exportação pós-sessão', () => {
  test('W1–W4: /api/context/doc (.md + tags), /api/session/export (.md + webhook), /api/run/reset-history', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'falador-web-test-'));
    const ctxDir = join(tmpRoot, 'context');
    const sessDir = join(tmpRoot, 'sessions');

    const prevCtx = process.env.FALADOR_CONTEXT_DIR;
    const prevSess = process.env.FALADOR_SESSIONS_DIR;
    const prevOmlx = process.env.FALADOR_OMLX_URL;

    process.env.FALADOR_CONTEXT_DIR = ctxDir;
    process.env.FALADOR_SESSIONS_DIR = sessDir;
    // Porta fechada para provar fallback silencioso de extractPoints -> [] sem depender do omlx real
    process.env.FALADOR_OMLX_URL = 'http://127.0.0.1:1';

    const { createWebServer } = await import('./web-server.mjs');
    const server = createWebServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Mock HTTP server para webhook
    let webhookMethod = '';
    let webhookContentType = '';
    let webhookPayload = null;
    const webhookServer = createServer((req, res) => {
      webhookMethod = req.method ?? '';
      webhookContentType = String(req.headers['content-type'] ?? '');
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try { webhookPayload = JSON.parse(body); } catch { webhookPayload = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      });
    });
    await new Promise((resolve) => webhookServer.listen(0, '127.0.0.1', resolve));
    const whAddr = webhookServer.address();
    const webhookUrl = `http://127.0.0.1:${whAddr.port}/hook`;

    try {
      // 1) POST /api/context/doc com .md + tags
      const mdContent = [
        '# Runbook Produção',
        '## Nginx 502 Bad Gateway',
        'Verifique upstream timeout com journalctl -u nginx -n 50 e ss -tlnp.',
        '## Espaço em Disco',
        'Use df -h para verificar partições cheias em /var/log.',
      ].join('\n\n');

      const uploadRes = await fetch(`${baseUrl}/api/context/doc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'runbook-prod.md',
          text: mdContent,
          tags: ['ops', 'nginx'],
        }),
      });
      assert.equal(uploadRes.status, 200);
      const uploaded = await uploadRes.json();
      assert.equal(uploaded.name, 'runbook-prod.md');
      assert.deepEqual(uploaded.tags, ['ops', 'nginx']);
      assert.ok(uploaded.chunksCount >= 2, `Esperado >= 2 chunks, veio ${uploaded.chunksCount}`);
      assert.ok(Array.isArray(uploaded.points), 'points deve ser array mesmo sem omlx');

      // Verifica arquivo salvo em context/docs.json
      const docsFile = join(ctxDir, 'docs.json');
      assert.ok(existsSync(docsFile), 'context/docs.json deve existir');
      const savedDocs = JSON.parse(readFileSync(docsFile, 'utf-8'));
      assert.equal(savedDocs.length, 1);
      assert.equal(savedDocs[0].name, 'runbook-prod.md');
      assert.ok(Array.isArray(savedDocs[0].chunks) && savedDocs[0].chunks.length >= 2);
      assert.ok(savedDocs[0].chunks[0].text.includes('[runbook-prod.md >'));

      // Verifica GET /api/context
      const listRes = await fetch(`${baseUrl}/api/context`);
      assert.equal(listRes.status, 200);
      const listed = await listRes.json();
      assert.equal(listed.docs.length, 1);
      assert.deepEqual(listed.docs[0].tags, ['ops', 'nginx']);
      assert.equal(listed.docs[0].chunksCount, uploaded.chunksCount);

      // 2) POST /api/session/export com saveMarkdown: true
      const mdExportRes = await fetch(`${baseUrl}/api/session/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saveMarkdown: true,
          flowName: 'revisao-servidor-ops',
        }),
      });
      assert.equal(mdExportRes.status, 200);
      const mdExport = await mdExportRes.json();
      assert.equal(mdExport.ok, true);
      assert.ok(typeof mdExport.markdownPath === 'string' && mdExport.markdownPath.endsWith('.md'));
      assert.ok(existsSync(mdExport.markdownPath), 'Arquivo .md exportado deve existir');
      const mdText = readFileSync(mdExport.markdownPath, 'utf-8');
      assert.ok(mdText.includes('# Sessão Falador — revisao-servidor-ops'));
      assert.ok(mdText.includes('## Resumo de Latência'));

      // 3) POST /api/session/export com webhookUrl apontando para mock local
      const whExportRes = await fetch(`${baseUrl}/api/session/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saveMarkdown: false,
          flowName: 'revisao-servidor-ops',
          webhookUrl,
        }),
      });
      assert.equal(whExportRes.status, 200);
      const whExport = await whExportRes.json();
      assert.equal(whExport.ok, true);
      assert.equal(whExport.webhookStatus, 200);
      assert.equal(whExport.markdownPath, undefined);
      assert.equal(webhookMethod, 'POST');
      assert.ok(webhookContentType.includes('application/json'));
      assert.ok(webhookPayload && webhookPayload.flowName === 'revisao-servidor-ops');
      assert.ok(webhookPayload.latencySummary && typeof webhookPayload.latencySummary === 'object');

      // 4) POST /api/run/reset-history
      const resetRes = await fetch(`${baseUrl}/api/run/reset-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: 'assistente' }),
      });
      assert.equal(resetRes.status, 200);
      const resetBody = await resetRes.json();
      assert.equal(resetBody.ok, true);
      assert.equal(resetBody.nodeId, 'assistente');
    } finally {
      if (prevCtx === undefined) delete process.env.FALADOR_CONTEXT_DIR;
      else process.env.FALADOR_CONTEXT_DIR = prevCtx;
      if (prevSess === undefined) delete process.env.FALADOR_SESSIONS_DIR;
      else process.env.FALADOR_SESSIONS_DIR = prevSess;
      if (prevOmlx === undefined) delete process.env.FALADOR_OMLX_URL;
      else process.env.FALADOR_OMLX_URL = prevOmlx;
      await new Promise((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => webhookServer.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
