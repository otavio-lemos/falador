// apps/web-server.routes.test.mjs — contrato das rotas de API do host.
// Arquivo separado de web-server.test.mjs de propósito: FLOWS_DIR é resolvido no
// import do módulo, então cada arquivo de teste (processo próprio) pode apontar
// para um diretório temporário sem interferir nos fluxos reais do repo.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmpRoot = mkdtempSync(join(tmpdir(), 'falador-host-routes-'));
const flowsDir = join(tmpRoot, 'flows');
const logsDir = join(tmpRoot, 'logs');
mkdirSync(flowsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });
process.env.FALADOR_FLOWS_DIR = flowsDir;
process.env.FALADOR_LOGS_DIR = logsDir;
process.env.FALADOR_CONTEXT_DIR = join(tmpRoot, 'context');
process.env.FALADOR_SESSIONS_DIR = join(tmpRoot, 'sessions');
process.env.FALADOR_OMLX_URL = 'http://127.0.0.1:1'; // porta fechada: /api/models rápido e vazio
process.env.FALADOR_ASR_URL = 'http://127.0.0.1:1';
process.env.FALADOR_TTS_URL = 'http://127.0.0.1:1';

const { createWebServer } = await import('./web-server.mjs');
const server = createWebServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const api = (path, init) => fetch(`${baseUrl}${path}`, init);
const post = (path, body) =>
  api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const minimalFlow = (description = 'flow de teste') => ({
  version: 1,
  description,
  stopWhenSourcesDone: true,
  nodes: [
    { id: 'src', type: 'source.tone', params: { count: 1 } },
    { id: 'snk', type: 'sink.collect' },
  ],
  edges: [{ from: 'src.out', to: 'snk.phrase' }],
  bindings: { snk: { __collect: { received: [] } } },
});

test.after(async () => {
  await new Promise((resolve) => server.close(() => resolve()));
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('GET /api/catalog devolve o catálogo real com nós declarando portas', async () => {
  const res = await api('/api/catalog');
  assert.equal(res.status, 200);
  const raw = await res.json();
  const body = Array.isArray(raw) ? raw : raw.nodes;
  assert.ok(Array.isArray(body), 'catálogo deve expor array de nós');
  assert.ok(body.length >= 20, `esperado >= 20 nós, veio ${body.length}`);
  const types = new Set(body.map((n) => n.type));
  for (const expected of ['capture.ffmpeg', 'asr.realtime', 'llm.omlx', 'decision.llm', 'human.approve', 'exec.command', 'agent.tools', 'input.chat', 'sink.captions']) {
    assert.ok(types.has(expected), `catálogo sem ${expected}`);
  }
  for (const node of body) {
    assert.equal(typeof node.type, 'string');
    assert.ok(Array.isArray(node.inputs), `${node.type}.inputs`);
    assert.ok(Array.isArray(node.outputs), `${node.type}.outputs`);
  }
});

test('flows: POST/GET/list/DELETE roundtrip, rename e description dentro do flow', async () => {
  const empty = await (await api('/api/flows')).json();
  assert.deepEqual(empty.flows, []);

  const created = await post('/api/flows', { name: 'teste-rotas', flow: minimalFlow('desc original') });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { ok: true, name: 'teste-rotas' });
  assert.ok(existsSync(join(flowsDir, 'teste-rotas.json')));

  const got = await api('/api/flows/teste-rotas');
  assert.equal(got.status, 200);
  const gotBody = await got.json();
  assert.equal(gotBody.name, 'teste-rotas');
  assert.equal(gotBody.flow.description, 'desc original');
  assert.equal(gotBody.flow.nodes.length, 2);

  const listed = await (await api('/api/flows')).json();
  assert.equal(listed.flows.length, 1);
  assert.deepEqual(listed.flows[0], { name: 'teste-rotas', description: 'desc original' });

  // salvar com .json no nome não duplica extensão
  const dotted = await post('/api/flows', { name: 'teste-rotas.json', flow: minimalFlow('v2') });
  assert.equal(dotted.status, 200);
  assert.ok(!existsSync(join(flowsDir, 'teste-rotas.json.json')));

  // rename apaga o arquivo antigo
  const renamed = await post('/api/flows', {
    name: 'teste-renomeado',
    renameFrom: 'teste-rotas',
    flow: minimalFlow('renomeado'),
  });
  assert.equal(renamed.status, 200);
  assert.ok(existsSync(join(flowsDir, 'teste-renomeado.json')));
  assert.ok(!existsSync(join(flowsDir, 'teste-rotas.json')));

  const del = await api('/api/flows/teste-renomeado', { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true, deleted: 'teste-renomeado' });
  assert.equal((await api('/api/flows/teste-renomeado')).status, 404);
  assert.equal((await api('/api/flows/teste-renomeado', { method: 'DELETE' })).status, 404);
});

test('flows: path traversal é rejeitado em POST e não escapa do FLOWS_DIR em GET/DELETE', async () => {
  // diretório IRMÃO com prefixo comum: o antigo check `p.startsWith(FLOWS_DIR)`
  // deixaria ler/escrever nele.
  const sibling = join(tmpRoot, 'flows-evil');
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, 'segredo.json'), JSON.stringify({ secret: true }), 'utf-8');

  const bad = [
    '../escape',
    '..',
    '../../tmp/escape',
    'a/b',
    'a\\b',
    '.hidden',
    '.',
    '',
    'com espaço',
    'nome%2Fquebrado',
  ];
  for (const name of bad) {
    const res = await post('/api/flows', { name, flow: minimalFlow() });
    assert.equal(res.status, 400, `POST name=${JSON.stringify(name)} deveria ser 400, veio ${res.status}`);
  }
  assert.ok(!existsSync(join(tmpRoot, 'escape.json')), 'nada pode ser escrito fora de FLOWS_DIR');

  // GET/DELETE com traversal codificado → 404 e segredo intacto
  for (const url of [
    '/api/flows/..%2Fflows-evil%2Fsegredo',
    '/api/flows/%2E%2E%2Fflows-evil%2Fsegredo',
    '/api/flows/..%2F..%2Fetc%2Fpasswd',
    '/api/flows/.hidden',
  ]) {
    const res = await api(url);
    assert.equal(res.status, 404, `GET ${url} deveria ser 404, veio ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('secret'), `GET ${url} vazou conteúdo`);
  }
  assert.ok(existsSync(join(sibling, 'segredo.json')));
  const delRes = await api('/api/flows/..%2Fflows-evil%2Fsegredo', { method: 'DELETE' });
  assert.equal(delRes.status, 404);
});

test('POST /api/flows valida corpo: sem name/flow, JSON inválido e flow não-objeto', async () => {
  assert.equal((await post('/api/flows', { flow: minimalFlow() })).status, 400);
  assert.equal((await post('/api/flows', { name: 'x' })).status, 400);

  const invalidJson = await api('/api/flows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"name": ',
  });
  assert.equal(invalidJson.status, 400, 'JSON inválido é erro do cliente, não 500');
  const body = await invalidJson.json();
  assert.equal(typeof body.error, 'string');
});

test('GET /api/models devolve omlx + cache local em arrays, tolerando omlx fora do ar', async () => {
  const res = await api('/api/models');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.omlx), 'omlx deve ser array mesmo indisponível');
  assert.ok(Array.isArray(body.cache), 'cache deve ser array');
  assert.deepEqual(body.omlx, [], 'porta fechada ⇒ lista vazia, sem erro');
});

test('GET /api/apps devolve apps[] (e nota honesta quando o binário SCK não existe)', async () => {
  const res = await api('/api/apps');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.apps));
  for (const app of body.apps) {
    assert.equal(typeof app.name, 'string');
    assert.equal(typeof app.bundleId, 'string');
  }
});

test('logs: allowlist de nomes, no-store e limpeza explícita', async () => {
  const bad = await api('/api/logs?name=../../etc/passwd');
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('cache-control'), 'no-store');

  await post('/api/logs/clear', { names: ['web'] });
  const missing = await api('/api/logs?name=web&lines=10');
  assert.equal(missing.status, 200);
  const missingBody = await missing.json();
  assert.deepEqual(missingBody.lines, []);
  assert.equal(missing.headers.get('cache-control'), 'no-store');

  writeFileSync(join(logsDir, 'web.log'), 'linha1\nlinha2\nlinha3\n', 'utf-8');
  const tail = await (await api('/api/logs?name=web&lines=2')).json();
  assert.deepEqual(tail.lines, ['linha2', 'linha3']);
  assert.equal(tail.truncated, true);

  // clamp de lines: valor absurdo não explode
  const clamped = await (await api('/api/logs?name=web&lines=999999')).json();
  assert.equal(clamped.lines.length, 3);

  assert.equal((await post('/api/logs/clear', { names: ['nope'] })).status, 400);
  assert.equal((await post('/api/logs/clear', { names: 'web' })).status, 400);
  const cleared = await post('/api/logs/clear', { names: ['web'] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { ok: true, cleared: ['web'] });
  assert.equal(readFileSync(join(logsDir, 'web.log'), 'utf-8'), '');
});

test('rotas de run/gate/chat: erros corretos SEM run em andamento', async () => {
  assert.equal((await post('/api/run', {})).status, 400);
  assert.equal((await post('/api/run/chat', { text: 'oi' })).status, 409);
  assert.equal((await post('/api/run/chat', { text: '   ' })).status, 400);
  assert.equal((await post('/api/gate', { nodeId: 'g1', text: null })).status, 409);
  const reset = await post('/api/run/reset-history', {});
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).sent, false);
  const stop = await post('/api/stop', {});
  assert.equal(stop.status, 200);
});

test('rota /api desconhecida responde 404 JSON (não cai no index.html)', async () => {
  for (const [method, path] of [
    ['GET', '/api/nao-existe'],
    ['POST', '/api/nao-existe'],
    ['GET', '/api/flows/x/y/z'],
  ]) {
    const res = await api(path, { method });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  // rotas /api/* sem handler devolvem JSON explicativo
  for (const method of ['GET', 'POST']) {
    const res = await api('/api/nao-existe', { method });
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    assert.match((await res.json()).error, /desconhecida/);
  }
});

test('rota GET /api/mics responde 200 com mics array', async () => {
  const res = await api('/api/mics');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.mics));
  assert.match(res.headers.get('cache-control') ?? 'no-store', /no-store/);
});

test('auditoria: eventos audit chegam no SSE e o export (webhook) carrega sessionBuffer.audit', async () => {
  // Mock do omlx: executor (update_plan + final) e validador independente (achieved)
  const VALID_VALIDATION = '{"achieved":true,"confidence":0.9,"gaps":[],"nextActions":[]}';
  const execQ = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ items: [{ id: '1', description: 'Checar disco', verification: 'df -h', status: 'verified', evidence: '45%' }] }) } }] } }] },
    { choices: [{ message: { role: 'assistant', content: 'OBJETIVO CONCLUÍDO' } }] },
  ];
  const llm = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/json');
      if (body.model !== 'exec-model') {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: VALID_VALIDATION } }] }));
        return;
      }
      res.end(JSON.stringify(execQ.shift() ?? { choices: [{ message: { role: 'assistant', content: '(esgotada)' } }] }));
    });
  });
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  const llmUrl = `http://127.0.0.1:${llm.address().port}`;

  let webhookPayload = null;
  const hook = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { webhookPayload = JSON.parse(Buffer.concat(chunks).toString('utf8')); res.end('{}'); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}`;

  const flow = {
    version: 1,
    stopWhenSourcesDone: false,
    nodes: [
      { id: 'input', type: 'input.chat', params: {} },
      { id: 'agente', type: 'agent.tools', params: { baseUrl: llmUrl, model: 'exec-model', validatorModel: 'val-model', approvalPolicy: 'always', maxSteps: 4 } },
      { id: 'out', type: 'sink.captions', params: { mode: 'callback', outputMode: 'write' } },
    ],
    edges: [
      { from: 'input.out', to: 'agente.in' },
      { from: 'agente.out', to: 'out.in' },
    ],
  };

  const audits = [];
  let chatSent = false;
  let gateSent = false;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await api('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow, flowName: 'audit-test' }),
      signal: ctl.signal,
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = false;
    while (!done) {
      const { value, done: rDone } = await reader.read();
      if (rDone) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        let ev;
        try { ev = JSON.parse(dataLine.slice(6)); } catch { continue; }
        if (ev.type === 'audit') audits.push(ev);
        if (ev.type === 'metrics' && !chatSent) {
          chatSent = true;
          await post('/api/run/chat', { text: 'objetivo: checar disco', nodeId: 'input' });
        }
        if (ev.type === 'gate' && ev.meta?.tool === 'goal.confirm' && !gateSent) {
          gateSent = true;
          await post('/api/gate', { nodeId: 'agente', text: '' });
        }
        if (ev.type === 'audit' && ev.op === 'agent_final') done = true;
      }
    }
    clearTimeout(timer);
    const ops = audits.map((a) => a.op);
    assert.ok(ops.includes('plan'), `audit plan no SSE (ops: ${ops.join(',')})`);
    assert.ok(ops.includes('goal_validation'), 'audit goal_validation no SSE');
    assert.ok(ops.includes('agent_final'), 'audit agent_final no SSE');
    assert.ok(audits.every((a) => typeof a.runId === 'string' && typeof a.seq === 'number'));

    const exp = await post('/api/session/export', { saveMarkdown: false, webhookUrl: hookUrl });
    assert.equal(exp.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(webhookPayload, 'webhook recebeu o payload');
    assert.ok(Array.isArray(webhookPayload.audit), 'export carrega sessionBuffer.audit');
    const expOps = webhookPayload.audit.map((a) => a.op);
    assert.ok(expOps.includes('plan') && expOps.includes('goal_validation') && expOps.includes('agent_final'));
  } finally {
    clearTimeout(timer);
    ctl.abort();
    await post('/api/stop', {});
    await new Promise((r) => llm.close(r));
    await new Promise((r) => hook.close(r));
  }
});
