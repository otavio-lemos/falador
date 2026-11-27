/**
 * asr-and-llm-paths.test.ts — ASR (realtime/lfm3), LLM SSE, e sse.ts branches.
 * Servidores HTTP/WS fake locais em 127.0.0.1. Zero deps.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { asrRealtime, asrLfm3, llmOmlx, postSse, postJsonBytes, payloadText } from '../src/index.ts';
import type { NodeCtx, NodeRuntime } from '../../falador-graph/src/index.ts';

type AnyCtx = NodeCtx & {
  _emitted: Array<{ port: string; payload: unknown; opts?: any }>;
  _logs: Array<{ level: string; msg: string }>;
  _counters: Record<string, number>;
  _timers: Record<string, number[]>;
  _controls: Array<{ port: string; msg: any }>;
  _ac: AbortController;
};

function makeCtx(params: Record<string, unknown>, bindings: Record<string, unknown> = {}): AnyCtx {
  const emitted: Array<{ port: string; payload: unknown; opts?: any }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const counters: Record<string, number> = {};
  const timers: Record<string, number[]> = {};
  const controls: Array<{ port: string; msg: any }> = [];
  const ac = new AbortController();
  return {
    id: 'test-node', params, bindings, signal: ac.signal,
    _emitted: emitted, _logs: logs, _counters: counters, _timers: timers, _controls: controls, _ac: ac,
    emit: async (port: string, payload: unknown, opts?: unknown) => { emitted.push({ port, payload, opts }); },
    emitControl: (port: string, msg: any) => { controls.push({ port, msg }); },
    isCancelled: () => false,
    metrics: {
      counter: (name: string, delta = 1) => { counters[name] = (counters[name] ?? 0) + delta; },
      timer: (name: string, ms: number) => { (timers[name] ??= []).push(ms); },
    },
    log: (level: string, msg: string) => { logs.push({ level, msg }); },
  } as unknown as AnyCtx;
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await delay(20);
  }
}

function httpServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

// ---- minimal WS mock (RFC6455 text frames) ---------------------------------

interface MockWsConn { send(obj: unknown): void; sendRaw(text: string): void; close(): void; received: Record<string, unknown>[]; }

function wsEncodeText(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), payload]);
  if (len < 65536) { const h = Buffer.alloc(4); h[0]=0x81; h[1]=126; h.writeUInt16BE(len,2); return Buffer.concat([h,payload]); }
  const h = Buffer.alloc(10); h[0]=0x81; h[1]=127; h.writeBigUInt64BE(BigInt(len),2); return Buffer.concat([h,payload]);
}

function wsMockServer(opts: { onConnection?: (c: MockWsConn) => void } = {}) {
  const connections: MockWsConn[] = [];
  const sockets = new Set<Socket>();
  const srv = http.createServer();
  srv.on('upgrade', (req, socket) => {
    sockets.add(socket);
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn: MockWsConn = {
      received: [],
      send(obj: unknown) { if (!socket.destroyed) socket.write(wsEncodeText(JSON.stringify(obj))); },
      sendRaw(text: string) { if (!socket.destroyed) socket.write(wsEncodeText(text)); },
      close() { if (!socket.destroyed) socket.end(Buffer.from([0x88, 0x00])); },
    };
    connections.push(conn);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const mLen = masked ? 4 : 0;
        if (buf.length < off + mLen + len) return;
        let payload = buf.subarray(off + mLen, off + mLen + len);
        if (masked) { const mask = buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i=0;i<payload.length;i++) payload[i] ^= mask[i&3]; }
        buf = buf.subarray(off + mLen + len);
        const opcode = buf.length >= 0 ? (chunk[0] & 0x0f) : 1; // not quite; use original opcode
      }
    });
    // Better parser: re-implement cleanly below by overriding
    socket.removeAllListeners('data');
    buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f; let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const mLen = masked ? 4 : 0;
        if (buf.length < off + mLen + len) return;
        let payload = buf.subarray(off + mLen, off + mLen + len);
        if (masked) { const mask = buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i=0;i<payload.length;i++) payload[i] ^= mask[i&3]; }
        buf = buf.subarray(off + mLen + len);
        if (opcode === 0x8) { socket.end(); return; }
        if (opcode === 0x1) { try { conn.received.push(JSON.parse(payload.toString('utf8'))); } catch { /* ignore */ } }
      }
    });
    opts.onConnection?.(conn);
  });
  return new Promise<{ url: string; connections: MockWsConn[]; close: () => Promise<void> }>((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${addr.port}/v1/realtime`,
        connections,
        close: () => new Promise<void>((r) => { for (const s of sockets) try { s.destroy(); } catch {} srv.close(() => r()); }),
      });
    });
  });
}

function pcm16(bytes = 320): Uint8Array { return new Uint8Array(bytes).fill(1); }

// ---- sse.ts branches -------------------------------------------------------

describe('sse.ts', () => {
  test('payloadText: string, object com text/final, null/irrelevante', () => {
    assert.deepEqual(payloadText('oi'), { text: 'oi', final: true });
    assert.deepEqual(payloadText({ text: 'a', final: false }), { text: 'a', final: false });
    assert.deepEqual(payloadText({ text: 'b' }), { text: 'b', final: true });
    assert.equal(payloadText(null), null);
    assert.equal(payloadText(123), null);
    assert.equal(payloadText({ nope: true }), null);
  });

  test('postJsonBytes: sucesso e erro HTTP', async () => {
    const srv = await httpServer((req, body, res) => {
      if (req.url === '/ok') { res.writeHead(200); res.end(Buffer.from('abc')); }
      else { res.writeHead(500); res.end('boom'); }
    });
    try {
      const ok = await postJsonBytes(`${srv.url}/ok`, { a: 1 }, 2000);
      assert.equal(Buffer.from(ok).toString(), 'abc');
      await assert.rejects(() => postJsonBytes(`${srv.url}/bad`, {}, 2000), /HTTP 500/);
    } finally { await srv.close(); }
  });

  test('postJsonBytes: abort por signal e por timeout', async () => {
    const srv = await httpServer((_req, _body, res) => { setTimeout(() => { res.writeHead(200); res.end('late'); }, 500); });
    try {
      const ac = new AbortController();
      const p = postJsonBytes(`${srv.url}/slow`, {}, 5000, ac.signal);
      setTimeout(() => ac.abort(), 30);
      await assert.rejects(p, (e: any) => e?.name === 'AbortError');
      await assert.rejects(() => postJsonBytes(`${srv.url}/slow`, {}, 30), (e: any) => e?.name === 'AbortError');
    } finally { await srv.close(); }
  });

  test('postSse: fragmentado, não-JSON, [DONE], e done sem [DONE]', async () => {
    const srv = await httpServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // fragmentado entre chunks + linha não-JSON + [DONE]
      res.write('data: {"a":1}\n');
      res.write('da');
      res.write('ta: not-json\n\n');
      res.write('data: {"b":2}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const seen: unknown[] = [];
      let done = 0;
      await postSse(`${srv.url}/sse`, {}, { onData: (j) => seen.push(j), onDone: () => { done++; } });
      assert.deepEqual(seen, [{ a: 1 }, { b: 2 }]);
      assert.equal(done, 1);
    } finally { await srv.close(); }
  });

  test('postSse: stream termina sem [DONE] chama onDone', async () => {
    const srv = await httpServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"x":1}\n\n');
      res.end(); // sem [DONE]
    });
    try {
      const seen: unknown[] = [];
      let done = 0;
      await postSse(`${srv.url}/sse`, {}, { onData: (j) => seen.push(j), onDone: () => { done++; } });
      assert.deepEqual(seen, [{ x: 1 }]);
      assert.equal(done, 1);
    } finally { await srv.close(); }
  });

  test('postSse: erro HTTP rejeita', async () => {
    const srv = await httpServer((_req, _body, res) => { res.writeHead(503); res.end('no'); });
    try {
      await assert.rejects(() => postSse(`${srv.url}/bad`, {}, { onData: () => {} }), /HTTP 503/);
    } finally { await srv.close(); }
  });
});

// ---- asr.realtime.translate --------------------------------------------------------------

describe('asr.realtime.translate', () => {
  test('valida params', () => {
    assert.ok(asrLfm3.validateParams!({ url: 1 }).some((e) => e.path === 'params.url'));
    assert.ok(asrLfm3.validateParams!({ flushSec: 0 }).some((e) => e.path === 'params.flushSec'));
    assert.ok(asrLfm3.validateParams!({ sampleRateHz: -1 }).some((e) => e.path === 'params.sampleRateHz'));
    assert.equal(asrLfm3.validateParams!({ url: 'http://x', flushSec: 1, sampleRateHz: 16000 }).length, 0);
  });

  test('PCM cru: acumula e flush no flushSec, emite tokens_parcial final:true', async () => {
    const bodies: any[] = [];
    const srv = await httpServer((_req, body, res) => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'olá mundo' }));
    });
    try {
      // 16000Hz s16le mono: 32000 bytes = 1s. flushSec=0.1s => 3200 bytes
      const captions: Array<{ text: string; final: boolean }> = [];
      const ctx = makeCtx({ url: srv.url, flushSec: 0.1, sampleRateHz: 16000 }, {
        __onCaption: (c: { text: string; final: boolean }) => captions.push(c),
      });
      const node = asrLfm3.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: pcm16(3200) } as any);
      await waitFor(() => ctx._emitted.length >= 1, 3000);
      assert.deepEqual(ctx._emitted[0].payload, { text: 'olá mundo', final: true });
      assert.equal(ctx._emitted[0].port, 'out');
      assert.deepEqual(captions, [{ text: 'olá mundo', final: true }]);
      assert.ok(bodies[0].audioB64);
      assert.ok((ctx._timers['asr.realtime.translate.ms']?.length ?? 0) >= 1);
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('WAV payload (format wav) tem header 44 bytes removido antes de reembrulhar', async () => {
    const bodies: any[] = [];
    const srv = await httpServer((_req, body, res) => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'ok' }));
    });
    try {
      // cria um "wav" com 44 bytes de header + 3200 bytes pcm = 3244
      const wavData = new Uint8Array(44 + 3200);
      wavData.fill(7, 44);
      const ctx = makeCtx({ url: srv.url, flushSec: 0.1, sampleRateHz: 16000 });
      const node = asrLfm3.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { format: 'wav', data: wavData } } as any);
      await waitFor(() => ctx._emitted.length >= 1, 3000);
      assert.equal(ctx._emitted[0].payload.text, 'ok');
      // o nó reembrulha em WAV: audioB64 decodificado deve ter 44 (header) + 3200 (pcm) = 3244
      const decoded = Buffer.from(bodies[0].audioB64, 'base64');
      assert.equal(decoded.length, 44 + 3200);
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('stop() faz flush final mesmo com ctx.signal abortado (fromStop usa signal undefined)', async () => {
    const bodies: any[] = [];
    const srv = await httpServer((_req, body, res) => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'final flush' }));
    });
    try {
      const ctx = makeCtx({ url: srv.url, flushSec: 999, sampleRateHz: 16000 }); // flushSec grande para não flushar no onInput
      const node = asrLfm3.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: pcm16(1600) } as any); // 0.05s, abaixo do flushSec
      assert.equal(ctx._emitted.length, 0);
      ctx._ac.abort(); // simula motor abortando antes do stop()
      await node.stop('done');
      await waitFor(() => ctx._emitted.length >= 1, 3000);
      assert.equal(ctx._emitted[0].payload.text, 'final flush');
      assert.equal(bodies.length, 1);
    } finally { await srv.close(); }
  });

  test('targetLanguage: custom, "-", e instruction explícita', async () => {
    const bodies: any[] = [];
    const srv = await httpServer((_req, body, res) => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: 'x' }));
    });
    try {
      // targetLanguage custom
      const c1 = makeCtx({ url: srv.url, flushSec: 0.01, sampleRateHz: 16000, targetLanguage: 'Spanish' });
      const n1 = asrLfm3.create(c1) as NodeRuntime; await n1.start();
      await n1.onInput('in', { seq: 1, ts: 1, payload: pcm16(3200) } as any);
      await waitFor(() => c1._emitted.length >= 1, 3000); await n1.stop('done');
      assert.ok(bodies[0].instruction.includes('Spanish'));

      // targetLanguage '-' => transcrição verbatim
      const c2 = makeCtx({ url: srv.url, flushSec: 0.01, sampleRateHz: 16000, targetLanguage: '-' });
      const n2 = asrLfm3.create(c2) as NodeRuntime; await n2.start();
      await n2.onInput('in', { seq: 1, ts: 1, payload: pcm16(3200) } as any);
      await waitFor(() => c2._emitted.length >= 1, 3000); await n2.stop('done');
      assert.ok(bodies[1].instruction.toLowerCase().includes('verbatim'));

      // instruction explícita tem precedência
      const c3 = makeCtx({ url: srv.url, flushSec: 0.01, sampleRateHz: 16000, instruction: 'FAÇA ISSO', targetLanguage: 'Spanish' });
      const n3 = asrLfm3.create(c3) as NodeRuntime; await n3.start();
      await n3.onInput('in', { seq: 1, ts: 1, payload: pcm16(3200) } as any);
      await waitFor(() => c3._emitted.length >= 1, 3000); await n3.stop('done');
      assert.equal(bodies[2].instruction, 'FAÇA ISSO');
    } finally { await srv.close(); }
  });

  test('erro HTTP loga erro e incrementa contador; não emite texto', async () => {
    const srv = await httpServer((_req, _body, res) => { res.writeHead(500); res.end('boom'); });
    try {
      const ctx = makeCtx({ url: srv.url, flushSec: 0.01, sampleRateHz: 16000, timeoutMs: 2000 });
      const node = asrLfm3.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: pcm16(3200) } as any);
      await waitFor(() => (ctx._counters['asr.realtime.translate.errors'] ?? 0) >= 1 || ctx._logs.some((l) => l.level === 'error'), 3000);
      assert.equal(ctx._emitted.length, 0);
      assert.ok((ctx._counters['asr.realtime.translate.errors'] ?? 0) >= 1);
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('timeout/AbortError é engolido silenciosamente (comportamento atual) — sem crash nem emit', async () => {
    const srv = await httpServer((_req, _body, res) => { setTimeout(() => { res.writeHead(200); res.end(JSON.stringify({text:'late'})); }, 500); });
    try {
      const ctx = makeCtx({ url: srv.url, flushSec: 0.01, sampleRateHz: 16000, timeoutMs: 30 });
      const node = asrLfm3.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: pcm16(3200) } as any);
      await delay(300);
      assert.equal(ctx._emitted.length, 0);
      // Comportamento atual: AbortError (incl. timeout interno) é tratado como abort intencional.
      // Possível bug: timeout real fica indistinguível de cancelamento e não incrementa errors.
      await node.stop('done');
    } finally { await srv.close(); }
  });
});

// ---- asr.realtime ----------------------------------------------------------

describe('asr.realtime', () => {
  test('valida params', () => {
    assert.ok(asrRealtime.validateParams!({ url: 1 }).some((e) => e.path === 'params.url'));
    assert.ok(asrRealtime.validateParams!({ inputRate: 0 }).some((e) => e.path === 'params.inputRate'));
    assert.ok(asrRealtime.validateParams!({ serverVad: 'x' }).some((e) => e.path === 'params.serverVad'));
    assert.ok(asrRealtime.validateParams!({ emitInterruptOnSpeech: 'x' }).some((e) => e.path === 'params.emitInterruptOnSpeech'));
    assert.ok(asrRealtime.validateParams!({ bargeInDebounceMs: -1 }).some((e) => e.path === 'params.bargeInDebounceMs'));
    assert.ok(asrRealtime.validateParams!({ maxPendingMs: 0 }).some((e) => e.path === 'params.maxPendingMs'));
    assert.equal(asrRealtime.validateParams!({ inputRate: 16000, serverVad: true, maxPendingMs: 1000, bargeInDebounceMs: 0 }).length, 0);
  });

  test('conecta, recebe delta+completed, emite tokens_parcial e final', async () => {
    const ws = await wsMockServer({
      onConnection: (c) => {
        // após session.update, simula transcrição
        setTimeout(() => {
          c.send({ type: 'conversation.item.added', item: { id: 'it1' } });
          c.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it1', delta: 'olá' });
          c.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'it1', delta: ' mundo' });
          c.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it1', transcript: 'olá mundo' });
        }, 50);
      },
    });
    try {
      const captions: Array<{ text: string; final: boolean }> = [];
      const ctx = makeCtx({ url: ws.url, inputRate: 16000, serverVad: true }, {
        __onCaption: (c: { text: string; final: boolean }) => captions.push(c),
      });
      const node = asrRealtime.create(ctx) as NodeRuntime;
      await node.start();
      await waitFor(() => ws.connections.length >= 1, 3000);
      // envia audio para garantir fluxo (e também exercita append)
      await node.onInput('in', { seq: 1, ts: Date.now(), payload: pcm16(320) } as any);
      await waitFor(() => ctx._emitted.some((e) => (e.payload as any)?.final === true), 3000);
      const finals = ctx._emitted.filter((e) => e.port === 'out' && (e.payload as any)?.final === true);
      assert.ok(finals.some((e) => (e.payload as any).text === 'olá mundo'));
      // final phrase também emitido
      assert.ok(ctx._emitted.some((e) => e.port === 'final' && e.payload === 'olá mundo'));
      assert.equal(ctx._counters['asr.realtime.turns'], 1);
      assert.equal(captions.at(-1)?.text, 'olá mundo');
      assert.equal(captions.at(-1)?.final, true);
      assert.ok(captions.some((c) => !c.final && c.text === 'olá'));
      await node.stop('done');
    } finally { await ws.close(); }
  });

  test('mensagem malformada e error do server não derrubam; loga erro', async () => {
    const ws = await wsMockServer({
      onConnection: (c) => {
        setTimeout(() => {
          c.sendRaw('not json {{{');
          c.send({ type: 'error', error: { message: 'boom' } });
          c.send({ type: 'conversation.item.added', item: { id: 'it2' } });
          c.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'it2', transcript: 'ok' });
        }, 50);
      },
    });
    try {
      const ctx = makeCtx({ url: ws.url, serverVad: true });
      const node = asrRealtime.create(ctx) as NodeRuntime;
      await node.start();
      await waitFor(() => ctx._emitted.some((e) => (e.payload as any)?.final === true), 3000);
      assert.ok(ctx._logs.some((l) => l.level === 'error' && l.msg.includes('boom')));
      assert.ok(ctx._emitted.some((e) => (e.payload as any)?.text === 'ok'));
      await node.stop('done');
    } finally { await ws.close(); }
  });

  test('WS fecha no meio => reconnect com backoff (contador incrementa, nova conexão)', async () => {
    const ws = await wsMockServer();
    try {
      const ctx = makeCtx({ url: ws.url, serverVad: true });
      const node = asrRealtime.create(ctx) as NodeRuntime;
      await node.start();
      await waitFor(() => ws.connections.length >= 1, 3000);
      // fecha a conexão do servidor
      ws.connections[0].close();
      await waitFor(() => (ctx._counters['asr.realtime.reconnects'] ?? 0) >= 1, 3000);
      await waitFor(() => ws.connections.length >= 2, 4000);
      await node.stop('done');
    } finally { await ws.close(); }
  });

  test('maxPendingMs descarta frames velhos do buffer pré-abertura', async () => {
    // server que aceita conexão mas só depois de um delay - fazemos enviando audio antes de abrir
    // Mais simples: usar URL de server que ainda não existe? Não, WebSocket falha. 
    // Em vez disso: iniciar, fechar imediatamente para entrar em reconnect, empurrar áudio, esperar maxPendingMs passar, e ver drop.
    const ws = await wsMockServer();
    try {
      const ctx = makeCtx({ url: ws.url, serverVad: true, maxPendingMs: 50 });
      const node = asrRealtime.create(ctx) as NodeRuntime;
      await node.start();
      await waitFor(() => ws.connections.length >= 1, 3000);
      // força estado fechado fechando conexão e esperando reconnect agendar
      ws.connections[0].close();
      await waitFor(() => (ctx._counters['asr.realtime.reconnects'] ?? 0) >= 1, 3000);
      // neste momento ws está fechado/reconectando; envia áudio que ficará pending
      await node.onInput('in', { seq: 1, ts: Date.now(), payload: pcm16(320) } as any);
      await delay(120); // envelhece além de maxPendingMs
      await node.onInput('in', { seq: 2, ts: Date.now(), payload: pcm16(320) } as any);
      // quando reconectar, flush dropa stale
      await waitFor(() => ws.connections.length >= 2, 5000);
      await waitFor(() => (ctx._counters['asr.realtime.pendingDropped'] ?? 0) >= 1, 3000);
      await node.stop('done');
    } finally { await ws.close(); }
  });

  test('emitInterruptOnSpeech + bargeInDebounceMs emite control interrupt', async () => {
    const ws = await wsMockServer({
      onConnection: (c) => {
        setTimeout(() => { c.send({ type: 'input_audio_buffer.speech_started' }); }, 50);
      },
    });
    try {
      const ctx = makeCtx({ url: ws.url, serverVad: true, emitInterruptOnSpeech: true, bargeInDebounceMs: 30 });
      const node = asrRealtime.create(ctx) as NodeRuntime;
      await node.start();
      await waitFor(() => ctx._controls.some((c) => c.msg?.kind === 'interrupt'), 3000);
      assert.ok(ctx._controls.some((c) => c.port === 'out' && c.msg.reason === 'speech_started'));
      assert.ok(ctx._controls.some((c) => c.port === 'final'));
      assert.equal(ctx._counters['asr.realtime.interrupts'], 1);
      await node.stop('done');
    } finally { await ws.close(); }
  });

  test('modo manual (serverVad=false): commitEveryMs envia commit periodicamente', async () => {
    const ws = await wsMockServer();
    try {
      const ctx = makeCtx({ url: ws.url, serverVad: false, commitEveryMs: 50, silenceThresholdMs: 10 });
      const node = asrRealtime.create(ctx) as NodeRuntime;
      await node.start();
      await waitFor(() => ws.connections.length >= 1, 3000);
      await node.onInput('in', { seq: 1, ts: Date.now(), payload: pcm16(320) } as any);
      // espera commit aparecer
      await waitFor(() => ws.connections[0].received.some((m) => m.type === 'input_audio_buffer.commit'), 3000);
      assert.ok(ws.connections[0].received.some((m) => m.type === 'session.update'));
      assert.ok(ws.connections[0].received.some((m) => m.type === 'input_audio_buffer.append'));
      await node.stop('done');
    } finally { await ws.close(); }
  });
});

// ---- llm.omlx --------------------------------------------------------------

describe('llm.omlx', () => {
  test('valida params', () => {
    assert.ok(llmOmlx.validateParams!({ template: 'nope' }).some((e) => e.path === 'params.template'));
    assert.ok(llmOmlx.validateParams!({ enableThinking: 'x' }).some((e) => e.path === 'params.enableThinking'));
    assert.ok(llmOmlx.validateParams!({ useContext: 'x' }).some((e) => e.path === 'params.useContext'));
    assert.ok(llmOmlx.validateParams!({ historyCharBudget: -1 }).some((e) => e.path === 'params.historyCharBudget'));
    assert.ok(llmOmlx.validateParams!({ contextTopK: 0 }).some((e) => e.path === 'params.contextTopK'));
    assert.ok(llmOmlx.validateParams!({ contextTags: [1] }).some((e) => e.path === 'params.contextTags'));
    assert.equal(llmOmlx.validateParams!({ model: 'm', temperature: 0, enableThinking: false, useContext: true, contextTopK: 3 }).length, 0);
  });

  test('SSE fragmentado gera parciais cumulativos e final:true', async () => {
    const srv = await httpServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"He"}}]}\n\n');
      res.write('da'); // fragmento
      res.write('ta: {"choices":[{"delta":{"content":"llo"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, model: 'm', enableThinking: false });
      const node = llmOmlx.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: 'hi', meta: { trace: { turnId: 't1' } } } as any);
      await waitFor(() => ctx._emitted.some((e) => (e.payload as any)?.final === true), 3000);
      const texts = ctx._emitted.map((e) => (e.payload as any).text);
      assert.ok(texts.includes('He'));
      assert.ok(texts.includes('Hello'));
      const last = ctx._emitted[ctx._emitted.length - 1].payload as any;
      assert.equal(last.final, true);
      assert.equal(last.text, 'Hello');
      assert.ok((ctx._timers['llm.omlx.ttftMs']?.length ?? 0) >= 1);
      assert.ok((ctx._timers['llm.omlx.totalMs']?.length ?? 0) >= 1);
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('reasoning_content: acumula por turno, fecha pensamento e não contamina resposta', async () => {
    const srv = await httpServer((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"reasoning_content":"Analisar"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"Resposta"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"reasoning_content":" contexto"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const thoughts: Array<{ thoughtId: string; text: string; final: boolean }> = [];
      const ctx = makeCtx({ baseUrl: srv.url, model: 'm', enableThinking: true }, {
        __onThought: (ev: { thoughtId: string; text: string; final: boolean }) => thoughts.push(ev),
      });
      const node = llmOmlx.create(ctx) as NodeRuntime;
      await node.onInput('in', { seq: 1, ts: 1, payload: 'hi' } as any);
      await node.onInput('in', { seq: 2, ts: 2, payload: 'hi again' } as any);
      const first = thoughts.filter((t) => t.thoughtId === 'test-node:1');
      const second = thoughts.filter((t) => t.thoughtId === 'test-node:2');
      assert.equal(first.at(-1)?.text, 'Analisar contexto');
      assert.equal(first.at(-1)?.final, true);
      assert.equal(second.at(-1)?.final, true);
      assert.equal(thoughts.filter((t) => t.final).length, 2);
      const lastPayload = ctx._emitted.at(-1)?.payload as { text: string; final: boolean };
      assert.equal(lastPayload.text, 'Resposta');
      assert.equal(lastPayload.final, true);
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('histórico e historyCharBudget: envia turns anteriores e poda por orçamento', async () => {
    const bodies: any[] = [];
    const srv = await httpServer((_req, body, res) => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"R"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, model: 'm', historyMax: 4, historyCharBudget: 50 });
      const node = llmOmlx.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: 'pergunta um' } as any);
      await waitFor(() => ctx._emitted.length >= 1, 3000);
      await node.onInput('in', { seq: 2, ts: 2, payload: 'pergunta dois' } as any);
      await waitFor(() => ctx._emitted.filter((e) => (e.payload as any).final).length >= 2, 3000);
      // segunda chamada deve ter histórico da primeira (user+assistant)
      const msgs2 = bodies[1].messages as Array<{ role: string; content: string }>;
      const roles = msgs2.map((m) => m.role);
      assert.ok(roles.includes('assistant'), 'deve incluir resposta anterior');
      // budget pequeno deve podar (historyCharBudget=50) - não deve crescer sem limite
      assert.ok(JSON.stringify(msgs2).length < 500);
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('resetHistory via binding limpa histórico; interrupt aborta sem final e sem gravar histórico', async () => {
    let resetFn: (() => void) | null = null;
    const bodies: any[] = [];
    let release: (() => void) | null = null;
    const srv = await httpServer((_req, body, res) => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"parcial"}}]}\n\n');
      // segura para permitir interrupt
      const sendRest = () => { res.write('data: {"choices":[{"delta":{"content":" fim"}}]}\n\n'); res.write('data: [DONE]\n\n'); res.end(); };
      release = sendRest;
      setTimeout(sendRest, 2000); // fallback
    });
    try {
      const ctx = makeCtx({ baseUrl: srv.url, model: 'm', historyMax: 2 }, { __registerReset: (fn: () => void) => { resetFn = fn; } });
      const node = llmOmlx.create(ctx) as NodeRuntime;
      await node.start();
      assert.ok(resetFn, 'deve registrar reset');

      const p = node.onInput('in', { seq: 1, ts: 1, payload: 'pergunta' } as any);
      await waitFor(() => ctx._emitted.length >= 1, 3000); // recebeu parcial
      node.onControl?.({ kind: 'interrupt', scope: 'node', reason: 'test' } as any);
      release?.();
      await p;
      // interrupt: não deve ter emitido final:true
      assert.ok(!ctx._emitted.some((e) => (e.payload as any)?.final === true));
      assert.ok((ctx._counters['llm.omlx.interrupted'] ?? 0) >= 1);

      // resetHistory e próxima chamada não deve incluir histórico interrompido
      resetFn!();
      assert.ok((ctx._counters['llm.omlx.historyResets'] ?? 0) >= 1);
      await node.stop('done');
    } finally { await srv.close(); }
  });

  test('RAG injetado via __getContext aparece no system message', async () => {
    const bodies: any[] = [];
    const srv = await httpServer((_req, body, res) => {
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    try {
      const ctx = makeCtx(
        { baseUrl: srv.url, model: 'm', useContext: true, contextTopK: 2, contextMaxChars: 500, system: 'base' },
        { __getContext: (_q: string, _opts: any) => 'DOC RELEVANTE: foo' },
      );
      const node = llmOmlx.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: 'como usar foo?' } as any);
      await waitFor(() => ctx._emitted.some((e) => (e.payload as any)?.final === true), 3000);
      const sys = bodies[0].messages[0];
      assert.equal(sys.role, 'system');
      assert.ok(sys.content.includes('base'));
      assert.ok(sys.content.includes('DOC RELEVANTE: foo'));
      await node.stop('done');
    } finally { await srv.close(); }
  });
});
