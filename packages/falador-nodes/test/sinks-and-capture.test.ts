/**
 * sinks-and-capture.test.ts — cobertura de sink.captions, sink.playback e capture.ffmpeg.
 * Zero deps externas; servidores/processos fake locais.
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { existsSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { captureFfmpeg, sinkCaptions, sinkPlayback } from '../src/index.ts';
import type { NodeCtx, NodeRuntime } from '../../falador-graph/src/index.ts';

type AnyCtx = NodeCtx & {
  _emitted: Array<{ port: string; payload: unknown; opts?: unknown }>;
  _logs: Array<{ level: string; msg: string }>;
  _counters: Record<string, number>;
  _timers: Record<string, number[]>;
};

function makeCtx(params: Record<string, unknown>, bindings: Record<string, unknown> = {}): AnyCtx {
  const emitted: Array<{ port: string; payload: unknown; opts?: unknown }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const counters: Record<string, number> = {};
  const timers: Record<string, number[]> = {};
  const ac = new AbortController();
  return {
    id: 'test-node',
    params,
    bindings,
    signal: ac.signal,
    _emitted: emitted,
    _logs: logs,
    _counters: counters,
    _timers: timers,
    emit: async (port: string, payload: unknown, opts?: unknown) => {
      emitted.push({ port, payload, opts });
    },
    emitControl: () => {},
    isCancelled: () => false,
    metrics: {
      counter: (name: string, delta = 1) => { counters[name] = (counters[name] ?? 0) + delta; },
      timer: (name: string, ms: number) => { (timers[name] ??= []).push(ms); },
    },
    log: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => { logs.push({ level, msg }); },
  } as unknown as AnyCtx;
}

function wavPayload(bytes = 64): { format: 'wav'; sampleRateHz: number; data: Uint8Array } {
  return { format: 'wav', sampleRateHz: 24000, data: new Uint8Array(bytes).fill(1) };
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await delay(20);
  }
}

function fakePlayerScript(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'falador-player-'));
  const p = join(dir, 'player.sh');
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
}

// ---- sink.captions ---------------------------------------------------------

const RUNNER_LINE_RE = /^\s*(?:TAP version \d+|ok \d+|not ok \d+|1\.\.\d+|#|---$|\.\.\.$|(?:duration_ms|type|location|failureType|error|code|stack|attempt|Subtest):|[▶✔✖ℹ])/;

function isRunnerOutput(s: string): boolean {
  const plain = s.replace(/\u001B\[[0-9;]*m/g, '');
  return RUNNER_LINE_RE.test(plain);
}

function captureStdout(t: { mock: { method: (...args: any[]) => { mock: { restore: () => void } } } }): {
  writes: string[];
  restore: () => void;
} {
  const writes: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  const mocked = t.mock.method(process.stdout, 'write', (chunk: unknown, ...rest: unknown[]) => {
    const s = String(chunk);
    if (isRunnerOutput(s)) return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
    writes.push(s);
    return true;
  });
  return { writes, restore: () => mocked.mock.restore() };
}

describe('sink.captions', () => {
  test('valida params: mode/showParcials/outputFile inválidos', () => {
    assert.ok(sinkCaptions.validateParams!({ mode: 'bad' }).some((e) => e.path === 'params.mode'));
    assert.ok(sinkCaptions.validateParams!({ showParcials: 'no' }).some((e) => e.path === 'params.showParcials'));
    assert.ok(sinkCaptions.validateParams!({ outputFile: 123 }).some((e) => e.path === 'params.outputFile'));
    assert.equal(sinkCaptions.validateParams!({ mode: 'stdout', showParcials: true, outputFile: '/tmp/x' }).length, 0);
  });

  test('stdout: parcial escreve \\r+ANSI erase, final escreve linha nova e conta métrica', async (t) => {
    const cap = captureStdout(t);
    const ctx = makeCtx({ mode: 'stdout', showParcials: true });
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    try {
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'ola', final: false } } as any);
      await node.onInput('in', { seq: 2, ts: 2, payload: { text: 'ola mundo', final: true } } as any);
    } finally {
      cap.restore();
    }
    await node.stop('done');
    assert.ok(cap.writes.some((w) => w.startsWith('\r') && w.includes('ola') && w.includes('\u001B[K') && !w.endsWith('\n')));
    assert.ok(cap.writes.some((w) => w.includes('ola mundo') && w.endsWith('\n')));
    assert.equal(ctx._counters['sink.captions.messages'], 2);
  });

  test('stdout: parcial longo (>120 chars) é truncado com reticências', async (t) => {
    const cap = captureStdout(t);
    const ctx = makeCtx({ mode: 'stdout', showParcials: true });
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    try {
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'x'.repeat(150), final: false } } as any);
    } finally {
      cap.restore();
    }
    await node.stop('done');
    const parcial = cap.writes.find((w) => w.includes('…'));
    assert.ok(parcial, 'deve truncar parcial longo');
    assert.ok(parcial!.includes('\u001B[K'));
    const visible = parcial!.replace('\r', '').replace('\u001B[K', '');
    assert.ok(visible.length <= 121);
  });

  test('stdout: showParcials=false ignora parciais mas escreve final', async (t) => {
    const cap = captureStdout(t);
    const ctx = makeCtx({ mode: 'stdout', showParcials: false });
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    try {
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'parcial', final: false } } as any);
      await node.onInput('in', { seq: 2, ts: 2, payload: { text: 'final', final: true } } as any);
    } finally {
      cap.restore();
    }
    await node.stop('done');
    assert.ok(!cap.writes.some((w) => w.includes('parcial')));
    assert.ok(cap.writes.some((w) => w.includes('final') && w.endsWith('\n')));
  });

  test('stdout: ignora control, payload vazio e payload sem texto', async (t) => {
    const cap = captureStdout(t);
    const ctx = makeCtx({ mode: 'stdout' });
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    try {
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, control: true, payload: { kind: 'interrupt' } } as any);
      await node.onInput('in', { seq: 2, ts: 2, payload: { text: '', final: true } } as any);
      await node.onInput('in', { seq: 3, ts: 3, payload: { nope: true } } as any);
    } finally {
      cap.restore();
    }
    await node.stop('done');
    assert.equal(cap.writes.length, 0);
    assert.equal(ctx._counters['sink.captions.messages'] ?? 0, 0);
  });

  test('callback: chama __onCaption com trace, não escreve stdout, salva final em outputFile', async (t) => {
    const cap = captureStdout(t);
    const dir = mkdtempSync(join(tmpdir(), 'falador-cap-'));
    const outFile = join(dir, 'out.txt');
    const calls: Array<{ text: string; final: boolean; trace?: unknown }> = [];
    const ctx = makeCtx({ mode: 'callback', outputFile: outFile }, {
      __onCaption: (c: { text: string; final: boolean; trace?: unknown }) => calls.push(c),
    });
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    try {
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'oi', final: false }, meta: { trace: { turnId: 't1' } } } as any);
      await node.onInput('in', { seq: 2, ts: 2, payload: { text: 'oi final', final: true }, meta: { trace: { turnId: 't1' } } } as any);
    } finally {
      cap.restore();
    }
    await node.stop('done');
    assert.equal(cap.writes.length, 0);
    assert.deepEqual(calls[0], { text: 'oi', final: false, trace: { turnId: 't1' } });
    assert.equal(calls[1].final, true);
    const content = readFileSync(outFile, 'utf-8');
    assert.ok(content.includes('oi final\n'));
    rmSync(dir, { recursive: true, force: true });
  });

  test('outputFile em modo stdout grava apenas finais', async (t) => {
    const cap = captureStdout(t);
    const dir = mkdtempSync(join(tmpdir(), 'falador-cap-'));
    const outFile = join(dir, 'caps.txt');
    const ctx = makeCtx({ mode: 'stdout', outputFile: outFile });
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    try {
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'parcial', final: false } } as any);
      await node.onInput('in', { seq: 2, ts: 2, payload: { text: 'fim', final: true } } as any);
    } finally {
      cap.restore();
    }
    await node.stop('done');
    assert.equal(readFileSync(outFile, 'utf-8'), 'fim\n');
    rmSync(dir, { recursive: true, force: true });
  });

  test('valida novos params de Output unificado (outputMode, isDefault, language, voice, maxQueue, playbackRate) e capture.ffmpeg isDefault', () => {
    assert.ok(sinkCaptions.validateParams!({ outputMode: 'invalid' }).some((e) => e.path === 'params.outputMode'));
    assert.ok(sinkCaptions.validateParams!({ isDefault: 'yes' }).some((e) => e.path === 'params.isDefault'));
    assert.ok(sinkCaptions.validateParams!({ language: 42 }).some((e) => e.path === 'params.language'));
    assert.ok(sinkCaptions.validateParams!({ maxQueue: 0 }).some((e) => e.path === 'params.maxQueue'));
    assert.ok(sinkCaptions.validateParams!({ playbackRate: 0 }).some((e) => e.path === 'params.playbackRate'));
    assert.ok(sinkCaptions.validateParams!({ playbackRate: -1 }).some((e) => e.path === 'params.playbackRate'));
    assert.equal(
      sinkCaptions.validateParams!({
        mode: 'callback',
        outputMode: 'speak',
        isDefault: true,
        language: 'Portuguese',
        voice: 'female',
        maxQueue: 4,
        playbackRate: 1.15,
      }).length,
      0,
    );
    assert.ok(captureFfmpeg.validateParams!({ isDefault: 'no' }).some((e) => e.path === 'params.isDefault'));
    assert.equal(captureFfmpeg.validateParams!({ backend: 'sck', isDefault: true }).length, 0);
  });

  test('outputMode=write: chama __onCaption sem fazer HTTP nem tocar áudio', async () => {
    let httpCalls = 0;
    const srv = createServer((_req, res) => {
      httpCalls += 1;
      res.writeHead(200).end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const calls: Array<{ text: string; final: boolean }> = [];
    const ctx = makeCtx(
      { mode: 'callback', outputMode: 'write', ttsUrl: `http://127.0.0.1:${port}` },
      { __onCaption: (c: { text: string; final: boolean }) => calls.push(c) },
    );
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'apenas texto', final: true } } as any);
    await node.stop('done');
    srv.close();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, 'apenas texto');
    assert.equal(httpCalls, 0);
  });

  test('outputMode=speak: escreve via __onCaption (parcial+final) E sintetiza/toca só no final', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-out-speak-'));
    const fakePlayer = join(dir, 'play.sh');
    const playedPcm = join(dir, 'played.pcm');
    writeFileSync(fakePlayer, `#!/bin/sh\ncat > "${playedPcm}"\nexit 0\n`);
    chmodSync(fakePlayer, 0o755);

    const ttsBodies: Array<{ text: string; language: string; voice: string }> = [];
    const paths: string[] = [];
    const srv = createServer((req, res) => {
      let body = '';
      paths.push(req.url ?? '');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        ttsBodies.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' });
        res.end(Buffer.alloc(4800, 7));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;

    const calls: Array<{ text: string; final: boolean }> = [];
    const ctx = makeCtx(
      {
        mode: 'callback',
        outputMode: 'speak',
        ttsUrl: `http://127.0.0.1:${port}`,
        language: 'English',
        voice: 'male',
        player: fakePlayer,
      },
      { __onCaption: (c: { text: string; final: boolean }) => calls.push(c) },
    );
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'Hello', final: false } } as any);
    await node.onInput('in', { seq: 2, ts: 2, payload: { text: 'Hello world', final: true } } as any);
    await node.stop('done');
    srv.close();

    assert.equal(calls.length, 2);
    assert.equal(calls[0].final, false);
    assert.equal(calls[1].text, 'Hello world');
    assert.deepEqual(paths, ['/tts-stream']);
    assert.equal(ttsBodies.length, 1);
    assert.deepEqual(ttsBodies[0], { text: 'Hello world', language: 'English', voice: 'male', sample_rate: 24000 });
    assert.equal(readFileSync(playedPcm).length, 4800);
    assert.ok(ctx._logs.some((l) => l.level === 'info' && l.msg.startsWith('fala:')));
    assert.ok(ctx._logs.some((l) => l.level === 'info' && l.msg.startsWith('playback ok')));
    rmSync(dir, { recursive: true, force: true });
  });

  test('outputMode=speak: começa a tocar ANTES do fim da síntese (PCM por chunk)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-out-stream-'));
    const fakePlayer = join(dir, 'play.sh');
    const playedPcm = join(dir, 'played.pcm');
    writeFileSync(fakePlayer, `#!/bin/sh\ncat > "${playedPcm}"\nexit 0\n`);
    chmodSync(fakePlayer, 0o755);

    let ended = false;
    const srv = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' });
      res.write(Buffer.alloc(4800, 1)); // 100 ms já prontos
      setTimeout(() => {
        res.write(Buffer.alloc(4800, 2));
        res.end();
        ended = true;
      }, 1200);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;

    const ctx = makeCtx(
      { mode: 'callback', outputMode: 'speak', ttsUrl: `http://127.0.0.1:${port}`, player: fakePlayer },
      { __onCaption: () => {} },
    );
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'fala longa', final: true } } as any);
    await delay(800); // meio da síntese (o shell do player leva ~200 ms p/ subir aqui)
    const midBytes = existsSync(playedPcm) ? readFileSync(playedPcm).length : 0;
    const endedMid = ended;
    await node.stop('done');
    srv.close();
    assert.equal(endedMid, false, 'síntese ainda não terminou no meio da checagem');
    assert.equal(midBytes, 4800, 'player deve ter recebido o 1º chunk antes do fim da síntese');
    assert.equal(ended, true);
    assert.ok((ctx._timers['sink.captions.ttft.ms']?.length ?? 0) >= 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('fluxos tradutor e tradutor-omni: fala em streaming com os params reais de cada flow', async () => {
    const flowsDir = new URL('../../../apps/tui/flows/', import.meta.url);
    for (const file of ['tradutor.json', 'tradutor-omni.json']) {
      const flow = JSON.parse(readFileSync(new URL(file, flowsDir), 'utf-8')) as {
        nodes: Array<{ type: string; params: Record<string, unknown> }>;
      };
      const sink = flow.nodes.find((n) => n.type === 'sink.captions');
      if (!sink) {
        const asrTranslate = flow.nodes.find((n) => n.type === 'asr.realtime.translate');
        assert.ok(asrTranslate && asrTranslate.params?.outputRequired !== true, `${file} sem sink.captions exige asr.realtime.translate com outputRequired !== true`);
        continue;
      }
      const params = sink.params;
      assert.equal(params.outputMode, 'write', `${file}: default salvo é write (sem duplicar fala do Chrome)`);
      assert.equal(params.language, 'Portuguese', file);
      assert.ok(params.voice === 'male' || params.voice === 'female', `${file}: voice deve ser male ou female`);
      assert.equal(params.playbackRate, 1.25, file);
      assert.match(String(params.ttsUrl), /^http:\/\/127\.0\.0\.1:809[12]$/, file);

      const dir = mkdtempSync(join(tmpdir(), `falador-flow-${file}-`));
      const fakePlayer = join(dir, 'play.sh');
      const playedPcm = join(dir, 'played.pcm');
      const playedArgs = join(dir, 'args.txt');
      writeFileSync(
        fakePlayer,
        `#!/bin/sh\nprintf '%s\\n' "$@" > "${playedArgs}"\ncat > "${playedPcm}"\nexit 0\n`,
      );
      chmodSync(fakePlayer, 0o755);

      const paths: string[] = [];
      const bodies: Array<Record<string, unknown>> = [];
      const srv = createServer((req, res) => {
        let body = '';
        paths.push(req.url ?? '');
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          bodies.push(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' });
          res.write(Buffer.alloc(4800, 1)); // 4 frames de 80 ms
          setTimeout(() => res.end(Buffer.alloc(4800, 2)), 30);
        });
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      const port = (srv.address() as { port: number }).port;

      const ctx = makeCtx(
        { ...params, outputMode: 'speak', ttsUrl: `http://127.0.0.1:${port}`, player: fakePlayer },
        { __onCaption: () => {} },
      );
      const node = sinkCaptions.create(ctx) as NodeRuntime;
      await node.start();
      await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'frase de teste', final: true } } as any);
      await node.stop('done');
      srv.close();

      assert.deepEqual(paths, ['/tts-stream'], file);
      assert.deepEqual(
        bodies[0],
        { text: 'frase de teste', language: params.language, voice: params.voice, sample_rate: 24000 },
        file,
      );
      assert.equal(readFileSync(playedPcm).length, 9600, file);
      const args = readFileSync(playedArgs, 'utf-8').trim().split('\n');
      assert.ok(args.includes('-f') && args.includes('s16le'), `${file}: player deve ler PCM cru`);
      assert.ok(args.includes('-ar') && args.includes('24000'), `${file}: sample rate do header`);
      assert.ok(args.join(' ').includes('atempo=1.25'), `${file}: playbackRate do flow`);
      assert.ok(ctx._logs.some((l) => l.level === 'info' && l.msg.includes('streaming 24000 Hz')), file);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('outputMode=speak: interrupt cancela playback em curso e encerra limpo no stop()', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-out-int-'));
    const fakePlayer = join(dir, 'slow-play.sh');
    writeFileSync(fakePlayer, '#!/bin/sh\nsleep 10\n');
    chmodSync(fakePlayer, 0o755);

    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' });
      res.end(Buffer.alloc(9600, 3));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;

    const ctx = makeCtx(
      { mode: 'callback', outputMode: 'speak', ttsUrl: `http://127.0.0.1:${port}`, player: fakePlayer },
      { __onCaption: () => {} },
    );
    const node = sinkCaptions.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'falando longo', final: true } } as any);
    await delay(120);
    node.onControl!({ kind: 'interrupt', sourceNode: 'asr' });
    await node.stop('done');
    srv.close();
    assert.equal(ctx._counters['sink.captions.interrupted'], 1);
    rmSync(dir, { recursive: true, force: true });
  });

  test('model param: valida tipo string e model="-" / "—" força só-texto mesmo com outputMode=speak', async () => {
    assert.ok(sinkCaptions.validateParams!({ model: 123 }).some((e) => e.path === 'params.model'));
    assert.equal(sinkCaptions.validateParams!({ model: '-', outputMode: 'speak' }).length, 0);
    assert.equal(sinkCaptions.validateParams!({ model: 'LFM3-Audio-2B-MLX-8bit', outputMode: 'speak' }).length, 0);

    let httpCalls = 0;
    const srv = createServer((_req, res) => {
      httpCalls += 1;
      res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' }).end(Buffer.alloc(2400, 1));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;

    try {
      for (const modelVal of ['-', '—']) {
        const dir = mkdtempSync(join(tmpdir(), 'falador-out-dash-'));
        const marker = join(dir, 'played');
        const fakePlayer = fakePlayerScript(`echo 1 >> "${marker}"; exit 0`);
        const calls: Array<{ text: string; final: boolean }> = [];
        const ctx = makeCtx(
          {
            mode: 'callback',
            outputMode: 'speak',
            model: modelVal,
            ttsUrl: `http://127.0.0.1:${port}`,
            player: fakePlayer,
          },
          { __onCaption: (c: { text: string; final: boolean }) => calls.push(c) },
        );
        const node = sinkCaptions.create(ctx) as NodeRuntime;
        await node.start();
        await node.onInput('in', { seq: 1, ts: 1, payload: { text: `frase ${modelVal}`, final: true } } as any);
        await node.stop('done');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].text, `frase ${modelVal}`);
        assert.equal(httpCalls, 0, `model=${modelVal} não deve chamar /tts-stream`);
        assert.equal(existsSync(marker), false, `model=${modelVal} não deve spawnar player`);
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      srv.close();
    }
  });

  test('mute de áudio da janela (__isAudioMuted + __registerAudioMuteListener): suprime fala mantendo legenda, corta player ao vivo e retoma ao desmutar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-out-mute-'));
    const pidFile = join(dir, 'pid');
    const playedCountFile = join(dir, 'played-count');
    // No 1º play grava PID e dorme (para ser interrompido no meio pelo mute); no 2º consome stdin e registra conclusão
    const fakePlayer = join(dir, 'play.sh');
    writeFileSync(
      fakePlayer,
      `#!/bin/sh\nif [ ! -f "${pidFile}" ]; then\n  echo $$ > "${pidFile}"\n  sleep 30\n  exit 0\nfi\ncat > /dev/null\necho ok >> "${playedCountFile}"\nexit 0\n`,
      { mode: 0o755 },
    );
    chmodSync(fakePlayer, 0o755);

    const ttsTexts: string[] = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        ttsTexts.push(JSON.parse(body).text);
        res.writeHead(200, { 'Content-Type': 'audio/pcm', 'X-Sample-Rate': '24000' });
        res.end(Buffer.alloc(4800, 5));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;

    let muted = true;
    const listeners = new Set<(m: boolean) => void>();
    let unsubCalled = 0;
    const setMuted = (val: boolean) => {
      muted = val;
      for (const fn of [...listeners]) fn(muted);
    };

    const captions: Array<{ text: string; final: boolean }> = [];
    const outFile = join(dir, 'captions.txt');
    const ctx = makeCtx(
      {
        mode: 'callback',
        outputMode: 'speak',
        outputFile: outFile,
        ttsUrl: `http://127.0.0.1:${port}`,
        player: fakePlayer,
      },
      {
        __onCaption: (c: { text: string; final: boolean }) => captions.push(c),
        __isAudioMuted: () => muted,
        __registerAudioMuteListener: (fn: (m: boolean) => void) => {
          listeners.add(fn);
          return () => {
            unsubCalled += 1;
            listeners.delete(fn);
          };
        },
      },
    );

    const node = sinkCaptions.create(ctx) as NodeRuntime;
    await node.start();

    // 1) Nasce mutado: legendas (parcial + final) e arquivo saem normalmente, zero /tts-stream
    await node.onInput('in', { seq: 1, ts: 1, payload: { text: 'mutado parcial', final: false } } as any);
    await node.onInput('in', { seq: 2, ts: 2, payload: { text: 'mutado final', final: true } } as any);
    await delay(80);
    assert.equal(captions.length, 2);
    assert.equal(captions[1].text, 'mutado final');
    assert.equal(ttsTexts.length, 0, 'enquanto mutado não deve chamar /tts-stream');

    // 2) Desmuta e fala frase longa -> muta no meio -> interrompe player ativo na hora
    setMuted(false);
    await node.onInput('in', { seq: 3, ts: 3, payload: { text: 'falando ao vivo', final: true } } as any);
    await waitFor(() => existsSync(pidFile), 3000);
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    assert.ok(pid > 0);
    assert.deepEqual(ttsTexts, ['falando ao vivo']);

    setMuted(true);
    await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 3000);

    // 3) Frase enquanto mutado de novo: só legenda
    await node.onInput('in', { seq: 4, ts: 4, payload: { text: 'silenciado de novo', final: true } } as any);
    await delay(60);
    assert.equal(ttsTexts.length, 1);

    // 4) Desmuta novamente: próxima frase volta a falar sem reiniciar o nó
    setMuted(false);
    await node.onInput('in', { seq: 5, ts: 5, payload: { text: 'voltou a falar', final: true } } as any);
    await waitFor(() => existsSync(playedCountFile), 3000);

    await node.stop('done');
    srv.close();

    assert.deepEqual(ttsTexts, ['falando ao vivo', 'voltou a falar']);
    assert.equal(captions.filter((c) => c.final).length, 4, 'todas as 4 frases finais emitiram legenda');
    assert.equal(
      readFileSync(outFile, 'utf-8'),
      'mutado final\nfalando ao vivo\nsilenciado de novo\nvoltou a falar\n',
    );
    assert.equal(unsubCalled, 1, 'stop() deve desregistrar o listener de mute');
    assert.equal(listeners.size, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---- sink.playback ---------------------------------------------------------

describe('sink.playback', () => {
  test('valida params', () => {
    assert.ok(sinkPlayback.validateParams!({ player: 1 }).some((e) => e.path === 'params.player'));
    assert.ok(sinkPlayback.validateParams!({ muted: 'x' }).some((e) => e.path === 'params.muted'));
    assert.ok(sinkPlayback.validateParams!({ maxQueue: 0 }).some((e) => e.path === 'params.maxQueue'));
    assert.ok(sinkPlayback.validateParams!({ playbackRate: 0 }).some((e) => e.path === 'params.playbackRate'));
    assert.equal(sinkPlayback.validateParams!({ player: '/bin/true', maxQueue: 2, muted: false, playbackRate: 1.2 }).length, 0);
  });

  test('toca WAV com player fake, registra timer e limpa temp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-play-'));
    const marker = join(dir, 'played');
    const player = fakePlayerScript(`echo played >> "${marker}"; exit 0`);
    const ctx = makeCtx({ player, maxQueue: 4 });
    const node = sinkPlayback.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: wavPayload() } as any);
    await waitFor(() => existsSync(marker), 3000);
    await node.stop('done');
    assert.ok(existsSync(marker), 'player deve ter sido chamado');
    assert.ok((ctx._timers['sink.playback.ms']?.length ?? 0) >= 1);
    assert.ok(ctx._logs.some((l) => l.level === 'info' && l.msg.includes('playback ok')));
    rmSync(dir, { recursive: true, force: true });
  });

  test('muted ignora input sem spawnar player', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-play-'));
    const marker = join(dir, 'played');
    const player = fakePlayerScript(`echo played >> "${marker}"`);
    const ctx = makeCtx({ player, muted: true });
    const node = sinkPlayback.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: wavPayload() } as any);
    await node.stop('done');
    assert.ok(!existsSync(marker));
    rmSync(dir, { recursive: true, force: true });
  });

  test('payload inválido é descartado com warn', async () => {
    const ctx = makeCtx({ player: '/usr/bin/true' });
    const node = sinkPlayback.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: { format: 'mp3', data: new Uint8Array(2) } } as any);
    await node.onInput('in', { seq: 2, ts: 2, payload: 'not-audio' } as any);
    await node.onInput('in', { seq: 3, ts: 3, control: true, payload: { kind: 'interrupt' } } as any);
    await node.stop('done');
    const warns = ctx._logs.filter((l) => l.level === 'warn' && l.msg.includes('descartado'));
    assert.equal(warns.length, 2);
  });

  test('maxQueue ao vivo: descarta backlog pendente antigo e mantém o mais recente', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-play-'));
    const marker = join(dir, 'count');
    // player lento para manter fila ocupada; maxQueue=2 => 1 tocando + 1 pendente
    const player = fakePlayerScript(`echo 1 >> "${marker}"; sleep 0.25; exit 0`);
    const ctx = makeCtx({ player, maxQueue: 2 });
    const node = sinkPlayback.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: wavPayload() } as any); // toca
    await node.onInput('in', { seq: 2, ts: 2, payload: wavPayload() } as any); // pendente
    await node.onInput('in', { seq: 3, ts: 3, payload: wavPayload() } as any); // derruba seq2, fica pendente
    await waitFor(() => (ctx._counters['sink.playback.dropped'] ?? 0) >= 1, 2000);
    await waitFor(() => existsSync(marker), 3000);
    await node.stop('done');
    assert.ok((ctx._counters['sink.playback.dropped'] ?? 0) >= 1);
    assert.ok(ctx._logs.some((l) => l.level === 'warn' && (l.msg.includes('mais recente') || l.msg.includes('backlog antigo descartado'))));
    const lines = readFileSync(marker, 'utf-8').trim().split('\n').filter(Boolean).length;
    assert.ok(lines >= 1 && lines <= 2, `esperava 1-2 reproduções (atual+mais recente), veio ${lines}`);
    rmSync(dir, { recursive: true, force: true });
  });

  test('playbackRate é passado ao afplay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-play-rate-'));
    const argsFile = join(dir, 'args.txt');
    const player = fakePlayerScript(`echo "$@" > "${argsFile}"; exit 0`);
    const ctx = makeCtx({ player, maxQueue: 4, playbackRate: 1.25 });
    const node = sinkPlayback.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: wavPayload() } as any);
    await waitFor(() => existsSync(argsFile), 3000);
    await node.stop('done');
    const args = readFileSync(argsFile, 'utf-8');
    assert.match(args, /-r 1\.25/);
    assert.match(args, /-q 1/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('erro do player loga error e não trava stop', async () => {
    const player = fakePlayerScript('exit 7');
    const ctx = makeCtx({ player, maxQueue: 4 });
    const node = sinkPlayback.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: wavPayload() } as any);
    await waitFor(() => ctx._logs.some((l) => l.level === 'error' && l.msg.includes('afplay exit')), 3000);
    await node.stop('done');
    assert.ok(ctx._logs.some((l) => l.level === 'error' && l.msg.includes('afplay exit 7')));
  });

  test('interrupt mata o child ativo e incrementa sink.playback.interrupted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-play-'));
    const pidFile = join(dir, 'pid');
    const player = fakePlayerScript(`echo $$ > "${pidFile}"; sleep 30`);
    const ctx = makeCtx({ player, maxQueue: 4 });
    const node = sinkPlayback.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: wavPayload() } as any);
    await waitFor(() => existsSync(pidFile), 2000);
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    assert.ok(pid > 0);
    node.onControl?.({ kind: 'interrupt', scope: 'node', reason: 'test' } as any);
    await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 3000);
    assert.equal(ctx._counters['sink.playback.interrupted'], 1);
    await node.stop('done');
    rmSync(dir, { recursive: true, force: true });
  });

  test('stop() aguarda fala em curso antes de limpar temp dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-play-'));
    const started = join(dir, 'started');
    const player = fakePlayerScript(`echo 1 > "${started}"; sleep 0.3; exit 0`);
    const ctx = makeCtx({ player, maxQueue: 4 });
    const node = sinkPlayback.create(ctx) as NodeRuntime;
    await node.start();
    await node.onInput('in', { seq: 1, ts: 1, payload: wavPayload() } as any);
    await waitFor(() => existsSync(started), 2000);
    const t0 = Date.now();
    await node.stop('done');
    assert.ok(Date.now() - t0 >= 150, 'stop deve aguardar fala em curso');
    rmSync(dir, { recursive: true, force: true });
  });

  test('mute de áudio da janela em sink.playback: descarta mutado, mata player no meio e volta ao desmutar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-play-winmute-'));
    const pidFile = join(dir, 'pid');
    const doneFile = join(dir, 'done');
    const player = fakePlayerScript(
      `if [ ! -f "${pidFile}" ]; then echo $$ > "${pidFile}"; sleep 30; exit 0; fi; echo ok >> "${doneFile}"; exit 0`,
    );

    let muted = true;
    const listeners = new Set<(m: boolean) => void>();
    let unsub = 0;
    const setMuted = (v: boolean) => {
      muted = v;
      for (const fn of [...listeners]) fn(muted);
    };

    const ctx = makeCtx(
      { player, maxQueue: 4 },
      {
        __isAudioMuted: () => muted,
        __registerAudioMuteListener: (fn: (m: boolean) => void) => {
          listeners.add(fn);
          return () => { unsub += 1; listeners.delete(fn); };
        },
      },
    );
    const node = sinkPlayback.create(ctx) as NodeRuntime;
    await node.start();

    // Mutado: ignora sem erro
    await node.onInput('in', { seq: 1, ts: 1, payload: wavPayload() } as any);
    await delay(60);
    assert.equal(existsSync(pidFile), false);

    // Desmuta -> começa a tocar -> muta no meio -> mata child
    setMuted(false);
    await node.onInput('in', { seq: 2, ts: 2, payload: wavPayload() } as any);
    await waitFor(() => existsSync(pidFile), 3000);
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    setMuted(true);
    await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 3000);

    // Desmuta de novo -> próximo chunk toca até o fim
    setMuted(false);
    await node.onInput('in', { seq: 3, ts: 3, payload: wavPayload() } as any);
    await waitFor(() => existsSync(doneFile), 3000);

    await node.stop('done');
    assert.equal(unsub, 1);
    assert.equal(ctx._logs.filter((l) => l.level === 'error').length, 0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---- capture.ffmpeg -------------------------------------------------------

describe('capture.ffmpeg', () => {
  test('valida params', () => {
    assert.ok(captureFfmpeg.validateParams!({ backend: 'nope' }).some((e) => e.path === 'params.backend'));
    assert.ok(captureFfmpeg.validateParams!({ input: 1 }).some((e) => e.path === 'params.input'));
    assert.ok(captureFfmpeg.validateParams!({ muted: 'x' }).some((e) => e.path === 'params.muted'));
    assert.ok(captureFfmpeg.validateParams!({ sampleRate: 0 }).some((e) => e.path === 'params.sampleRate'));
    assert.ok(captureFfmpeg.validateParams!({ chunkMs: -1 }).some((e) => e.path === 'params.chunkMs'));
    assert.ok(captureFfmpeg.validateParams!({ ffmpegPath: 1 }).some((e) => e.path === 'params.ffmpegPath'));
    assert.equal(captureFfmpeg.validateParams!({ backend: 'ffmpeg', input: ':0', sampleRate: 16000, chunkMs: 80 }).length, 0);
  });

  test('muted=true não spawna child', async () => {
    const ctx = makeCtx({ backend: 'ffmpeg', ffmpegPath: '/no/such/bin', muted: true });
    const node = captureFfmpeg.create(ctx) as NodeRuntime;
    await node.start(); // não deve lançar
    await node.stop('done');
    assert.equal(ctx._emitted.length, 0);
    assert.ok(ctx._logs.some((l) => l.msg.includes('silenciado')));
  });

  test('backend ffmpeg: chunking 80ms/2560 bytes e contadores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-cap-'));
    // emite 5120 bytes (2 chunks) e depois dorme
    const fakeFfmpeg = join(dir, 'fake-ffmpeg');
    writeFileSync(fakeFfmpeg, `#!/bin/sh\nhead -c 5120 /dev/zero\nsleep 30\n`, { mode: 0o755 });
    chmodSync(fakeFfmpeg, 0o755);
    const ctx = makeCtx({ backend: 'ffmpeg', ffmpegPath: fakeFfmpeg, sampleRate: 16000, chunkMs: 80 });
    const node = captureFfmpeg.create(ctx) as NodeRuntime;
    await node.start();
    await waitFor(() => ctx._emitted.length >= 2, 3000);
    await node.stop('done');
    assert.equal(ctx._emitted[0].port, 'out');
    assert.ok(ctx._emitted[0].payload instanceof Uint8Array);
    assert.equal((ctx._emitted[0].payload as Uint8Array).byteLength, 2560);
    assert.equal((ctx._emitted[1].payload as Uint8Array).byteLength, 2560);
    assert.ok((ctx._counters['capture.ffmpeg.chunks'] ?? 0) >= 2);
    assert.ok((ctx._counters['capture.ffmpeg.bytes'] ?? 0) >= 5120);
    rmSync(dir, { recursive: true, force: true });
  });

  test('backend sounddevice: usa pythonPath+sidecarPath e emite chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-cap-'));
    // script "python" fake: ignora args, emite 2560 bytes e dorme
    const fakePy = join(dir, 'fake-python');
    writeFileSync(fakePy, `#!/bin/sh\nhead -c 2560 /dev/zero\nsleep 30\n`, { mode: 0o755 });
    chmodSync(fakePy, 0o755);
    const ctx = makeCtx({ backend: 'sounddevice', pythonPath: fakePy, sidecarPath: '/fake/sidecar.py', sampleRate: 16000, chunkMs: 80 });
    const node = captureFfmpeg.create(ctx) as NodeRuntime;
    await node.start();
    await waitFor(() => ctx._emitted.length >= 1, 3000);
    await node.stop('done');
    assert.equal((ctx._emitted[0].payload as Uint8Array).byteLength, 2560);
    rmSync(dir, { recursive: true, force: true });
  });

  test('spawn error propaga no start', async () => {
    const ctx = makeCtx({ backend: 'ffmpeg', ffmpegPath: '/definitely/missing/ffmpeg-binary' });
    const node = captureFfmpeg.create(ctx) as NodeRuntime;
    await assert.rejects(() => node.start());
    await node.stop('cleanup');
  });

  test('stop mata child ativo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-cap-'));
    const pidFile = join(dir, 'pid');
    const fakeFfmpeg = join(dir, 'fake-ffmpeg');
    writeFileSync(fakeFfmpeg, `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 30\n`, { mode: 0o755 });
    chmodSync(fakeFfmpeg, 0o755);
    const ctx = makeCtx({ backend: 'ffmpeg', ffmpegPath: fakeFfmpeg });
    const node = captureFfmpeg.create(ctx) as NodeRuntime;
    await node.start();
    await waitFor(() => existsSync(pidFile), 2000);
    const pid = Number(readFileSync(pidFile, 'utf-8').trim());
    await node.stop('done');
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000);
    rmSync(dir, { recursive: true, force: true });
  });

  test('abort do signal impede emissão de chunks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-cap-'));
    const gate = join(dir, 'gate');
    const fakeFfmpeg = join(dir, 'fake-ffmpeg');
    writeFileSync(fakeFfmpeg, `#!/bin/sh\nwhile [ ! -f "${gate}" ]; do sleep 0.05; done\nhead -c 5120 /dev/zero\nsleep 30\n`, { mode: 0o755 });
    chmodSync(fakeFfmpeg, 0o755);
    const ac = new AbortController();
    const ctx = makeCtx({ backend: 'ffmpeg', ffmpegPath: fakeFfmpeg });
    (ctx as any).signal = ac.signal;
    const node = captureFfmpeg.create(ctx) as NodeRuntime;
    await node.start();
    ac.abort();
    writeFileSync(gate, 'go');
    await delay(300);
    await node.stop('done');
    assert.equal(ctx._emitted.length, 0, 'não deve emitir após abort');
    rmSync(dir, { recursive: true, force: true });
  });

  test('child encerra inesperadamente e loga warn/error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'falador-cap-'));
    const fakeFfmpeg = join(dir, 'fake-ffmpeg');
    writeFileSync(fakeFfmpeg, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    chmodSync(fakeFfmpeg, 0o755);
    const ctx = makeCtx({ backend: 'ffmpeg', ffmpegPath: fakeFfmpeg });
    const node = captureFfmpeg.create(ctx) as NodeRuntime;
    await node.start();
    await waitFor(() => ctx._logs.some((l) => l.msg.includes('encerrou')), 3000);
    assert.ok(ctx._logs.some((l) => l.level === 'error' && l.msg.includes('code=1')));
    await node.stop('done');
    rmSync(dir, { recursive: true, force: true });
  });
});
