// Testes para translate.llm, human.approve (mode auto/manual) e asr.lfm3 (targetLanguage)
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { describe } from 'node:test';
import {
  createRegistry,
  runGraph,
  sourceTone,
  pipeParcs,
  sinkCollect,
  type FlowSpec,
} from '../../falador-graph/src/index.ts';
import { registerFaladorNodes } from '../src/index.ts';
import { validateFlow } from '../../falador-graph/src/index.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NodeTypeDef } from '../../falador-graph/src/index.ts';

function reg() {
  return registerFaladorNodes(createRegistry())
    .register(sourceTone)
    .register(pipeParcs)
    .register(sinkCollect);
}

describe('translate.llm, human.approve e asr.lfm3', () => {
  test('assistente-entrevista: asr.final -> assistente.in valida e não força inglês', () => {
    const raw = JSON.parse(readFileSync(fileURLToPath(new URL('../../../apps/tui/flows/assistente-entrevista.json', import.meta.url)), 'utf-8')) as FlowSpec;
    const bindings: Record<string, Record<string, unknown>> = {};
    for (const n of raw.nodes) {
      if (n.type === 'sink.captions') bindings[n.id] = { __onCaption: () => {} };
      if (n.type === 'human.approve') bindings[n.id] = { __gate: { request: async () => null } };
    }
    const v = validateFlow({ ...raw, bindings }, reg());
    assert.equal(v.nodes.size, raw.nodes.length);
    assert.ok(raw.edges.some((e) => e.from === 'asr.final' && e.to === 'assistente.in'));
    assert.ok(!raw.edges.some((e) => e.to === 'assistente.parcs'));
    const asst = raw.nodes.find((n) => n.id === 'assistente')!;
    assert.equal(asst.params?.template, undefined);
    assert.ok(!/em INGLÊS/.test(String(asst.params?.system)));
  });

  test('translate.llm desabilitado ("", "-" ou model="-") faz passthrough de parciais e finais sem HTTP', async () => {
    for (const params of [
      { baseUrl: 'http://127.0.0.1:1', targetLanguage: '' },
      { baseUrl: 'http://127.0.0.1:1', targetLanguage: '-' },
      { baseUrl: 'http://127.0.0.1:1', model: '-', targetLanguage: 'Portuguese' },
    ]) {
      const collected = { received: [] as Array<{ payload: unknown }> };
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'hello world' } },
          { id: 'pp', type: 'pipe.parcs', params: {} },
          { id: 'tr', type: 'translate.llm', params },
          { id: 'snk', type: 'sink.collect' },
        ],
        edges: [
          { from: 'src.out', to: 'pp.in', capacity: 8, overflow: 'block' },
          { from: 'pp.out', to: 'tr.parcs', capacity: 8, overflow: 'block' },
          { from: 'tr.out', to: 'snk.parcs', capacity: 8, overflow: 'block' },
        ],
        bindings: { snk: { __collect: collected } },
      };

      const rg = await runGraph(flow, reg());
      await rg.done;
      const snap = rg.snapshot();
      assert.equal(snap.nodes.tr.errors, 0, 'passthrough não pode chamar HTTP nem errar');
      const payloads = collected.received.map((r) => r.payload as { text: string; final: boolean });
      assert.ok(payloads.length >= 2, `esperado parciais + final, veio ${payloads.length}`);
      assert.ok(payloads.some((p) => p.final === false), 'parciais devem passar direto quando desabilitado');
      const finalMsg = payloads.find((p) => p.final === true);
      assert.equal(finalMsg?.text, 'hello world-1');
    }
  });

  test('translate.llm ativo chama omlx SSE com model, idioma no system e enable_thinking=false', async () => {
    let seenBody: Record<string, unknown> | null = null;
    const srv = await new Promise<{ url: string; close(): Promise<void> }>((resolve) => {
      const s = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', () => {
          seenBody = JSON.parse(raw) as Record<string, unknown>;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Olá ' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'mundo' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((r) => s.close(() => r())),
        });
      });
    });

    try {
      const collected = { received: [] as Array<{ payload: unknown }> };
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'hello world' } },
          { id: 'tr', type: 'translate.llm', params: { baseUrl: srv.url, model: 'Qwen/Qwen3-8B', targetLanguage: 'Portuguese' } },
          { id: 'snk', type: 'sink.collect' },
        ],
        edges: [
          { from: 'src.out', to: 'tr.in', capacity: 8, overflow: 'block' },
          { from: 'tr.out', to: 'snk.parcs', capacity: 8, overflow: 'block' },
        ],
        bindings: { snk: { __collect: collected } },
      };

      const rg = await runGraph(flow, reg());
      await rg.done;
      assert.ok(seenBody, 'deve ter feito requisição HTTP');
      assert.equal(seenBody.model, 'Qwen/Qwen3-8B');
      assert.deepEqual(seenBody.chat_template_kwargs, { enable_thinking: false });
      const msgs = seenBody.messages as Array<{ role: string; content: string }>;
      assert.equal(msgs[0].role, 'system');
      assert.ok(msgs[0].content.includes('Portuguese'));
      assert.equal(msgs[1].content, 'hello world-1');

      const payloads = collected.received.map((r) => r.payload as { text: string; final: boolean });
      assert.equal(payloads.filter((p) => !p.final).length, 2);
      const finalMsg = payloads.find((p) => p.final);
      assert.equal(finalMsg?.text, 'Olá mundo');
    } finally {
      await srv.close();
    }
  });

  test('human.approve com mode="auto" emite direto sem chamar __gate; mode="manual" chama __gate', async () => {
    let autoGateCalls = 0;
    const autoCollected = { received: [] as Array<{ payload: unknown }> };
    const autoFlow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'resp' } },
        { id: 'pp', type: 'pipe.parcs', params: {} },
        { id: 'app', type: 'human.approve', params: { mode: 'auto' } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'pp.in', capacity: 8, overflow: 'block' },
        { from: 'pp.out', to: 'app.in', capacity: 8, overflow: 'block' },
        { from: 'app.out', to: 'snk.phrase', capacity: 8, overflow: 'block' },
      ],
      bindings: {
        app: { __gate: { request: async () => { autoGateCalls++; return 'NAO'; } } },
        snk: { __collect: autoCollected },
      },
    };
    const rgAuto = await runGraph(autoFlow, reg());
    await rgAuto.done;
    const snapAuto = rgAuto.snapshot();
    assert.equal(autoGateCalls, 0);
    assert.equal(snapAuto.nodes.app.counters['human.approve.bypassed'], 1);
    assert.deepEqual(autoCollected.received.map((r) => r.payload), ['resp-1']);

    let manualGateCalls = 0;
    const manualCollected = { received: [] as Array<{ payload: unknown }> };
    const manualFlow: FlowSpec = {
      ...autoFlow,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'resp' } },
        { id: 'pp', type: 'pipe.parcs', params: {} },
        { id: 'app', type: 'human.approve', params: { mode: 'manual' } },
        { id: 'snk', type: 'sink.collect' },
      ],
      bindings: {
        app: { __gate: { request: async (txt: string) => { manualGateCalls++; return `APROVADO:${txt}`; } } },
        snk: { __collect: manualCollected },
      },
    };
    const rgManual = await runGraph(manualFlow, reg());
    await rgManual.done;
    assert.equal(manualGateCalls, 1);
    assert.deepEqual(manualCollected.received.map((r) => r.payload), ['APROVADO:resp-1']);
  });

  test('asr.lfm3 ajusta instruction conforme targetLanguage ("-" vs "English")', async () => {
    const seenInstructions: string[] = [];
    const srv = await new Promise<{ url: string; close(): Promise<void> }>((resolve) => {
      const s = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (d) => (raw += d));
        req.on('end', () => {
          const parsed = JSON.parse(raw) as { instruction?: string };
          seenInstructions.push(parsed.instruction ?? '');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ text: 'ok' }));
        });
      });
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${addr.port}`,
          close: () => new Promise((r) => s.close(() => r())),
        });
      });
    });

    const pcmProd: NodeTypeDef = {
      type: 'test.pcm',
      paramNames: [],
      inputs: [],
      outputs: [{ name: 'out', type: 'pcm16k' }],
      sourceOnly: true,
      create: (ctx) => ({
        async start() {
          await ctx.emit('out', new Uint8Array(640));
        },
        async onInput() {},
        async stop() {},
      }),
    };

    try {
      for (const targetLanguage of ['-', 'English']) {
        const flow: FlowSpec = {
          version: 1,
          stopWhenSourcesDone: true,
          nodes: [
            { id: 'src', type: 'test.pcm', params: {} },
            { id: 'asr', type: 'asr.lfm3', params: { url: srv.url, targetLanguage, flushSec: 10 } },
            { id: 'snk', type: 'sink.collect' },
          ],
          edges: [
            { from: 'src.out', to: 'asr.in', capacity: 8, overflow: 'block' },
            { from: 'asr.out', to: 'snk.parcs', capacity: 8, overflow: 'block' },
          ],
          bindings: { snk: { __collect: { received: [] } } },
        };
        const rg = await runGraph(flow, reg().register(pcmProd));
        await rg.done;
      }
      assert.equal(seenInstructions.length, 2);
      assert.match(seenInstructions[0], /verbatim in its original language/i);
      assert.match(seenInstructions[1], /translate it to English/i);
    } finally {
      await srv.close();
    }
  });
});
