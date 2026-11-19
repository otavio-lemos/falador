// falador-nodes — testes unitários (fakes HTTP/SSE) + integração ao vivo (gate por probe TCP)
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import http from 'node:http';
import { existsSync } from 'node:fs';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  createRegistry,
  runGraph,
  sourceTone,
  pipeDelay,
  sinkCollect,
  type FlowSpec,
} from '../../falador-graph/src/index.ts';
import {
  llmOmlx,
  ttsSts,
  sinkCaptions,
  sinkPlayback,
  asrRealtime,
  captureFfmpeg,
  registerFaladorNodes,
  VOXTRAL_SNAPSHOT,
  postJsonBytes,
} from '../src/index.ts';
import type { NodeTypeDef } from '../../falador-graph/src/index.ts';

function reg() {
  return registerFaladorNodes(createRegistry())
    .register(sourceTone)
    .register(pipeDelay)
    .register(sinkCollect);
}

const probeTcp = (port: number, host = '127.0.0.1', timeoutMs = 800): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect({ host, port });
    const end = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });

/** Servidor HTTP fake com handler cru. */
function rawServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ url: string; close(): void }> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString(), res));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => srv.close() });
    });
  });
}
void rawServer; // usado quando serve

const WAV_MIN = Buffer.concat([
  Buffer.from('RIFF', 'ascii'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVE', 'ascii'),
  Buffer.from('fmt ', 'ascii'), Buffer.from([16, 0, 0, 0]), Buffer.from([1, 0, 1, 0]),
  Buffer.from([128, 187, 0, 0]), Buffer.from([0, 0, 0, 0]), Buffer.from([2, 0]), Buffer.from([16, 0]),
  Buffer.from('data', 'ascii'), Buffer.from([0, 0, 0, 0]),
]);

describe('falador-nodes — unitários (fake servers)', () => {
  test('N1: llm.omlx consome SSE e sai com final cumulativo', async () => {
    const requests: string[] = [];
    const srv = await new Promise<{ url: string; close(): void }>((resolve) => {
      const srv = http.createServer((req, res) => {
        let all = '';
        req.on('data', (c: Buffer) => (all += c));
        req.on('end', async () => {
          requests.push(all);
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const c of ['Ol', 'á mundo!']) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
            await new Promise((r) => setTimeout(r, 10));
          }
          res.write('data: [DONE]\n\n');
          res.end();
        });
      });
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as AddressInfo;
        resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => srv.close() });
      });
    });
    const collected = { received: [] as Array<{ payload: unknown }> };
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'Hello how are you today' } },
        { id: 'llm', type: 'llm.omlx', params: { baseUrl: srv.url } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'llm.in', capacity: 8, overflow: 'block' },
        { from: 'llm.out', to: 'snk.parcs', capacity: 64, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    };
    const rg = await runGraph(flow, reg());
    await rg.done;
    const parcs = collected.received.map((r) => r.payload) as Array<{ text: string; final: boolean }>;
    assert.ok(parcs.length >= 3, `espera 2 parciais + 1 final, veio ${parcs.length}`);
    assert.equal(parcs[0].text, 'Ol');
    assert.equal(parcs[1].text, 'Olá mundo!');
    const last = parcs[parcs.length - 1];
    assert.equal(last.text, 'Olá mundo!');
    assert.equal(last.final, true);
    assert.ok(requests[0].includes('enable_thinking'), 'chat_template_kwargs enable_thinking presente');
    srv.close();
  });

  test('N2: tts.sts sintetiza na phrase e emite audio_chunk WAV', async () => {
    let sentBody = '';
    const srv = await new Promise<{ url: string; close(): void }>((resolve) => {
      const s = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          sentBody = Buffer.concat(chunks).toString();
          res.writeHead(200, { 'content-type': 'audio/wav' });
          res.end(WAV_MIN);
        });
      });
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address() as AddressInfo;
        resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => s.close() });
      });
    });
    const collected = { received: [] as Array<{ payload: unknown }> };
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'good morning' } },
        { id: 'tts', type: 'tts.sts', params: { url: srv.url, language: 'English' } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'tts.phrase', capacity: 8, overflow: 'block' },
        { from: 'tts.out', to: 'snk.chunk', capacity: 8, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    };
    const rg = await runGraph(flow, reg());
    await rg.done;
    const chunks = collected.received as Array<{ payload: { format: string; sampleRateHz: number; data: Uint8Array } }>;
    assert.equal(chunks.length, 1, '1 chunk WAV');
    assert.equal(chunks[0].payload.format, 'wav');
    assert.equal(chunks[0].payload.sampleRateHz, 24000);
    assert.ok(chunks[0].payload.data.byteLength >= 44, 'WAV com header');
    assert.ok(sentBody.includes('good morning'), 'texto enviado ao sidecar');
    srv.close();
  });

  test('N3: params inválidos são rejeitados na montagem (V5)', async () => {
    await assert.rejects(
      () => runGraph(
        { version: 1, nodes: [{ id: 't', type: 'tts.sts', params: { sampleRateHz: -1 } }], edges: [] },
        reg(),
      ),
      (e: unknown) => String((e as Error).message).includes('INVALID_PARAM'),
    );
    await assert.rejects(
      () => runGraph(
        { version: 1, nodes: [{ id: 'l', type: 'llm.omlx', params: { template: 'nope' } }], edges: [] },
        createRegistry().register(llmOmlx),
      ),
      (e: unknown) => String((e as Error).message).includes('INVALID_PARAM'),
    );
  });
});

describe('falador-nodes — integração ao vivo (gate por porta)', () => {
  test('N4: llm.omlx + tts.sts encadeados no omlx/sidecar reais', async () => {
    const llmUp = await probeTcp(8080);
    const ttsUp = await probeTcp(8091);
    if (!llmUp || !ttsUp) return; // serviços residentes fora: pula
    const collected = { received: [] as Array<{ payload: unknown }> };
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 1, prefix: 'The engine is finally working.' } },
        { id: 'llm', type: 'llm.omlx', params: { temperature: 0, maxTokens: 60 } },
        { id: 'tts', type: 'tts.sts', params: { language: 'Brazilian Portuguese' } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'llm.in', capacity: 8, overflow: 'block' },
        { from: 'llm.out', to: 'tts.in', capacity: 64, overflow: 'block' },
        { from: 'tts.out', to: 'snk.chunk', capacity: 8, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    };
    const rg = await runGraph(flow, reg());
    await rg.done;
    const s = rg.snapshot();
    assert.equal(s.nodes.llm.errored, false, 'llm sem erro');
    assert.equal(s.nodes.tts.errored, false, 'tts sem erro');
    const chunks = collected.received as Array<{ payload: { format: string; data: Uint8Array } }>;
    assert.ok(chunks.length >= 1, 'pelo menos 1 chunk WAV do lado real');
    assert.ok(chunks[chunks.length - 1].payload.data.byteLength > 1000, 'WAV real com fala');
  });

  test('N6: asr.realtime ao vivo — fala EN (via sidecar TTS) vira texto streaming no WS :8090', async () => {
    const asrUp = await probeTcp(8090);
    const ttsUp = await probeTcp(8091);
    if (!asrUp || !ttsUp) return; // serviços fora: pula
    const wav = await postJsonBytes(
      'http://127.0.0.1:8091/tts',
      { text: 'Hello, this is a live speech recognition test.', language: 'English', voice: 'female', sample_rate: 16000 },
      120_000,
    );
    const pcm = wav.subarray(44); // pula header WAV de 44 bytes
    assert.ok(pcm.byteLength > 16_000, 'fala de referência gerada');

    // produtor PCM em ritmo de microfone real (100 ms/frame); para o run no fim
    let stopRun: ((r: string) => void) | null = null;
    const produtor: NodeTypeDef = {
      type: 'produtor.pcm',
      sourceOnly: true,
      paramNames: [],
      inputs: [],
      outputs: [{ name: 'out', type: 'pcm16k', required: false }],
      create: (ctx) => ({
        async start() {
          const frame = 3200; // 100 ms @16k s16le
          // fala: frames reais
          for (let i = 0; i < pcm.length; i += frame) {
            if (ctx.signal.aborted) return;
            await ctx.emit('out', pcm.subarray(i, i + frame));
            await new Promise((r) => setTimeout(r, 100));
          }
          // CRÍTICO: o VAD do server só roda quando chegam appends — mic real manda
          // silêncio também. Sem isso, o turno NUNCA fecha e o 'completed' não vem.
          const silence = new Uint8Array(frame); // zeros = silêncio
          for (let k = 0; k < 40; k++) { // 4 s de silêncio
            if (ctx.signal.aborted) return;
            await ctx.emit('out', silence);
            await new Promise((r) => setTimeout(r, 100));
          }
          // espera a transcrição fechar (carga fria do modelo no server pode levar ~10 s)
          for (let k = 0; k < 50; k++) { // até 25 s
            if (ctx.signal.aborted) return;
            const gotFinal = collected.received.some((r) =>
              (r as { payload?: { final?: boolean } })?.payload?.final === true);
            if (gotFinal) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          setTimeout(() => stopRun?.('fim do teste'), 100);
        },
        async onInput() {},
        async stop() {},
      }),
    };
    const collected = { received: [] as Array<{ payload: unknown }> };
    const registry = registerFaladorNodes(createRegistry()).register(sinkCollect).register(produtor);
    const flow: FlowSpec = {
      version: 1,
      nodes: [
        { id: 'pcmsrc', type: 'produtor.pcm' },
        { id: 'asr', type: 'asr.realtime', params: { model: VOXTRAL_SNAPSHOT, serverVad: true, inputRate: 16000 } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'pcmsrc.out', to: 'asr.in', capacity: 128, overflow: 'block' },
        { from: 'asr.out', to: 'snk.parcs', capacity: 128, overflow: 'drop_oldest' },
      ],
      bindings: { snk: { __collect: collected } },
    };
    const rg = await runGraph(flow, registry);
    stopRun = (reason) => void rg.stop(reason);

    const parcs = collected.received
      .map((r) => (r as { payload: unknown }).payload)
      .filter((p) => p && typeof p === 'object' && 'text' in (p as object)) as Array<{ text: string; final: boolean }>;
    if (process.env.FALADOR_ASR_DEBUG) console.log('EVENTS', JSON.stringify(rg.eventsSnapshot()));
    const finals = parcs.filter((p) => p.final).map((p) => p.text);
    assert.ok(finals.length >= 1, `espera transcrição finalizada; veio ${parcs.length} envelopes`);
    assert.match(finals.join(' ').toLowerCase(), /live|speech|recognition|test/, `texto EN reconhecido: "${finals.join(' ')}"`);
    assert.ok(parcs.some((p) => !p.final), 'houve parciais antes do final (streaming de verdade)');
  });
});

test('N5: catálogo de nós reais registrado', () => {
  const r = reg();
  for (const t of ['llm.omlx', 'tts.sts', 'asr.realtime', 'capture.ffmpeg', 'sink.captions', 'sink.playback']) {
    assert.ok(r.has(t), `tipo ${t} registrado`);
  }
});

// N7 — capture.ffmpeg com MIC REAL (gate: FALADOR_MIC_TEST=1 — grava 2 s do mic default).
// Rodar: FALADOR_MIC_TEST=1 npm test
const N7_UP = process.env.FALADOR_MIC_TEST === '1' && existsSync('/opt/homebrew/bin/ffmpeg');
test('N7: capture.ffmpeg — mic real produz frames pcm16k contínuos (avfoundation)', { skip: !N7_UP }, async () => {
  const collected = { received: [] as Array<{ payload: unknown }> };
  const counter: NodeTypeDef = {
    type: 'contador.pcm',
    paramNames: [],
    inputs: [{ name: 'in', type: 'pcm16k' }],
    outputs: [],
    create: (ctx) => ({
      async start() {},
      async onInput(_port, msg) {
        if (msg.control) return;
        collected.received.push(msg);
      },
      async stop() {},
    }),
  };
  const registry = createRegistry().register(captureFfmpeg).register(counter);
  const flow: FlowSpec = {
    version: 1,
    nodes: [{ id: 'mic', type: 'capture.ffmpeg', params: { input: ':1', chunkMs: 80 } }, { id: 'cnt', type: 'contador.pcm' }],
    edges: [{ from: 'mic.out', to: 'cnt.in', capacity: 256, overflow: 'drop_oldest' }],
  };
  const rg = await runGraph(flow, registry, { stopWhenSourcesDone: false });
  await new Promise((r) => setTimeout(r, 2000)); // 2 s de captura
  await rg.stop('fim do N7');
  const sizes = collected.received
    .map((r) => (r as { payload?: Uint8Array }).payload)
    .filter((p): p is Uint8Array => p instanceof Uint8Array);
  assert.ok(sizes.length >= 10, `espera ~25 chunks em 2 s (80 ms); veio ${sizes.length}`);
  assert.ok(sizes.every((b) => b.byteLength === 2560), 'chunk 80 ms @16k s16le = 2560 bytes');
  // conteúdo: ambiente silencioso e/ou mic físico não exposto ao ffmpeg (TCC) —
  // honesto: reporta energia média; continuidade estrutural é o que se assevera.
  let energy = 0;
  for (const b of sizes) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i + 1 < b.byteLength; i += 2) energy += Math.abs(dv.getInt16(i, true));
  }
  console.log(`[N7] chunks=${sizes.length} energia_média=${(energy / Math.max(1, sizes.length) / 2560).toFixed(2)} (0 = silêncio no device)`);
  void asrRealtime; void sinkCaptions; void sinkPlayback;
});

void asrRealtime; void captureFfmpeg; void sinkCaptions; void sinkPlayback; // usados nos próximos passos (TUI/fluxo completo)
