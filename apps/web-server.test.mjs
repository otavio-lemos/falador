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
    const prevLogs = process.env.FALADOR_LOGS_DIR;

    process.env.FALADOR_CONTEXT_DIR = ctxDir;
    process.env.FALADOR_SESSIONS_DIR = sessDir;
    const logsDir = join(tmpRoot, 'logs');
    process.env.FALADOR_LOGS_DIR = logsDir;
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

      // 5) POST /api/run/chat — 400 sem text e 409 sem run ativo
      const chatNoTextRes = await fetch(`${baseUrl}/api/run/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(chatNoTextRes.status, 400);

      const chatEmptyTextRes = await fetch(`${baseUrl}/api/run/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      });
      assert.equal(chatEmptyTextRes.status, 400);

      const chatNoRunRes = await fetch(`${baseUrl}/api/run/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Crie um workflow de transcrição' }),
      });
      assert.equal(chatNoRunRes.status, 409);

      // 6) GET /api/logs — allowlist de serviços + tail de linhas
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(join(logsDir, 'omlx.log'), 'linha1\nlinha2\nlinha3\n', 'utf-8');
      const logsRes = await fetch(`${baseUrl}/api/logs?name=omlx&lines=2`);
      assert.equal(logsRes.status, 200);
      const logsBody = await logsRes.json();
      assert.equal(logsBody.name, 'omlx');
      assert.deepEqual(logsBody.lines, ['linha2', 'linha3']);
      assert.equal(logsBody.truncated, true);
      const missingLogs = await fetch(`${baseUrl}/api/logs?name=tts`);
      assert.equal(missingLogs.status, 200);
      assert.deepEqual((await missingLogs.json()).lines, []);
      const badLogs = await fetch(`${baseUrl}/api/logs?name=${encodeURIComponent('../../etc/passwd')}`);
      assert.equal(badLogs.status, 400);
    } finally {
      if (prevCtx === undefined) delete process.env.FALADOR_CONTEXT_DIR;
      else process.env.FALADOR_CONTEXT_DIR = prevCtx;
      if (prevSess === undefined) delete process.env.FALADOR_SESSIONS_DIR;
      else process.env.FALADOR_SESSIONS_DIR = prevSess;
      if (prevOmlx === undefined) delete process.env.FALADOR_OMLX_URL;
      else process.env.FALADOR_OMLX_URL = prevOmlx;
      if (prevLogs === undefined) delete process.env.FALADOR_LOGS_DIR;
      else process.env.FALADOR_LOGS_DIR = prevLogs;
      await new Promise((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => webhookServer.close(() => resolve()));
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('run único: desconectar o último cliente SSE para o run após a carência e libera o próximo (sem 409)', async () => {
    const prevGrace = process.env.FALADOR_RUN_IDLE_STOP_MS;
    process.env.FALADOR_RUN_IDLE_STOP_MS = '800'; // carência curta para teste determinístico

    const { createWebServer } = await import('./web-server.mjs');
    const server = createWebServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Fluxo que fica vivo: fonte input.chat + stopWhenSourcesDone:false (como agente-workflows)
    const flow = {
      version: 1,
      stopWhenSourcesDone: false,
      nodes: [
        { id: 'chat', type: 'input.chat', params: {} },
        { id: 'out', type: 'sink.captions', params: { mode: 'callback' } },
      ],
      edges: [{ from: 'chat.parcs', to: 'out.in', capacity: 8, overflow: 'block' }],
    };

    try {
      // Abre o SSE e desconecta o cliente (simula reload/troca de view)
      const ctl = new AbortController();
      const resp = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow, flowName: 'test-disconnect' }),
        signal: ctl.signal,
      });
      assert.equal(resp.status, 200);
      const reader = resp.body.getReader();
      await reader.read(); // frame 'attached' (run iniciado)
      await reader.cancel();
      ctl.abort();

      // Logo após desconectar, o run ainda existe: 2o POST leva 409 (a carência corre)
      const during = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow, flowName: 'test-disconnect-2' }),
      });
      assert.equal(during.status, 409);
      await during.body?.cancel();

      // Após a carência + SIGTERM, o host libera currentRun e o próximo run responde 200
      let finalStatus = 0;
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const r = await fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flow, flowName: 'test-disconnect-3' }),
        });
        finalStatus = r.status;
        await r.body?.cancel();
        if (r.status === 200) break;
        await new Promise((res) => setTimeout(res, 150));
      }
      assert.equal(finalStatus, 200, 'esperado 200 (run liberado) após a carência de desconexão');
    } finally {
      await fetch(`${baseUrl}/api/stop`, { method: 'POST' }).catch(() => {});
      await new Promise((res) => setTimeout(res, 700)); // deixa o child do runner sair
      await new Promise((resolve) => server.close(() => resolve()));
      if (prevGrace === undefined) delete process.env.FALADOR_RUN_IDLE_STOP_MS;
      else process.env.FALADOR_RUN_IDLE_STOP_MS = prevGrace;
    }
  });
});
