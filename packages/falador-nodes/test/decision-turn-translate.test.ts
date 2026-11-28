/**
 * decision-turn-translate.test.ts — decision.llm, turn.detector, translate.llm.
 * Fake HTTP local, zero deps.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { decisionLlm, turnDetector, translateLlm } from '../src/index.ts';
import type { NodeCtx, NodeRuntime } from '../../falador-graph/src/index.ts';

type AnyCtx = NodeCtx & {
  _emitted: Array<{ port: string; payload: unknown; opts?: any }>;
  _logs: Array<{ level: string; msg: string }>;
  _counters: Record<string, number>;
  _timers: Record<string, number[]>;
  _ac: AbortController;
};

function makeCtx(params: Record<string, unknown>, bindings: Record<string, unknown> = {}): AnyCtx {
  const emitted: Array<{ port: string; payload: unknown; opts?: any }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const counters: Record<string, number> = {};
  const timers: Record<string, number[]> = {};
  const ac = new AbortController();
  return {
    id: 'test-node', params, bindings, signal: ac.signal,
    _emitted: emitted, _logs: logs, _counters: counters, _timers: timers, _ac: ac,
    emit: async (port: string, payload: unknown, opts?: unknown) => { emitted.push({ port, payload, opts }); },
    emitControl: () => {}, isCancelled: () => false,
    metrics: {
      counter: (name: string, delta = 1) => { counters[name] = (counters[name] ?? 0) + delta; },
      timer: (name: string, ms: number) => { (timers[name] ??= []).push(ms); },
    },
    log: (level: string, msg: string) => { logs.push({ level, msg }); },
  } as unknown as AnyCtx;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) { if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout'); await delay(20); }
}

function httpServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => { const addr = srv.address() as AddressInfo; resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => srv.close(() => r())) }); });
  });
}

// ---- decision.llm ----------------------------------------------------------

describe('decision.llm', () => {
  test('valida params e outputsFor', () => {
    assert.ok(decisionLlm.validateParams!({ options: [] }).length > 0);
    assert.ok(decisionLlm.validateParams!({ options: ['ok', 'bad option'] }).length > 0);
    assert.ok(decisionLlm.validateParams!({ options: ['auto', 'human'], defaultOption: 'nope' }).length > 0);
    assert.equal(decisionLlm.validateParams!({ options: ['auto', 'human'], defaultOption: 'auto' }).length, 0);
    const outs = decisionLlm.outputsFor!({ options: ['a', 'b'] });
    assert.deepEqual(outs.map((o) => o.name), ['a', 'b', 'decider']);
    assert.deepEqual(outs.find((o) => o.name === 'decider'), { name: 'decider', type: 'decider', required: false });
  });

  test('modo chat: escolhe opção pelo texto e emite na porta correta com meta', async () => {
    const thoughts: Array<{ thoughtId: string; text: string; final: boolean }> = [];
    const srv = await httpServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"Revisão necessária"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"hu"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"man"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, model: 'm', mode: 'chat', options: ['auto', 'human'], defaultOption: 'auto' }, {
        __onThought: (ev: { thoughtId: string; text: string; final: boolean }) => thoughts.push(ev),
      });
      const node = decisionLlm.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'preciso revisar', final: true }, meta: { trace: { turnId: 't1' } } } as any);
      await waitFor(() => ctx._emitted.length >= 1, 3000);
      assert.equal(ctx._emitted[0].port, 'human');
      assert.equal((ctx._emitted[0].payload as any).final, true);
      assert.equal(ctx._emitted[0].opts?.meta?.decision, 'human');
      assert.ok((ctx._timers['decision.llm.ms']?.length ?? 0) >= 1);
      assert.equal(ctx._counters['decision.llm.human'], 1);
      assert.equal(thoughts.at(-1)?.text, 'Revisão necessária');
      assert.equal(thoughts.at(-1)?.final, true);
      assert.equal(thoughts.at(-1)?.thoughtId, 'test-node:1');
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('modo chat: sem match usa defaultOption; ignora parciais e control', async () => {
    const srv = await httpServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"xyz"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, model: 'm', mode: 'chat', options: ['auto', 'human'], defaultOption: 'auto' });
      const node = decisionLlm.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, control: true, payload: {} } as any);
      await node.onInput('in', { seq: 2, ts: 2, payload: { text: 'parcial', final: false } } as any);
      assert.equal(ctx._emitted.length, 0);
      await node.onInput('in', { seq: 3, ts: 3, payload: { text: 'decide', final: true } } as any);
      await waitFor(() => ctx._emitted.length >= 1, 3000);
      assert.equal(ctx._emitted[0].port, 'auto');
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('modo systemone: usa /v1/systemone, emite confidence/probabilities', async () => {
    const bodies: any[] = [];
    const srv = await httpServer((req, body, res) => {
      bodies.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ answers: { route: { choice: 'human', confidence: 0.91, probabilities: { auto: 0.09, human: 0.91 } } } }));
    });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, model: 'd1', mode: 'systemone', options: ['auto', 'human'], defaultOption: 'auto', criteria: { auto: 'safe', human: 'needs review' } });
      const node = decisionLlm.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'apagar banco', final: true } } as any);
      await waitFor(() => ctx._emitted.length >= 1, 3000);
      assert.equal(ctx._emitted[0].port, 'human');
      assert.equal(bodies[0].url, '/v1/systemone');
      assert.equal(bodies[0].body.questions.route.criteria.auto, 'safe');
      const dm = (ctx._emitted[0].payload as any).decision;
      assert.equal(dm.mode, 'systemone');
      assert.equal(dm.confidence, 0.91);
      assert.deepEqual(dm.probabilities, { auto: 0.09, human: 0.91 });
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('modo systemone: erro cai no defaultOption e loga', async () => {
    const srv = await httpServer((_req, _body, res) => { res.writeHead(500); res.end('bad'); });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, model: 'd1', mode: 'systemone', options: ['auto', 'human'], defaultOption: 'auto' });
      const node = decisionLlm.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'x', final: true } } as any);
      await waitFor(() => ctx._emitted.length >= 1, 3000);
      assert.equal(ctx._emitted[0].port, 'auto');
      assert.ok(ctx._logs.some((l) => l.level === 'error' && l.msg.includes('systemone')));
      await node.stop('done');
    } finally { await srv.close(); }
  });
});

// ---- turn.detector ---------------------------------------------------------

describe('turn.detector', () => {
  test('valida params', () => {
    assert.ok(turnDetector.validateParams!({ mode: 'bad' }).some((e) => e.path === 'params.mode'));
    assert.ok(turnDetector.validateParams!({ minWords: 0 }).some((e) => e.path === 'params.minWords'));
    assert.ok(turnDetector.validateParams!({ completeThreshold: 2 }).some((e) => e.path === 'params.completeThreshold'));
    assert.ok(turnDetector.validateParams!({ maxWaitMs: 0 }).some((e) => e.path === 'params.maxWaitMs'));
    assert.ok(turnDetector.validateParams!({ maxMergedTurns: 0 }).some((e) => e.path === 'params.maxMergedTurns'));
    assert.equal(turnDetector.validateParams!({ mode: 'systemone', minWords: 3, completeThreshold: 0.6, maxWaitMs: 1000, maxMergedTurns: 2 }).length, 0);
  });

  test('fast-path: termina com "?" e >=minWords fecha imediato sem HTTP', async () => {
    const srv = await httpServer((_req, _body, res) => { res.writeHead(500); res.end('should not call'); });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, mode: 'systemone', minWords: 3, maxWaitMs: 5000 });
      const node = turnDetector.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'como você está?', final: true } } as any);
      await waitFor(() => ctx._emitted.length >= 1, 1000);
      assert.equal((ctx._emitted[0].payload as any).final, true);
      assert.ok(String((ctx._emitted[0].payload as any).text).includes('como você está?'));
      assert.equal(ctx._counters['turn.detector.immediate'], 1);
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('parcial repassa preview e cancela wait; final curto arma timeout e flush por maxWaitMs', async () => {
    const ctx = makeCtx({ mode: 'heuristic', minWords: 5, maxWaitMs: 80 });
    const node = turnDetector.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'um dois', final: false } } as any);
    await waitFor(() => ctx._emitted.length >= 1, 1000);
    assert.equal((ctx._emitted[0].payload as any).final, false);
    assert.ok(String((ctx._emitted[0].payload as any).text).includes('um dois'));

    await node.onInput('in', { seq: 2, ts: 2, payload: { text: 'oi', final: true } } as any); // curto (<5 words)
    assert.equal(ctx._emitted.filter((e) => (e.payload as any).final === true).length, 0);
    await waitFor(() => ctx._emitted.some((e) => (e.payload as any).final === true), 2000);
    assert.equal(ctx._counters['turn.detector.timeoutFlush'], 1);
    await node.stop('done');
  });

  test('systemone: incomplete arma wait, complete faz flush imediato; falha de rede não derruba', async () => {
    let call = 0;
    const srv = await httpServer((_req, _body, res) => {
      call++;
      if (call === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ answers: { turn: { choice: 'incomplete', confidence: 0.9 } } }));
      } else if (call === 2) {
        res.writeHead(500); res.end('net fail');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ answers: { turn: { choice: 'complete', confidence: 0.99 } } }));
      }
    });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, mode: 'systemone', minWords: 2, maxWaitMs: 80, completeThreshold: 0.65 });
      const node = turnDetector.create(ctx) as NodeRuntime;
      await node.start();

      // 1) incomplete -> espera timeout
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'eu estava dizendo', final: true } } as any);
      await waitFor(() => ctx._emitted.some((e) => (e.payload as any).final === true), 2000);
      assert.ok((ctx._counters['turn.detector.timeoutFlush'] ?? 0) >= 1);

      // 2) falha de rede -> trata como incomplete, não crasha; flush por timeout
      const before = ctx._emitted.filter((e) => (e.payload as any).final).length;
      await node.onInput('in', { seq: 2, ts: 2, payload: { text: 'continua falando aqui', final: true } } as any);
      await waitFor(() => ctx._emitted.filter((e) => (e.payload as any).final).length > before, 2000);
      assert.ok(ctx._logs.some((l) => l.level === 'warn' && l.msg.includes('systemone fallback')));

      // 3) complete -> flush imediato
      const before2 = ctx._emitted.filter((e) => (e.payload as any).final).length;
      await node.onInput('in', { seq: 3, ts: 3, payload: { text: 'frase completa agora', final: true } } as any);
      await waitFor(() => ctx._emitted.filter((e) => (e.payload as any).final).length > before2, 2000);
      assert.ok((ctx._counters['turn.detector.immediate'] ?? 0) >= 1);
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('stop() faz flush do buffer pendente; onControl interrupt limpa wait', async () => {
    const ctx = makeCtx({ mode: 'heuristic', minWords: 10, maxWaitMs: 5000 });
    const node = turnDetector.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'curto', final: true } } as any);
    // buffer tem "curto" mas minWords não atingido e timer longo
    assert.equal(ctx._emitted.filter((e) => (e.payload as any).final).length, 0);
    node.onControl?.({ kind: 'interrupt', scope: 'node' } as any); // limpa timer, não apaga buffer
    await node.stop('done');
    // stop deve flushar buffer
    const finals = ctx._emitted.filter((e) => (e.payload as any).final === true);
    assert.ok(finals.some((e) => String((e.payload as any).text).includes('curto')));
  });
});

// ---- translate.llm ---------------------------------------------------------

describe('translate.llm', () => {
  test('valida params', () => {
    assert.ok(translateLlm.validateParams!({ baseUrl: 1 }).some((e) => e.path === 'params.baseUrl'));
    assert.ok(translateLlm.validateParams!({ targetLanguage: 1 }).some((e) => e.path === 'params.targetLanguage'));
    assert.ok(translateLlm.validateParams!({ temperature: 'x' }).some((e) => e.path === 'params.temperature'));
    assert.ok(translateLlm.validateParams!({ maxTokens: NaN }).some((e) => e.path === 'params.maxTokens'));
    assert.ok(translateLlm.validateParams!({ enableThinking: 'x' }).some((e) => e.path === 'params.enableThinking'));
    assert.equal(translateLlm.validateParams!({ baseUrl: 'http://x', model: 'm', targetLanguage: 'pt', temperature: 0, maxTokens: 10, enableThinking: false }).length, 0);
  });

  test('passthrough: targetLanguage desabilitado (-, none, off, vazio) emite sem HTTP', async () => {
    const srv = await httpServer((_req, _body, res) => { res.writeHead(500); res.end('should not be called'); });
    try {
      for (const targetLanguage of ['-', 'none', 'off', '', '  ']) {
        const ctx = makeCtx({ baseUrl: srv.url, targetLanguage, model: 'm' });
        const node = translateLlm.create(ctx) as NodeRuntime;
        await node.start();
        await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'hello', final: true }, meta: { k: 1 } } as any);
        await waitFor(() => ctx._emitted.length >= 1, 1000);
        assert.deepEqual(ctx._emitted[0].payload, { text: 'hello', final: true });
        assert.equal(ctx._emitted[0].opts?.meta?.k, 1);
        await node.stop('done');
      }
    } finally { await srv.close(); }
  });

  test('tradução normal via SSE emite parciais e final', async () => {
    const bodies: any[] = [];
    const thoughts: Array<{ thoughtId: string; text: string; final: boolean }> = [];
    const srv = await httpServer((_req, body, res) => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"Identificar idioma"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"<|mixed_start|>olá"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" mundo"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, model: 'm', targetLanguage: 'Portuguese' }, {
        __onThought: (ev: { thoughtId: string; text: string; final: boolean }) => thoughts.push(ev),
      });
      const node = translateLlm.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'hello world', final: true } } as any);
      await waitFor(() => ctx._emitted.some((e) => (e.payload as any)?.final === true), 3000);
      const finals = ctx._emitted.filter((e) => (e.payload as any)?.final === true);
      assert.equal(finals[finals.length - 1].payload.text, 'olá mundo');
      assert.ok(bodies[0].messages[0].content.includes('Portuguese'));
      assert.ok((ctx._timers['translate.llm.ttftMs']?.length ?? 0) >= 1);
      assert.ok((ctx._timers['translate.llm.totalMs']?.length ?? 0) >= 1);
      assert.equal(thoughts.at(-1)?.text, 'Identificar idioma');
      assert.equal(thoughts.at(-1)?.final, true);
      assert.equal(thoughts.at(-1)?.thoughtId, 'test-node:1');
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('parcial em parcs é ignorado; phrase com final:false em modo disabled passa direto', async () => {
    const ctx = makeCtx({ targetLanguage: '-', model: 'm' });
    const node = translateLlm.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('parcs', { seq: 1, ts: 1, payload: { text: 'partial', final: false } } as any);
    await waitFor(() => ctx._emitted.length >= 1, 1000);
    assert.equal((ctx._emitted[0].payload as any).final, false);
    await node.stop('done');
  });

  test('interrupt aborta sem final e incrementa contador', async () => {
    let release: (() => void) | null = null;
    const srv = await httpServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
      release = () => { res.write('data: [DONE]\n\n'); res.end(); };
      setTimeout(() => release?.(), 2000);
    });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, model: 'm', targetLanguage: 'Portuguese' });
      const node = translateLlm.create(ctx) as NodeRuntime;
      await node.start();
      const p = node.onInput('in', { seq: 1, ts: 1, payload: { text: 'hello', final: true } } as any);
      await waitFor(() => ctx._emitted.length >= 1, 3000);
      node.onControl?.({ kind: 'interrupt', scope: 'node' } as any);
      release?.();
      await p;
      assert.ok(!ctx._emitted.some((e) => (e.payload as any)?.final === true));
      assert.equal(ctx._counters['translate.llm.interrupted'], 1);
      await node.stop('done');
    } finally { await srv.close(); }
  });
});
