// falador-cli — contrato do runner headless (run-flow.mjs).
// O runner é o processo que o host, a TUI e a CI consomem: stdout é 100% NDJSON,
// stdin aceita gate_action/reset_history/chat_input, e qualquer sinal encerra o
// grafo sem deixar children órfãos.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRegistry, validateFlow, sourceTone, pipeDelay, pipeParcs, sinkCollect } from '../../falador-graph/src/index.ts';
import { registerFaladorNodes } from '../../falador-nodes/src/index.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'run-flow.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'falador-cli-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
function writeFlow(flow) {
  const p = join(tmp, `flow-${++seq}.json`);
  writeFileSync(p, JSON.stringify(flow), 'utf-8');
  return p;
}

/** Roda o CLI, opcionalmente envia linhas no stdin, e devolve stdout/stderr/exit. */
function runCli(args, { stdinLines = [], timeoutMs = 20_000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* já morto */ }
      reject(new Error(`timeout de ${timeoutMs} ms; stdout parcial: ${stdout.slice(0, 400)}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d;
      if (onLine) {
        for (const l of String(d).split('\n')) if (l.trim()) onLine(l);
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    for (const line of stdinLines) child.stdin.write(line + '\n');
  });
}

const parseNdjson = (stdout) =>
  stdout.split('\n').filter((l) => l.trim()).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      assert.fail(`linha ${i + 1} não é JSON: ${l.slice(0, 200)}`);
    }
  });

function sseServer() {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"Pensando"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"Resposta"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

function toneFlow({ count = 5, stopWhenSourcesDone = true, intervalMs } = {}) {
  return {
    version: 1,
    stopWhenSourcesDone,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count, ...(intervalMs ? { intervalMs } : {}) } },
      { id: 'snk', type: 'sink.collect' },
    ],
    edges: [{ from: 'src.out', to: 'snk.phrase' }],
  };
}

test('--catalog: uma linha JSON, catálogo completo e saídas dinâmicas marcadas', async () => {
  const r = await runCli(['--catalog']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr.trim(), '', 'catálogo não deve escrever no stderr');
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1, '--catalog deve emitir exatamente uma linha');
  const cat = JSON.parse(lines[0]);
  assert.equal(cat.type, 'catalog');
  assert.equal(cat.nodes.length, 24, `esperado 24 nós, veio ${cat.nodes.length}`);
  for (const n of cat.nodes) {
    assert.equal(typeof n.type, 'string');
    assert.ok(Array.isArray(n.inputs) && Array.isArray(n.outputs), `${n.type} sem portas`);
    assert.ok(Array.isArray(n.paramNames), `${n.type} sem paramNames`);
  }
  const byType = new Map(cat.nodes.map((n) => [n.type, n]));
  assert.equal(byType.get('decision.llm').dynamicOutputs, true);
  assert.equal(byType.get('llm.omlx').dynamicOutputs, false);
  assert.ok(byType.has('input.chat') && byType.has('exec.command') && byType.has('tool.mcp'));
});

test('flow válido: NDJSON puro, summary com resultados em ordem, exit 0', async () => {
  const p = writeFlow(toneFlow({ count: 4 }));
  const r = await runCli([p]);
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stderr.trim(), '', 'run feliz não deve escrever no stderr');

  const events = parseNdjson(r.stdout);
  assert.ok(events.some((e) => e.type === 'run_started'), 'run_started');
  assert.ok(events.some((e) => e.type === 'run_stopped'), 'run_stopped');
  const summary = events.find((e) => e.type === 'summary');
  assert.ok(summary, 'summary obrigatório');
  assert.deepEqual(summary.results.snk, ['tone-1', 'tone-2', 'tone-3', 'tone-4']);
  assert.equal(typeof summary.summary.stopped, 'boolean');
  assert.ok(summary.summary.metrics.nodes.snk, 'metrics por nó no summary');
  assert.equal(summary.summary.metrics.nodes.snk.in, 4);
});

test('flow inválido: flow_invalid no stdout e exit 1 (sem stack no stdout)', async () => {
  const p = writeFlow({ version: 1, nodes: [{ id: 'x', type: 'nao.existe' }], edges: [] });
  const r = await runCli([p]);
  assert.equal(r.code, 1);
  const events = parseNdjson(r.stdout);
  const invalid = events.find((e) => e.type === 'flow_invalid');
  assert.ok(invalid, 'flow_invalid obrigatório');
  assert.match(invalid.error, /UNKNOWN_NODE_TYPE|não registrado/);
  assert.ok(!r.stdout.includes(' at '), 'stdout deve ser NDJSON puro, sem stack trace');
});

test('sem argumentos: uso no stderr e exit 2', async () => {
  const r = await runCli([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /uso: node run-flow\.mjs/);
  assert.equal(r.stdout.trim(), '');
});

test('arquivo inexistente: exit 1 e mensagem no stderr', async () => {
  const r = await runCli([join(tmp, 'nao-existe.json')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ENOENT|no such file/i);
});

test('--run-seconds encerra fonte contínua sozinho e sai limpo', async () => {
  const p = writeFlow(toneFlow({ count: 1000, stopWhenSourcesDone: false, intervalMs: 25 }));
  const started = Date.now();
  const r = await runCli([p, '--run-seconds', '1'], { timeoutMs: 15_000 });
  const elapsed = Date.now() - started;
  assert.equal(r.code, 0, `stderr: ${r.stderr}`);
  assert.ok(elapsed < 10_000, `deveria encerrar perto de 1 s + drain, levou ${elapsed} ms`);
  const events = parseNdjson(r.stdout);
  const stopped = events.find((e) => e.type === 'run_stopped');
  assert.ok(stopped, 'run_stopped');
  assert.match(String(stopped.reason ?? ''), /run-seconds 1/);
  assert.ok(events.find((e) => e.type === 'summary'), 'summary');
});

test('stdin reset_history responde history_reset; chat_input responde chat_sent', async () => {
  const flow = {
    version: 1,
    stopWhenSourcesDone: false,
    nodes: [
      { id: 'chat', type: 'input.chat', params: { initialMessage: '' } },
      { id: 'cap', type: 'sink.captions' },
    ],
    edges: [{ from: 'chat.out', to: 'cap.phrase' }],
  };
  const p = writeFlow(flow);
  const seen = [];
  const child = spawn(process.execPath, [CLI, p], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout; stdout: ' + out.slice(0, 500))); }, 15_000);
    child.stdout.on('data', (d) => {
      out += d;
      for (const l of String(d).split('\n')) if (l.trim()) seen.push(JSON.parse(l));
    });
    child.on('close', (code) => { clearTimeout(t); resolve(code); });
  });
  try {
    // espera o run assentar antes de falar no stdin
    await new Promise((r) => setTimeout(r, 700));
    child.stdin.write(JSON.stringify({ type: 'reset_history', nodeId: '*' }) + '\n');
    child.stdin.write(JSON.stringify({ type: 'chat_input', nodeId: '*', text: 'olá runner' }) + '\n');
    await new Promise((r) => setTimeout(r, 700));
    child.kill('SIGTERM');
    const code = await done;
    assert.equal(code, 0, 'SIGTERM deve encerrar com exit 0');
    assert.ok(seen.some((e) => e.type === 'history_reset' && e.nodeId === '*'), 'history_reset');
    assert.ok(seen.some((e) => e.type === 'chat_sent' && e.text === 'olá runner' && e.nodeId === 'chat'), 'chat_sent');
    assert.ok(seen.some((e) => e.type === 'caption' && String(e.text).includes('olá runner')), 'caption do chat');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* já morto */ }
  }
});

test('reasoning_content vira thought NDJSON cumulativo, sem poluir caption', async () => {
  const srv = await sseServer();
  const flow = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'pergunta' } },
      { id: 'llm', type: 'llm.omlx', params: { baseUrl: srv.url, model: 'm', enableThinking: true } },
      { id: 'cap', type: 'sink.captions' },
    ],
    edges: [
      { from: 'src.out', to: 'llm.in' },
      { from: 'llm.out', to: 'cap.in' },
    ],
  };
  try {
    const p = writeFlow(flow);
    const r = await runCli([p]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const events = parseNdjson(r.stdout);
    const thought = events.filter((e) => e.type === 'thought').at(-1);
    assert.equal(thought.thoughtId, 'llm:1');
    assert.equal(thought.text, 'Pensando');
    assert.equal(thought.final, true);
    assert.ok(events.filter((e) => e.type === 'thought').every((e) => e.text.length > 0));
    assert.equal(events.find((e) => e.type === 'caption' && e.final)?.text, 'Resposta');
  } finally {
    await srv.close();
  }
});

test('SIGTERM encerra em menos de 3 s (host usa esse prazo no /api/stop)', async () => {
  const p = writeFlow(toneFlow({ count: 1000, stopWhenSourcesDone: false, intervalMs: 50 }));
  const child = spawn(process.execPath, [CLI, p], { stdio: ['pipe', 'pipe', 'pipe'] });
  let exited = false;
  const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  await new Promise((r) => setTimeout(r, 500));
  const t0 = Date.now();
  child.kill('SIGTERM');
  const { code } = await Promise.race([
    closed,
    new Promise((_, rej) => setTimeout(() => rej(new Error('não morreu em 5 s após SIGTERM')), 5000)),
  ]);
  exited = true;
  const ms = Date.now() - t0;
  assert.ok(exited);
  assert.equal(code, 0, 'SIGTERM encerra com 0 (shutdown gracioso)');
  assert.ok(ms < 3000, `levou ${ms} ms`);
});

test('capture.ffmpeg com backend chat recebe stdin chat_input, emite chat_sent e caption via out_text, e encerra limpo no SIGTERM', async () => {
  const flow = {
    version: 1,
    stopWhenSourcesDone: false,
    nodes: [
      { id: 'inp', type: 'capture.ffmpeg', params: { backend: 'chat', sckPath: '/nao/existe/capture' } },
      { id: 'cap', type: 'sink.captions' },
    ],
    edges: [{ from: 'inp.out_text', to: 'cap.phrase' }],
  };
  const p = writeFlow(flow);
  const seen = [];
  const child = spawn(process.execPath, [CLI, p], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let buf = '';
  const waitForEvent = (pred, label, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const existing = seen.find(pred);
      if (existing) return resolve(existing);
      let iv;
      const t = setTimeout(() => {
        clearInterval(iv);
        reject(new Error(`timeout aguardando ${label}; stdout: ${out.slice(0, 500)}`));
      }, timeoutMs);
      iv = setInterval(() => {
        const hit = seen.find(pred);
        if (hit) {
          clearInterval(iv);
          clearTimeout(t);
          resolve(hit);
        }
      }, 20);
    });
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* já morto */ }
      reject(new Error(`timeout no close; stdout: ${out.slice(0, 500)}`));
    }, 15_000);
    child.stdout.on('data', (d) => {
      const s = String(d);
      out += s;
      buf += s;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (l) seen.push(JSON.parse(l));
      }
    });
    child.on('close', (code) => { clearTimeout(t); resolve(code); });
  });
  try {
    await waitForEvent((e) => e.type === 'run_started', 'run_started');
    child.stdin.write(JSON.stringify({ type: 'chat_input', nodeId: 'inp', text: 'olá capture unificado' }) + '\n');
    await waitForEvent(
      (e) => e.type === 'caption' && e.nodeId === 'cap' && String(e.text).includes('olá capture unificado'),
      'caption via out_text',
    );
    child.kill('SIGTERM');
    const code = await done;
    assert.equal(code, 0, 'SIGTERM deve encerrar com exit 0');
    assert.ok(
      seen.some((e) => e.type === 'chat_sent' && e.nodeId === 'inp' && e.text === 'olá capture unificado'),
      'chat_sent deve ser emitido para inp',
    );
    const cap = seen.find((e) => e.type === 'caption' && e.nodeId === 'cap' && e.final === true);
    assert.ok(cap, 'caption final deve ser emitida por cap');
    assert.equal(cap.text, 'olá capture unificado');
    assert.ok(cap.trace?.turnId, 'caption deve carregar trace.turnId');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* já morto */ }
  }
});

test('payloads grandes são truncados no results do summary (não estouram o host)', async () => {
  const big = 'x'.repeat(500);
  const p = writeFlow({
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 1, prefix: big } },
      { id: 'snk', type: 'sink.collect' },
    ],
    edges: [{ from: 'src.out', to: 'snk.phrase' }],
  });
  const r = await runCli([p]);
  assert.equal(r.code, 0);
  const summary = parseNdjson(r.stdout).find((e) => e.type === 'summary');
  const value = summary.results.snk[0];
  assert.ok(value.length <= 241, `esperado truncamento em 240, veio ${value.length}`);
  assert.ok(value.endsWith('…'));
});

test('gate_action com rejectionText registra a mensagem recusada no stream', async () => {
  const p = writeFlow({
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'pedido' } },
      { id: 'pipe', type: 'pipe.parcs' },
      { id: 'gate', type: 'human.approve', params: { mode: 'ask_all' } },
      { id: 'snk', type: 'sink.collect' },
    ],
    edges: [
      { from: 'src.out', to: 'pipe.in' },
      { from: 'pipe.out', to: 'gate.in' },
      { from: 'gate.out', to: 'snk.phrase' },
    ],
  });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, p], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout gate_rejected')); }, 15000);
    child.stdout.on('data', (d) => {
      out += String(d);
      if (out.includes('"type":"gate"') && !out.includes('"type":"gate_rejected"')) {
        child.stdin.write(JSON.stringify({ type: 'gate_action', nodeId: 'gate', text: null, rejectionText: 'use outro host' }) + '\n');
      }
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
  const events = parseNdjson(result.out);
  assert.ok(events.some((e) => e.type === 'gate'), 'gate foi pedido');
  const rejected = events.find((e) => e.type === 'gate_rejected');
  assert.equal(rejected?.text, 'use outro host', 'texto da recusa precisa chegar ao stream');
  assert.ok(!events.some((e) => e.type === 'execution'), 'recusa não executa comando');
});

test('apps/tui/flows contém apenas os 3 workflows canônicos e todos passam em validateFlow sem modo legado', () => {
  const flowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'tui', 'flows');
  const jsonFiles = readdirSync(flowsDir).filter((f) => !f.startsWith('.') && f.endsWith('.json')).sort();
  assert.deepEqual(jsonFiles, ['agente-workflows.json', 'entrevista.json', 'especialista-ti.json']);
  const reg = registerFaladorNodes(createRegistry())
    .register(sourceTone)
    .register(pipeDelay)
    .register(pipeParcs)
    .register(sinkCollect);
  for (const file of jsonFiles) {
    const raw = JSON.parse(readFileSync(join(flowsDir, file), 'utf-8'));
    const bindings = {};
    for (const n of raw.nodes ?? []) {
      if (n.type === 'sink.captions') bindings[n.id] = { __onCaption: () => {} };
      if (n.type === 'human.approve' || n.type === 'agent.tools' || n.type === 'exec.command') {
        bindings[n.id] = { ...(bindings[n.id] ?? {}), __gate: { request: async () => null } };
      }
    }
    const v = validateFlow({ ...raw, bindings }, reg);
    assert.equal(v.nodes.size, raw.nodes.length, `${file} deve validar sem erros`);
  }
});

test('human.approve.params.mode controla roteamento decision.llm -> human.approve em ask_all e bypass em approve_all', async () => {
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ answers: { route: { choice: 'auto', confidence: 0.99 } } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    const askFlowPath = writeFlow({
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'sugestao' } },
        { id: 'pipe', type: 'pipe.parcs' },
        {
          id: 'dec',
          type: 'decision.llm',
          params: { baseUrl, model: 'd1', mode: 'systemone', options: ['auto', 'humano'], defaultOption: 'humano' },
        },
        { id: 'out_auto', type: 'sink.captions', params: { mode: 'callback' } },
        { id: 'gate', type: 'human.approve', params: { mode: 'ask_all' } },
        { id: 'out_gate', type: 'sink.captions', params: { mode: 'callback' } },
      ],
      edges: [
        { from: 'src.out', to: 'pipe.in' },
        { from: 'pipe.out', to: 'dec.in' },
        { from: 'dec.auto', to: 'out_auto.in' },
        { from: 'dec.humano', to: 'gate.in' },
        { from: 'gate.out', to: 'out_gate.phrase' },
      ],
    });

    const askRes = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, askFlowPath], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let answered = false;
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout ask_all')); }, 15000);
      child.stdout.on('data', (d) => {
        out += String(d);
        if (!answered && out.includes('"type":"gate"')) {
          answered = true;
          child.stdin.write(JSON.stringify({ type: 'gate_action', nodeId: 'gate', text: 'REVISADO_A' }) + '\n');
        }
      });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
    const askEvents = parseNdjson(askRes.out);
    assert.ok(askEvents.some((e) => e.type === 'gate' && e.nodeId === 'gate'), 'ask_all deve abrir o gate');
    assert.ok(askEvents.some((e) => e.type === 'caption' && e.nodeId === 'out_gate' && e.text === 'REVISADO_A'));

    const srvHumano = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: { route: { choice: 'humano', confidence: 0.99 } } }));
    });
    await new Promise((r) => srvHumano.listen(0, '127.0.0.1', r));
    const urlHumano = `http://127.0.0.1:${srvHumano.address().port}`;
    try {
      const approveAllPath = writeFlow({
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'direto' } },
          { id: 'pipe', type: 'pipe.parcs' },
          {
            id: 'dec',
            type: 'decision.llm',
            params: { baseUrl: urlHumano, model: 'd1', mode: 'systemone', options: ['auto', 'humano'], defaultOption: 'humano' },
          },
          { id: 'out_auto', type: 'sink.captions', params: { mode: 'callback' } },
          { id: 'gate', type: 'human.approve', params: { mode: 'approve_all' } },
          { id: 'out_gate', type: 'sink.captions', params: { mode: 'callback' } },
        ],
        edges: [
          { from: 'src.out', to: 'pipe.in' },
          { from: 'pipe.out', to: 'dec.in' },
          { from: 'dec.auto', to: 'out_auto.in' },
          { from: 'dec.humano', to: 'gate.in' },
          { from: 'gate.out', to: 'out_gate.phrase' },
        ],
      });
      const appRes = await runCli([approveAllPath]);
      const appEvents = parseNdjson(appRes.stdout);
      assert.ok(!appEvents.some((e) => e.type === 'gate'), 'approve_all não deve abrir gate');
      assert.ok(appEvents.some((e) => e.type === 'caption' && e.nodeId === 'out_gate' && e.text === 'direto-1'));
    } finally {
      await new Promise((r) => srvHumano.close(r));
    }
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
