// apps/web-server.test.mjs — testes automatizados do host HTTP (ADR-006 Fase 4/6 + ADR-007 Fase A)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

      // 6) GET /api/logs — allowlist de serviços + tail de linhas + Cache-Control: no-store
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(join(logsDir, 'omlx.log'), 'linha1\nlinha2\nlinha3\n', 'utf-8');
      const logsRes = await fetch(`${baseUrl}/api/logs?name=omlx&lines=2`);
      assert.equal(logsRes.status, 200);
      assert.equal(logsRes.headers.get('cache-control'), 'no-store');
      const logsBody = await logsRes.json();
      assert.equal(logsBody.name, 'omlx');
      assert.deepEqual(logsBody.lines, ['linha2', 'linha3']);
      assert.equal(logsBody.truncated, true);
      const missingLogs = await fetch(`${baseUrl}/api/logs?name=tts`);
      assert.equal(missingLogs.status, 200);
      assert.equal(missingLogs.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await missingLogs.json()).lines, []);
      const badLogs = await fetch(`${baseUrl}/api/logs?name=${encodeURIComponent('../../etc/passwd')}`);
      assert.equal(badLogs.status, 400);
      assert.equal(badLogs.headers.get('cache-control'), 'no-store');
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
    const tmpRoot = mkdtempSync(join(tmpdir(), 'falador-web-disconnect-'));
    const prevGrace = process.env.FALADOR_RUN_IDLE_STOP_MS;
    const prevLogs = process.env.FALADOR_LOGS_DIR;
    process.env.FALADOR_RUN_IDLE_STOP_MS = '800'; // carência curta para teste determinístico
    process.env.FALADOR_LOGS_DIR = join(tmpRoot, 'logs');

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
      if (prevLogs === undefined) delete process.env.FALADOR_LOGS_DIR;
      else process.env.FALADOR_LOGS_DIR = prevLogs;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('logs: escrita direta em web.log (sem redirecionamento de stderr), GET /api/logs no-store e POST /api/logs/clear', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'falador-web-logs-test-'));
    const logsDir = join(tmpRoot, 'logs');
    const prevLogs = process.env.FALADOR_LOGS_DIR;
    process.env.FALADOR_LOGS_DIR = logsDir;

    const { createWebServer } = await import('./web-server.mjs');
    const server = createWebServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function drainSse(resp) {
      const reader = resp.body.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    try {
      // (a.1) Erros de /api/run (400 sem flow e 500 JSON malformado) gravam em web.log
      const badRun = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(badRun.status, 400);

      const brokenJsonRun = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      });
      assert.equal(brokenJsonRun.status, 500);

      // (a.2) flow_invalid no runner grava diretamente em web.log mesmo sem stderr redirect
      const invalidFlow = {
        version: 1,
        nodes: [{ id: 'asr', type: 'asr.realtime', params: {} }],
        edges: [],
      };
      const invalidRun = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: invalidFlow, flowName: 'flow-invalido-teste' }),
      });
      assert.equal(invalidRun.status, 200);
      await drainSse(invalidRun);

      // (a.3) Run real com node_error (llm.omlx apontando para porta fechada) grava run_started, node_error e run_stopped
      const failingNodeFlow = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'oi' } },
          { id: 'llm', type: 'llm.omlx', params: { baseUrl: 'http://127.0.0.1:1', model: 'LFM3-1.7B-MLX-4bit', historyMax: 0 } },
          { id: 'out', type: 'sink.captions', params: { mode: 'callback' } },
        ],
        edges: [
          { from: 'src.out', to: 'llm.in', capacity: 4, overflow: 'block' },
          { from: 'llm.out', to: 'out.in', capacity: 4, overflow: 'block' },
        ],
      };
      const errNodeRun = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: failingNodeFlow, flowName: 'teste-node-error' }),
      });
      assert.equal(errNodeRun.status, 200);
      await drainSse(errNodeRun);

      const webLogPath = join(logsDir, 'web.log');
      assert.ok(existsSync(webLogPath), 'logs/web.log deve ser criado diretamente pelo appendWebLog');
      const diskLog = readFileSync(webLogPath, 'utf-8');
      assert.match(diskLog, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /m, 'linhas devem conter timestamp legível');
      assert.ok(diskLog.includes('[api/run] 400 flow obrigatório'), 'erro 400 de /api/run deve constar no web.log');
      assert.ok(diskLog.includes('[http] 500 POST /api/run:'), 'erro 500 de /api/run deve constar no web.log');
      assert.ok(diskLog.includes('[runner] flow_invalid:'), 'flow_invalid do runner deve constar no web.log');
      assert.ok(diskLog.includes('[runner] run_started flow=teste-node-error'), 'run_started deve constar no web.log');
      assert.ok(diskLog.includes('[runner] node_error [llm] (log_error): llm.omlx falhou:'), 'node_error do runner deve constar no web.log');
      assert.ok(diskLog.includes('[runner] run_stopped'), 'run_stopped do runner deve constar no web.log');

      // (b) GET /api/logs?name=web retorna imediatamente linhas novas com Cache-Control: no-store
      const webLogsRes = await fetch(`${baseUrl}/api/logs?name=web&lines=50&_t=${Date.now()}`);
      assert.equal(webLogsRes.status, 200);
      assert.equal(webLogsRes.headers.get('cache-control'), 'no-store');
      const webLogsBody = await webLogsRes.json();
      assert.equal(webLogsBody.name, 'web');
      assert.ok(webLogsBody.lines.some((l) => l.includes('node_error [llm]')));
      assert.ok(webLogsBody.lines.some((l) => l.includes('flow_invalid:')));

      // Strip de bytes NUL esparsos (ex.: redirecionamento '>' após truncamento) + rejeição de prototype key
      writeFileSync(join(logsDir, 'asr.log'), '\0\0linha-asr-1\nlinha-asr-2\n', 'utf-8');
      const asrRes = await fetch(`${baseUrl}/api/logs?name=asr`);
      assert.equal(asrRes.status, 200);
      assert.equal(asrRes.headers.get('cache-control'), 'no-store');
      assert.deepEqual((await asrRes.json()).lines, ['linha-asr-1', 'linha-asr-2']);

      const protoRes = await fetch(`${baseUrl}/api/logs?name=constructor`);
      assert.equal(protoRes.status, 400);
      assert.equal(protoRes.headers.get('cache-control'), 'no-store');

      // (c) POST /api/logs/clear limpa apenas os permitidos selecionados e rejeita inválidos
      writeFileSync(join(logsDir, 'omlx.log'), 'omlx-1\n', 'utf-8');
      writeFileSync(join(logsDir, 'tts.log'), 'tts-1\n', 'utf-8');

      // Rejeição atômica: se houver nome fora da allowlist, retorna 400 e não trunca nenhum arquivo
      const badClearMixed = await fetch(`${baseUrl}/api/logs/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: ['asr', '../../etc/passwd'] }),
      });
      assert.equal(badClearMixed.status, 400);
      assert.equal(badClearMixed.headers.get('cache-control'), 'no-store');
      assert.equal(readFileSync(join(logsDir, 'asr.log'), 'utf-8'), '\0\0linha-asr-1\nlinha-asr-2\n');

      for (const badBody of [
        { names: ['desconhecido'] },
        { names: ['constructor'] },
        { names: 'web' },
      ]) {
        const r = await fetch(`${baseUrl}/api/logs/clear`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(badBody),
        });
        assert.equal(r.status, 400);
        assert.equal(r.headers.get('cache-control'), 'no-store');
      }

      // Limpa seletivamente ['web', 'omlx']
      const clearPartial = await fetch(`${baseUrl}/api/logs/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names: ['web', 'omlx'] }),
      });
      assert.equal(clearPartial.status, 200);
      assert.equal(clearPartial.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await clearPartial.json(), { ok: true, cleared: ['web', 'omlx'] });

      assert.deepEqual((await (await fetch(`${baseUrl}/api/logs?name=web`)).json()).lines, []);
      assert.deepEqual((await (await fetch(`${baseUrl}/api/logs?name=omlx`)).json()).lines, []);
      assert.deepEqual((await (await fetch(`${baseUrl}/api/logs?name=asr`)).json()).lines, ['linha-asr-1', 'linha-asr-2']);

      // Limpa tudo quando names é omitido
      const clearAll = await fetch(`${baseUrl}/api/logs/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(clearAll.status, 200);
      assert.deepEqual(await clearAll.json(), { ok: true, cleared: ['omlx', 'asr', 'tts', 'web'] });
      assert.deepEqual((await (await fetch(`${baseUrl}/api/logs?name=asr`)).json()).lines, []);
      assert.deepEqual((await (await fetch(`${baseUrl}/api/logs?name=tts`)).json()).lines, []);

      // Após limpar, um novo erro aparece imediatamente no GET /api/logs?name=web
      await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const afterClear = await (await fetch(`${baseUrl}/api/logs?name=web`)).json();
      assert.equal(afterClear.lines.length, 1);
      assert.ok(afterClear.lines[0].includes('[api/run] 400 flow obrigatório'));
    } finally {
      await fetch(`${baseUrl}/api/stop`, { method: 'POST' }).catch(() => {});
      await new Promise((res) => setTimeout(res, 500));
      await new Promise((resolve) => server.close(() => resolve()));
      if (prevLogs === undefined) delete process.env.FALADOR_LOGS_DIR;
      else process.env.FALADOR_LOGS_DIR = prevLogs;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('POST /api/stop seguido imediatamente de POST /api/run (3 ciclos) nunca retorna 409', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'falador-web-stop-run-test-'));
    const prevLogs = process.env.FALADOR_LOGS_DIR;
    process.env.FALADOR_LOGS_DIR = join(tmpRoot, 'logs');

    const { createWebServer } = await import('./web-server.mjs');
    const server = createWebServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    // Flow que permanece ativo aguardando input (como chat-agente-suporte)
    const chatFlow = {
      version: 1,
      stopWhenSourcesDone: false,
      nodes: [
        { id: 'chat', type: 'input.chat', params: { placeholder: 'teste' } },
        { id: 'out', type: 'sink.captions', params: { mode: 'callback' } },
      ],
      edges: [{ from: 'chat.out', to: 'out.in', capacity: 4, overflow: 'block' }],
    };

    const ctls = [];
    try {
      for (let i = 0; i < 3; i++) {
        const ctl = new AbortController();
        ctls.push(ctl);
        const runRes = await fetch(`${baseUrl}/api/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flow: chatFlow, flowName: `ciclo-${i}` }),
          signal: ctl.signal,
        });
        assert.equal(runRes.status, 200, `ciclo ${i}: esperado HTTP 200, veio ${runRes.status}`);
        const reader = runRes.body.getReader();
        await reader.read(); // frame 'attached'

        const stopRes = await fetch(`${baseUrl}/api/stop`, { method: 'POST' });
        assert.equal(stopRes.status, 200);
        ctl.abort();
        await reader.cancel().catch(() => {});
      }
      // 4o start imediato após o 3o stop também deve retornar 200
      const ctlFinal = new AbortController();
      ctls.push(ctlFinal);
      const finalRun = await fetch(`${baseUrl}/api/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: chatFlow, flowName: 'ciclo-final' }),
        signal: ctlFinal.signal,
      });
      assert.equal(finalRun.status, 200);
      await fetch(`${baseUrl}/api/stop`, { method: 'POST' });
      ctlFinal.abort();
      await finalRun.body?.cancel().catch(() => {});
    } finally {
      for (const c of ctls) { try { c.abort(); } catch { /* ignore */ } }
      await fetch(`${baseUrl}/api/stop`, { method: 'POST' }).catch(() => {});
      await new Promise((resolve) => server.close(() => resolve()));
      if (prevLogs === undefined) delete process.env.FALADOR_LOGS_DIR;
      else process.env.FALADOR_LOGS_DIR = prevLogs;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('GET /api/services/status reporta exatamente o status vivo dos 4 serviços com no-store', async () => {
    const prevOmlx = process.env.FALADOR_OMLX_URL;
    const prevAsr = process.env.FALADOR_ASR_URL;
    const prevTts = process.env.FALADOR_TTS_URL;

    const mockOmlx = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => mockOmlx.listen(0, '127.0.0.1', resolve));
    const omlxAddr = mockOmlx.address();

    let asrHttpHits = 0;
    const mockAsr = createServer((_req, res) => {
      asrHttpHits += 1;
      res.writeHead(200);
      res.end();
    });
    await new Promise((resolve) => mockAsr.listen(0, '127.0.0.1', resolve));
    const asrAddr = mockAsr.address();

    process.env.FALADOR_OMLX_URL = `http://127.0.0.1:${omlxAddr.port}`;
    process.env.FALADOR_ASR_URL = `http://127.0.0.1:${asrAddr.port}`;
    process.env.FALADOR_TTS_URL = 'http://127.0.0.1:1';

    const { createWebServer } = await import('./web-server.mjs');
    const server = createWebServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      const resp = await fetch(`${baseUrl}/api/services/status`);
      assert.equal(resp.status, 200);
      assert.equal(resp.headers.get('cache-control'), 'no-store');
      const body = await resp.json();
      assert.deepEqual(body.services, { web: true, omlx: true, asr: true, tts: false });
      assert.equal(asrHttpHits, 0, 'ASR status check deve usar TCP sem requisição HTTP (zero spam no log)');
      assert.equal(typeof body.ts, 'number');
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
      await new Promise((resolve) => mockOmlx.close(() => resolve()));
      await new Promise((resolve) => mockAsr.close(() => resolve()));
      if (prevOmlx === undefined) delete process.env.FALADOR_OMLX_URL;
      else process.env.FALADOR_OMLX_URL = prevOmlx;
      if (prevAsr === undefined) delete process.env.FALADOR_ASR_URL;
      else process.env.FALADOR_ASR_URL = prevAsr;
      if (prevTts === undefined) delete process.env.FALADOR_TTS_URL;
      else process.env.FALADOR_TTS_URL = prevTts;
    }
  });
});
