// falador-nodes — testes unitários das Fases 1–5 do ADR-006 (mocks HTTP/WS em memória, zero deps)
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import {
  createRegistry,
  runGraph,
  sinkCollect,
  type ControlMsg,
  type FlowSpec,
  type NodeTypeDef,
} from '../../falador-graph/src/index.ts';
import { llmOmlx } from '../src/llm-omlx.ts';
import { asrRealtime } from '../src/asr-realtime.ts';
import { turnDetector } from '../src/turn-detector.ts';
import { decisionLlm } from '../src/decision-llm.ts';
import { humanApprove, type GateMeta } from '../src/human-approve.ts';
import { sinkCaptions } from '../src/sinks.ts';
import type { TraceMeta } from '../src/trace.ts';

// ---- Helpers: HTTP & RFC-6455 WebSocket mock (zero deps) ------------------

function httpServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

interface MockWsConn {
  send(obj: unknown): void;
  close(): void;
  received: Record<string, unknown>[];
}

function wsEncodeText(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload]);
  }
  if (len < 65536) {
    const hdr = Buffer.alloc(4);
    hdr[0] = 0x81;
    hdr[1] = 126;
    hdr.writeUInt16BE(len, 2);
    return Buffer.concat([hdr, payload]);
  }
  const hdr = Buffer.alloc(10);
  hdr[0] = 0x81;
  hdr[1] = 127;
  hdr.writeBigUInt64BE(BigInt(len), 2);
  return Buffer.concat([hdr, payload]);
}

function wsMockServer(opts: {
  acceptDelayMs?: number;
  onConnection?: (conn: MockWsConn) => void;
} = {}): Promise<{ url: string; connections: MockWsConn[]; close(): Promise<void> }> {
  const connections: MockWsConn[] = [];
  const sockets = new Set<Socket>();
  const srv = http.createServer();

  srv.on('upgrade', (req, socket) => {
    const acceptNow = () => {
      if (socket.destroyed) return;
      sockets.add(socket);
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );

      const conn: MockWsConn = {
        received: [],
        send(obj: unknown) {
          if (!socket.destroyed) socket.write(wsEncodeText(JSON.stringify(obj)));
        },
        close() {
          if (!socket.destroyed) socket.end(Buffer.from([0x88, 0x00]));
        },
      };
      connections.push(conn);

      let buf = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          const masked = (buf[1] & 0x80) !== 0;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (buf.length < off + maskLen + len) return;
          const mask = masked ? buf.subarray(off, off + 4) : null;
          const payload = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len));
          if (mask) {
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
          }
          buf = buf.subarray(off + maskLen + len);
          if (opcode === 0x08) {
            socket.end();
            return;
          }
          if (opcode === 0x01) {
            try {
              conn.received.push(JSON.parse(payload.toString('utf8')) as Record<string, unknown>);
            } catch {
              /* ignore */
            }
          }
        }
      });
      socket.on('close', () => sockets.delete(socket));
      opts.onConnection?.(conn);
    };

    if (opts.acceptDelayMs && opts.acceptDelayMs > 0) {
      setTimeout(acceptNow, opts.acceptDelayMs);
    } else {
      acceptNow();
    }
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${addr.port}/v1/realtime`,
        connections,
        close: async () => {
          for (const s of sockets) s.destroy();
          await new Promise<void>((r) => srv.close(() => r()));
        },
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeManualPhraseSource(type = 'source.manual'): {
  def: NodeTypeDef;
  push: (text: string, opts?: { meta?: Record<string, unknown> }) => Promise<void>;
  interrupt: (reason?: string) => void;
  finish: () => void;
} {
  let emitFn: ((p: string, payload: unknown, opts?: { meta?: Record<string, unknown> }) => Promise<void>) | null = null;
  let ctrlFn: ((p: string, c: ControlMsg) => void) | null = null;
  let doneResolve: (() => void) | null = null;
  const donePromise = new Promise<void>((r) => {
    doneResolve = r;
  });

  const def: NodeTypeDef = {
    type,
    sourceOnly: true,
    paramNames: [],
    inputs: [],
    outputs: [{ name: 'out', type: 'phrase', required: false }],
    create: (ctx) => ({
      async start() {
        emitFn = (p, payload, opts) => ctx.emit(p, payload, opts);
        ctrlFn = (p, c) => ctx.emitControl(p, c);
        await donePromise;
      },
      async onInput() {},
      async stop() {
        doneResolve?.();
      },
    }),
  };

  return {
    def,
    push: async (text, opts) => {
      while (!emitFn) await sleep(5);
      await emitFn('out', text, opts);
    },
    interrupt: (reason = 'test_interrupt') => {
      ctrlFn?.('out', { kind: 'interrupt', scope: 'port', reason });
    },
    finish: () => doneResolve?.(),
  };
}

function makeManualParcsSource(type = 'source.parcs'): {
  def: NodeTypeDef;
  push: (text: string, final: boolean, meta?: Record<string, unknown>) => Promise<void>;
  interrupt: (reason?: string) => void;
  finish: () => void;
} {
  let emitFn: ((p: string, payload: unknown, opts?: { meta?: Record<string, unknown> }) => Promise<void>) | null = null;
  let ctrlFn: ((p: string, c: ControlMsg) => void) | null = null;
  let doneResolve: (() => void) | null = null;
  const donePromise = new Promise<void>((r) => {
    doneResolve = r;
  });

  const def: NodeTypeDef = {
    type,
    sourceOnly: true,
    paramNames: [],
    inputs: [],
    outputs: [{ name: 'out', type: 'tokens_parcial', required: false }],
    create: (ctx) => ({
      async start() {
        emitFn = (p, payload, opts) => ctx.emit(p, payload, opts);
        ctrlFn = (p, c) => ctx.emitControl(p, c);
        await donePromise;
      },
      async onInput() {},
      async stop() {
        doneResolve?.();
      },
    }),
  };

  return {
    def,
    push: async (text, final, meta) => {
      while (!emitFn) await sleep(5);
      await emitFn('out', { text, final }, meta ? { meta } : undefined);
    },
    interrupt: (reason = 'test_interrupt') => {
      ctrlFn?.('out', { kind: 'interrupt', scope: 'port', reason });
    },
    finish: () => doneResolve?.(),
  };
}

// ---- Suite ----------------------------------------------------------------

describe('ADR-006 Fases 1–5 — streaming nodes', () => {
  test('S1: llm.omlx com historyMax: 0 não acumula histórico entre chamadas', async () => {
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const srv = await httpServer((_req, body, res) => {
      seenBodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `resp-${seenBodies.length}` } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const src = makeManualPhraseSource();
    const collected = { received: [] as Array<{ payload: unknown }> };
    const reg = createRegistry().register(src.def).register(llmOmlx).register(sinkCollect);
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.manual' },
        { id: 'llm', type: 'llm.omlx', params: { baseUrl: srv.url, system: 'SYS', historyMax: 0 } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'llm.in', capacity: 8, overflow: 'block' },
        { from: 'llm.out', to: 'snk.parcs', capacity: 32, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    };

    const rgPromise = runGraph(flow, reg);
    await src.push('primeira pergunta secreta');
    await sleep(40);
    await src.push('segunda pergunta');
    src.finish();
    const rg = await rgPromise;
    await rg.done;
    await srv.close();

    assert.equal(seenBodies.length, 2);
    assert.equal(seenBodies[1].messages.length, 2, 'apenas system + 2ª pergunta');
    const serialized = JSON.stringify(seenBodies[1].messages);
    assert.ok(!serialized.includes('primeira pergunta secreta'), '2ª chamada não pode conter 1ª fala');
    assert.ok(!serialized.includes('resp-1'), '2ª chamada não pode conter 1ª resposta');
  });

  test('S2: llm.omlx com historyMax: 10 e historyCharBudget: 100 poda pares antigos', async () => {
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const srv = await httpServer((_req, body, res) => {
      seenBodies.push(JSON.parse(body));
      const idx = seenBodies.length;
      const reply = `R${idx}-` + 'x'.repeat(30); // ~33 chars
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const src = makeManualPhraseSource();
    const collected = { received: [] as Array<{ payload: unknown }> };
    const reg = createRegistry().register(src.def).register(llmOmlx).register(sinkCollect);
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.manual' },
        {
          id: 'llm',
          type: 'llm.omlx',
          params: { baseUrl: srv.url, system: 'SYS', historyMax: 10, historyCharBudget: 100 },
        },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'llm.in', capacity: 8, overflow: 'block' },
        { from: 'llm.out', to: 'snk.parcs', capacity: 64, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    };

    const rgPromise = runGraph(flow, reg);
    await src.push('Q1-' + 'a'.repeat(30)); // par 1: ~66 chars
    await sleep(30);
    await src.push('Q2-' + 'b'.repeat(30)); // par 2: ~66 chars → total 132 > 100, poda par 1
    await sleep(30);
    await src.push('Q3-' + 'c'.repeat(30)); // par 3
    src.finish();
    const rg = await rgPromise;
    await rg.done;
    await srv.close();

    assert.equal(seenBodies.length, 3);
    const msgs3 = seenBodies[2].messages;
    const hist3 = msgs3.slice(1, -1); // exclui system e user atual
    const histChars = hist3.reduce((s, m) => s + m.content.length, 0);
    assert.ok(histChars <= 100, `histórico deve respeitar orçamento 100 chars, veio ${histChars}`);
    assert.ok(!JSON.stringify(hist3).includes('Q1-'), 'par 1 (mais antigo) deve ter sido podado');
    assert.ok(JSON.stringify(hist3).includes('Q2-'), 'par 2 (recente) deve permanecer');
  });

  test('S3: llm.omlx interrupt durante streaming aborta fetch, não emite final:true nem polui history', async () => {
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let abortedOnServer = false;
    let reqCount = 0;

    const srv = await httpServer((req, body, res) => {
      reqCount++;
      seenBodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (reqCount === 1) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'PARCIAL-ABORTADO' } }] })}\n\n`);
        const t = setTimeout(() => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '-NAO-DEVIA-CHEGAR' } }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }, 1500);
        req.on('close', () => {
          abortedOnServer = true;
          clearTimeout(t);
        });
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'RESPOSTA-LIMPA' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });

    const src = makeManualPhraseSource();
    const collected = { received: [] as Array<{ payload: unknown }> };
    const reg = createRegistry().register(src.def).register(llmOmlx).register(sinkCollect);
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: false,
      nodes: [
        { id: 'src', type: 'source.manual' },
        { id: 'llm', type: 'llm.omlx', params: { baseUrl: srv.url, historyMax: 5 } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'llm.in', capacity: 8, overflow: 'block' },
        { from: 'llm.out', to: 'snk.parcs', capacity: 64, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    };

    const rgPromise = runGraph(flow, reg);
    await src.push('pergunta interrompida');
    // Espera o primeiro token parcial chegar
    for (let i = 0; i < 40 && collected.received.length === 0; i++) await sleep(10);
    const tInterrupt = Date.now();
    src.interrupt('speech_started');
    await sleep(60);
    const abortMs = Date.now() - tInterrupt;
    assert.ok(abortedOnServer, 'servidor deve detectar abort do fetch');
    assert.ok(abortMs < 500, `abort deve ser rápido, levou ${abortMs}ms`);

    // Envia 2ª pergunta após interrupt
    await src.push('nova pergunta limpa');
    for (let i = 0; i < 50; i++) {
      const hasCleanFinal = collected.received.some(
        (r) => (r.payload as { text?: string; final?: boolean })?.text === 'RESPOSTA-LIMPA' && (r.payload as { final?: boolean })?.final === true,
      );
      if (hasCleanFinal) break;
      await sleep(10);
    }

    src.finish();
    const rg = await rgPromise;
    const snap = rg.snapshot();
    await rg.stop('done');
    await srv.close();

    const finals = collected.received
      .map((r) => r.payload as { text: string; final: boolean })
      .filter((p) => p.final);
    assert.equal(finals.length, 1, 'apenas a 2ª resposta deve emitir final:true');
    assert.equal(finals[0].text, 'RESPOSTA-LIMPA');
    assert.equal(snap.nodes.llm.counters['llm.omlx.interrupted'], 1);
    assert.equal(seenBodies.length, 2);
    assert.equal(seenBodies[1].messages.length, 1, 'turno interrompido não deve poluir o history');
  });

  test('S4: llm.omlx resetHistory limpa histórico após 3 turnos + useContext injeta RAG no system', async () => {
    const seenBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const srv = await httpServer((_req, body, res) => {
      seenBodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `ok-${seenBodies.length}` } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    let resetFn: (() => void) | null = null;
    const src = makeManualPhraseSource();
    const collected = { received: [] as Array<{ payload: unknown }> };
    const reg = createRegistry().register(src.def).register(llmOmlx).register(sinkCollect);
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: false,
      nodes: [
        { id: 'src', type: 'source.manual' },
        {
          id: 'llm',
          type: 'llm.omlx',
          params: {
            baseUrl: srv.url,
            system: 'BASE_SYS',
            historyMax: 10,
            useContext: true,
            contextTopK: 2,
            contextTags: ['ops'],
            contextMaxChars: 500,
          },
        },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'llm.in', capacity: 8, overflow: 'block' },
        { from: 'llm.out', to: 'snk.parcs', capacity: 64, overflow: 'block' },
      ],
      bindings: {
        llm: {
          __registerReset: (fn: () => void) => {
            resetFn = fn;
          },
          __getContext: (q: string) => `Runbook para: ${q}`,
        },
        snk: { __collect: collected },
      },
    };

    const rgPromise = runGraph(flow, reg);
    for (const q of ['turno 1', 'turno 2', 'turno 3']) {
      await src.push(q);
      await sleep(35);
    }
    assert.ok(resetFn, '__registerReset deve ter registrado resetFn');
    assert.equal(seenBodies[2].messages.length, 6, '3º turno tem system + 2 pares + user atual');

    resetFn!();
    await src.push('turno 4 pós reset');
    for (let i = 0; i < 40 && seenBodies.length < 4; i++) await sleep(10);

    src.finish();
    const rg = await rgPromise;
    const snap = rg.snapshot();
    await rg.stop('done');
    await srv.close();

    assert.equal(seenBodies.length, 4);
    const msgs4 = seenBodies[3].messages;
    assert.equal(msgs4.length, 2, '4º turno pós-reset deve ter apenas system + pergunta atual');
    assert.equal(msgs4[0].role, 'system');
    assert.ok(msgs4[0].content.includes('[DOCUMENTAÇÃO OFICIAL RELEVANTE]'), 'RAG injetado no system');
    assert.ok(msgs4[0].content.includes('Runbook para: turno 4 pós reset'));
    assert.equal(msgs4[1].content, 'turno 4 pós reset');
    assert.equal(snap.nodes.llm.counters['llm.omlx.historyResets'], 1);
  });

  test('S5: asr.realtime maxPendingMs descarta frames antigos antes do flush e incrementa pendingDropped', async () => {
    // Servidor atrasa o handshake 260 ms para acumular frames pré-abertura
    const wsSrv = await wsMockServer({ acceptDelayMs: 260 });

    const pcmSrc: NodeTypeDef = {
      type: 'source.pcm.burst',
      sourceOnly: true,
      paramNames: [],
      inputs: [],
      outputs: [{ name: 'out', type: 'pcm16k', required: false }],
      create: (ctx) => ({
        async start() {
          // 2 frames antigos (t=0)
          await ctx.emit('out', new Uint8Array([1, 2, 3, 4]));
          await ctx.emit('out', new Uint8Array([5, 6, 7, 8]));
          // espera 210 ms (> maxPendingMs=120) e manda 1 frame recente
          await sleep(210);
          await ctx.emit('out', new Uint8Array([9, 10, 11, 12]));
        },
        async onInput() {},
        async stop() {},
      }),
    };

    const collected = { received: [] as Array<{ payload: unknown }> };
    const reg = createRegistry().register(pcmSrc).register(asrRealtime).register(sinkCollect);
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: false,
      nodes: [
        { id: 'src', type: 'source.pcm.burst' },
        { id: 'asr', type: 'asr.realtime', params: { url: wsSrv.url, maxPendingMs: 120 } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'asr.in', capacity: 32, overflow: 'block' },
        { from: 'asr.out', to: 'snk.parcs', capacity: 32, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    };

    const rg = await runGraph(flow, reg);
    await sleep(450);
    const snap = rg.snapshot();
    await rg.stop('done');
    await wsSrv.close();

    assert.ok(
      (snap.nodes.asr.counters['asr.realtime.pendingDropped'] ?? 0) >= 2,
      `deve descartar >= 2 frames antigos, veio ${snap.nodes.asr.counters['asr.realtime.pendingDropped']}`,
    );
    const appends = wsSrv.connections[0]?.received.filter((m) => m.type === 'input_audio_buffer.append') ?? [];
    assert.equal(appends.length, 1, 'apenas o frame recente deve ser enviado no flush');
  });

  test('S6: asr.realtime emitInterruptOnSpeech + bargeInDebounceMs filtra ruído curto e dispara em fala sustentada', async () => {
    let serverConn: MockWsConn | null = null;
    const wsSrv = await wsMockServer({
      onConnection: (c) => {
        serverConn = c;
      },
    });

    const receivedControls: ControlMsg[] = [];
    const probeNode: NodeTypeDef = {
      type: 'sink.probe.ctrl',
      sink: true,
      paramNames: [],
      inputs: [{ name: 'in', type: 'tokens_parcial' }],
      outputs: [],
      create: () => ({
        async start() {},
        async onInput() {},
        async stop() {},
        onControl(c) {
          receivedControls.push(c);
        },
      }),
    };

    const idlePcm: NodeTypeDef = {
      type: 'source.pcm.idle',
      sourceOnly: true,
      paramNames: [],
      inputs: [],
      outputs: [{ name: 'out', type: 'pcm16k', required: false }],
      create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
    };

    const reg = createRegistry().register(idlePcm).register(asrRealtime).register(probeNode);
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: false,
      nodes: [
        { id: 'src', type: 'source.pcm.idle' },
        {
          id: 'asr',
          type: 'asr.realtime',
          params: { url: wsSrv.url, emitInterruptOnSpeech: true, bargeInDebounceMs: 120 },
        },
        { id: 'snk', type: 'sink.probe.ctrl' },
      ],
      edges: [
        { from: 'src.out', to: 'asr.in', capacity: 16, overflow: 'drop_oldest' },
        { from: 'asr.out', to: 'snk.in', capacity: 16, overflow: 'block' },
      ],
    };

    const rg = await runGraph(flow, reg);
    for (let i = 0; i < 40 && !serverConn; i++) await sleep(10);
    assert.ok(serverConn, 'WS conectado');

    // 1. Fala curta (50 ms < debounce 120 ms): NÃO dispara interrupt
    serverConn!.send({ type: 'input_audio_buffer.speech_started' });
    await sleep(50);
    serverConn!.send({ type: 'input_audio_buffer.speech_stopped' });
    await sleep(140);
    assert.equal(receivedControls.length, 0, 'fala curta não deve disparar interrupt');

    // 2. Fala sustentada (>= 120 ms): DISPARA interrupt
    serverConn!.send({ type: 'input_audio_buffer.speech_started' });
    await sleep(180);
    const snap = rg.snapshot();
    await rg.stop('done');
    await wsSrv.close();

    assert.equal(receivedControls.length, 1, 'fala sustentada deve disparar 1 interrupt');
    assert.equal(receivedControls[0].kind, 'interrupt');
    assert.equal(receivedControls[0].reason, 'speech_started');
    assert.equal(snap.nodes.asr.counters['asr.realtime.interrupts'], 1);
  });

  test('S7: turn.detector — merge incomplete+complete, timeout maxWaitMs, fast-path `?`, e fallback de rede', async () => {
    let httpCalls = 0;
    const srv = await httpServer((_req, body, res) => {
      httpCalls++;
      const parsed = JSON.parse(body) as { state: string };
      const state = parsed.state;
      // 1º segmento sem continuação -> incomplete; concatenado com "split brain" -> complete
      const isComplete = state.includes('split brain');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          answers: {
            turn: { choice: isComplete ? 'complete' : 'incomplete', confidence: 0.92 },
          },
        }),
      );
    });

    // 7a. 2 segmentos (incomplete + complete) -> 1 único final:true concatenado
    {
      const src = makeManualParcsSource();
      const collected = { received: [] as Array<{ payload: unknown }> };
      const reg = createRegistry().register(src.def).register(turnDetector).register(sinkCollect);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: false,
        nodes: [
          { id: 'src', type: 'source.parcs' },
          { id: 'td', type: 'turn.detector', params: { baseUrl: srv.url, maxWaitMs: 600 } },
          { id: 'snk', type: 'sink.collect' },
        ],
        edges: [
          { from: 'src.out', to: 'td.in', capacity: 16, overflow: 'block' },
          { from: 'td.out', to: 'snk.parcs', capacity: 16, overflow: 'block' },
        ],
        bindings: { snk: { __collect: collected } },
      };
      const rgPromise = runGraph(flow, reg);
      await src.push('So in distributed systems', true);
      await sleep(50);
      assert.equal(collected.received.length, 0, 'segmento incomplete deve segurar no buffer');
      await src.push('we avoid split brain', true);
      await sleep(60);
      src.finish();
      const rg = await rgPromise;
      const snap = rg.snapshot();
      await rg.stop('done');

      const finals = collected.received
        .map((r) => r.payload as { text: string; final: boolean })
        .filter((p) => p.final);
      assert.equal(finals.length, 1);
      assert.equal(finals[0].text, 'So in distributed systems we avoid split brain');
      assert.equal(snap.nodes.td.counters['turn.detector.immediate'], 1);
    }

    // 7b. Fast-path `?` com >= minWords NÃO faz chamada HTTP
    {
      const callsBefore = httpCalls;
      const src = makeManualParcsSource('source.parcs.q');
      const collected = { received: [] as Array<{ payload: unknown }> };
      const reg = createRegistry().register(src.def).register(turnDetector).register(sinkCollect);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: false,
        nodes: [
          { id: 'src', type: 'source.parcs.q' },
          { id: 'td', type: 'turn.detector', params: { baseUrl: srv.url, minWords: 3, maxWaitMs: 600 } },
          { id: 'snk', type: 'sink.collect' },
        ],
        edges: [
          { from: 'src.out', to: 'td.in', capacity: 16, overflow: 'block' },
          { from: 'td.out', to: 'snk.parcs', capacity: 16, overflow: 'block' },
        ],
        bindings: { snk: { __collect: collected } },
      };
      const rgPromise = runGraph(flow, reg);
      await src.push('How does caching work?', true);
      await sleep(50);
      src.finish();
      const rg = await rgPromise;
      await rg.stop('done');

      assert.equal(httpCalls, callsBefore, 'fast-path `?` não deve chamar /v1/systemone');
      assert.equal(collected.received.length, 1);
      assert.equal((collected.received[0].payload as { text: string }).text, 'How does caching work?');
    }

    // 7c. Timeout maxWaitMs faz flush automático quando incomplete
    {
      const src = makeManualParcsSource('source.parcs.t');
      const collected = { received: [] as Array<{ payload: unknown }> };
      const reg = createRegistry().register(src.def).register(turnDetector).register(sinkCollect);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: false,
        nodes: [
          { id: 'src', type: 'source.parcs.t' },
          { id: 'td', type: 'turn.detector', params: { baseUrl: srv.url, maxWaitMs: 120 } },
          { id: 'snk', type: 'sink.collect' },
        ],
        edges: [
          { from: 'src.out', to: 'td.in', capacity: 16, overflow: 'block' },
          { from: 'td.out', to: 'snk.parcs', capacity: 16, overflow: 'block' },
        ],
        bindings: { snk: { __collect: collected } },
      };
      const rgPromise = runGraph(flow, reg);
      await src.push('I was thinking about', true);
      await sleep(220);
      src.finish();
      const rg = await rgPromise;
      const snap = rg.snapshot();
      await rg.stop('done');

      assert.equal(collected.received.length, 1);
      assert.equal((collected.received[0].payload as { text: string }).text, 'I was thinking about');
      assert.equal(snap.nodes.td.counters['turn.detector.timeoutFlush'], 1);
    }

    // 7d. Fallback quando omlx falha (porta fechada/erro HTTP)
    {
      const failSrv = await httpServer((_req, _body, res) => {
        res.writeHead(500);
        res.end('internal error');
      });
      const src = makeManualParcsSource('source.parcs.f');
      const collected = { received: [] as Array<{ payload: unknown }> };
      const reg = createRegistry().register(src.def).register(turnDetector).register(sinkCollect);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: false,
        nodes: [
          { id: 'src', type: 'source.parcs.f' },
          { id: 'td', type: 'turn.detector', params: { baseUrl: failSrv.url, maxWaitMs: 100 } },
          { id: 'snk', type: 'sink.collect' },
        ],
        edges: [
          { from: 'src.out', to: 'td.in', capacity: 16, overflow: 'block' },
          { from: 'td.out', to: 'snk.parcs', capacity: 16, overflow: 'block' },
        ],
        bindings: { snk: { __collect: collected } },
      };
      const rgPromise = runGraph(flow, reg);
      await src.push('checking server fallback path', true);
      await sleep(180);
      src.finish();
      const rg = await rgPromise;
      const snap = rg.snapshot();
      await rg.stop('done');
      await failSrv.close();

      assert.equal(snap.nodes.td.errored, false, 'falha do omlx não deve derrubar turn.detector');
      assert.equal(collected.received.length, 1);
      assert.equal(snap.nodes.td.counters['turn.detector.timeoutFlush'], 1);
    }

    await srv.close();
  });

  test('S8: human.approve interrupt libera gate pendente e preserva metadados estruturados', async () => {
    const src = makeManualParcsSource('source.parcs.gate');
    const collected = { received: [] as Array<{ payload: unknown }> };
    const receivedMetas: Array<GateMeta | undefined> = [];
    const cancelReasons: string[] = [];
    let callCount = 0;

    const gate = {
      request: (text: string, meta?: GateMeta): Promise<string | null> => {
        callCount++;
        receivedMetas.push(meta);
        if (callCount === 1) {
          // 1º gate fica pendente até receber interrupt
          return new Promise<string | null>(() => {});
        }
        return Promise.resolve(text);
      },
      cancel: (reason?: string) => {
        if (reason) cancelReasons.push(reason);
      },
    };

    const reg = createRegistry().register(src.def).register(humanApprove).register(sinkCollect);
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: false,
      nodes: [
        { id: 'src', type: 'source.parcs.gate' },
        { id: 'gate', type: 'human.approve' },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'gate.in', capacity: 8, overflow: 'block' },
        { from: 'gate.out', to: 'snk.phrase', capacity: 8, overflow: 'block' },
      ],
      bindings: { gate: { __gate: gate }, snk: { __collect: collected } },
    };

    const rgPromise = runGraph(flow, reg);
    // 1ª mensagem: bloqueia no gate; depois recebe interrupt
    await src.push(
      JSON.stringify({ host: 'prod-01', command: 'df -h', reason: 'verificar disco' }),
      true,
      { decision: 'sensivel', trace: { turnId: 'turn-1' } },
    );
    for (let i = 0; i < 30 && callCount < 1; i++) await sleep(10);
    src.interrupt('speech_started');
    await sleep(30);

    // 2ª mensagem: aprovada imediatamente (prova que o gate foi liberado!)
    await src.push(
      JSON.stringify({ host: 'staging-01', command: 'uptime', reason: 'checar carga' }),
      true,
      { decision: 'leitura_segura', trace: { turnId: 'turn-2' } },
    );
    for (let i = 0; i < 30 && collected.received.length < 1; i++) await sleep(10);

    src.finish();
    const rg = await rgPromise;
    const snap = rg.snapshot();
    await rg.stop('done');

    assert.equal(callCount, 2, 'gate deve ser liberado pelo interrupt para aceitar 2ª mensagem');
    assert.deepEqual(cancelReasons, ['interrupted']);
    assert.equal(snap.nodes.gate.counters['human.approve.interrupted'], 1);
    assert.equal(snap.nodes.gate.counters['human.approve.approved'], 1);
    assert.equal(receivedMetas[0]?.host, 'prod-01');
    assert.equal(receivedMetas[0]?.command, 'df -h');
    assert.equal(receivedMetas[0]?.reason, 'verificar disco');
    assert.equal(receivedMetas[0]?.decision, 'sensivel');
    assert.equal(receivedMetas[0]?.trace?.turnId, 'turn-1');
    assert.equal(collected.received.length, 1);
  });

  test('S9: telemetria trace ponta-a-ponta monotônica (asr -> turn.detector -> llm.omlx -> decision.llm -> sink.captions)', async () => {
    let wsConn: MockWsConn | null = null;
    const wsSrv = await wsMockServer({
      onConnection: (c) => {
        wsConn = c;
      },
    });

    const httpSrv = await httpServer((req, body, res) => {
      if (req.url === '/v1/systemone') {
        const parsed = JSON.parse(body) as { questions?: Record<string, unknown> };
        res.writeHead(200, { 'content-type': 'application/json' });
        if (parsed.questions?.turn) {
          res.end(JSON.stringify({ answers: { turn: { choice: 'complete', confidence: 0.95 } } }));
        } else {
          res.end(JSON.stringify({ answers: { route: { choice: 'auto', confidence: 0.9 } } }));
        }
        return;
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Use Redis ' } }] })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'with TTL.' } }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        }, 15);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const pcmOne: NodeTypeDef = {
      type: 'source.pcm.one',
      sourceOnly: true,
      paramNames: [],
      inputs: [],
      outputs: [{ name: 'out', type: 'pcm16k', required: false }],
      create: (ctx) => ({
        async start() {
          await ctx.emit('out', new Uint8Array(64));
        },
        async onInput() {},
        async stop() {},
      }),
    };

    const captions: Array<{ text: string; final: boolean; trace?: TraceMeta }> = [];
    const reg = createRegistry()
      .register(pcmOne)
      .register(asrRealtime)
      .register(turnDetector)
      .register(llmOmlx)
      .register(decisionLlm)
      .register(sinkCaptions);

    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: false,
      nodes: [
        { id: 'cap', type: 'source.pcm.one' },
        { id: 'asr', type: 'asr.realtime', params: { url: wsSrv.url } },
        { id: 'td', type: 'turn.detector', params: { baseUrl: httpSrv.url, maxWaitMs: 500 } },
        { id: 'llm', type: 'llm.omlx', params: { baseUrl: httpSrv.url } },
        {
          id: 'dec',
          type: 'decision.llm',
          params: { baseUrl: httpSrv.url, mode: 'systemone', options: ['auto', 'humano'] },
        },
        { id: 'snk', type: 'sink.captions', params: { mode: 'callback' } },
      ],
      edges: [
        { from: 'cap.out', to: 'asr.in', capacity: 16, overflow: 'drop_oldest' },
        { from: 'asr.out', to: 'td.in', capacity: 16, overflow: 'block' },
        { from: 'td.out', to: 'llm.parcs', capacity: 16, overflow: 'block' },
        { from: 'llm.out', to: 'dec.in', capacity: 16, overflow: 'block' },
        { from: 'dec.auto', to: 'snk.in', capacity: 16, overflow: 'block' },
      ],
      bindings: {
        snk: {
          __onCaption: (c: { text: string; final: boolean; trace?: TraceMeta }) => {
            captions.push(c);
          },
        },
      },
    };

    const rg = await runGraph(flow, reg);
    for (let i = 0; i < 40 && !wsConn; i++) await sleep(10);
    assert.ok(wsConn, 'WS conectado');

    // Simula ASR emitindo delta + completed
    wsConn!.send({ type: 'conversation.item.added', item: { id: 'item-42' } });
    wsConn!.send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-42',
      delta: 'How to handle ',
    });
    await sleep(10);
    wsConn!.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-42',
      transcript: 'How to handle cache invalidation properly',
    });

    for (let i = 0; i < 60 && captions.length === 0; i++) await sleep(15);
    await rg.stop('done');
    await wsSrv.close();
    await httpSrv.close();

    assert.equal(captions.length, 1);
    assert.equal(captions[0].text, 'Use Redis with TTL.');
    assert.equal(captions[0].final, true);
    const tr = captions[0].trace;
    assert.ok(tr, 'trace deve chegar em sink.captions');
    assert.equal(tr.turnId, 'item-42');
    assert.equal(typeof tr.tCaptureMs, 'number');
    assert.equal(typeof tr.tAsrFirstMs, 'number');
    assert.equal(typeof tr.tAsrFinalMs, 'number');
    assert.equal(typeof tr.tTurnMs, 'number');
    assert.equal(typeof tr.tLlmTtftMs, 'number');
    assert.equal(typeof tr.tLlmFinalMs, 'number');
    assert.equal(typeof tr.tDecisionMs, 'number');
    assert.ok(tr.tAsrFirstMs! <= tr.tAsrFinalMs!, 'tAsrFirstMs <= tAsrFinalMs');
    assert.ok(tr.tAsrFinalMs! <= tr.tTurnMs!, 'tAsrFinalMs <= tTurnMs');
    assert.ok(tr.tTurnMs! <= tr.tLlmTtftMs!, 'tTurnMs <= tLlmTtftMs');
    assert.ok(tr.tLlmTtftMs! <= tr.tLlmFinalMs!, 'tLlmTtftMs <= tLlmFinalMs');
    assert.ok(tr.tLlmFinalMs! <= tr.tDecisionMs!, 'tLlmFinalMs <= tDecisionMs');
  });
});
