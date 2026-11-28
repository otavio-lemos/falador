// falador-nodes — sinks: legenda no terminal e reprodução de áudio (afplay).
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlMsg, NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { payloadText } from './sse.ts';
import { ttsSts as _ttsSts } from './tts-sts.ts';
import type { AudioChunkPayload } from './tts-sts.ts';
import type { TraceMeta } from './trace.ts';

// ---- sink.captions (Output unificado: Escrever + Falar) ---------------------

export const sinkCaptions: NodeTypeDef = {
  type: 'sink.captions',
  sink: true,
  paramNames: [
    'mode',
    'showParcials',
    'outputFile',
    'outputMode',
    'isDefault',
    'ttsUrl',
    'language',
    'voice',
    'sampleRateHz',
    'timeoutMs',
    'maxTextChars',
    'player',
    'playbackRate',
    'maxQueue',
    'model',
  ],
  bindingNames: ['__onCaption', '__isAudioMuted', '__registerAudioMuteListener'],
  inputs: [
    { name: 'in', type: 'tokens_parcial' },
    { name: 'phrase', type: 'phrase' },
  ],
  outputs: [],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    if (p.mode !== undefined && p.mode !== 'stdout' && p.mode !== 'callback') {
      errs.push({ path: 'params.mode', code: 'INVALID_PARAM', message: "mode deve ser 'stdout' | 'callback'" });
    }
    if (p.outputMode !== undefined && p.outputMode !== 'write' && p.outputMode !== 'speak') {
      errs.push({ path: 'params.outputMode', code: 'INVALID_PARAM', message: "outputMode deve ser 'write' | 'speak'" });
    }
    for (const k of ['showParcials', 'isDefault'] as const) {
      if (p[k] !== undefined && typeof p[k] !== 'boolean') {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser boolean` });
      }
    }
    for (const k of ['outputFile', 'ttsUrl', 'language', 'voice', 'player', 'model'] as const) {
      if (p[k] !== undefined && typeof p[k] !== 'string') {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser string` });
      }
    }
    for (const k of ['sampleRateHz', 'timeoutMs', 'maxTextChars', 'playbackRate'] as const) {
      if (p[k] !== undefined && (typeof p[k] !== 'number' || p[k] <= 0)) {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser número > 0` });
      }
    }
    if (p.maxQueue !== undefined && (typeof p.maxQueue !== 'number' || p.maxQueue < 1)) {
      errs.push({ path: 'params.maxQueue', code: 'INVALID_PARAM', message: 'maxQueue deve ser número >= 1' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const mode = (ctx.params.mode as 'stdout' | 'callback' | undefined) ?? 'stdout';
    const showParcials = (ctx.params.showParcials as boolean | undefined) ?? true;
    const outputFile = (ctx.params.outputFile as string | undefined);
    const rawOutputMode = (ctx.params.outputMode as 'write' | 'speak' | undefined) ?? 'write';
    const rawModel = typeof ctx.params.model === 'string' ? ctx.params.model.trim() : undefined;
    const outputMode: 'write' | 'speak' =
      ctx.params.model === '-' || ctx.params.model === '—' || rawModel === '-' || rawModel === '—'
        ? 'write'
        : rawOutputMode;
    const isOmni = Boolean(rawModel && /lfm.*omni/i.test(rawModel));
    const isLfmAudio = Boolean(rawModel && /lfm.*audio/i.test(rawModel));
    const rawParamUrl = typeof ctx.params.ttsUrl === 'string' ? ctx.params.ttsUrl.trim() : '';
    const isDefaultSidecarUrl =
      rawParamUrl === '' ||
      rawParamUrl === 'http://127.0.0.1:8091' ||
      rawParamUrl === 'http://127.0.0.1:8092';
    const resolvedTtsUrl = isDefaultSidecarUrl
      ? (isOmni ? 'http://127.0.0.1:8092' : isLfmAudio ? 'http://127.0.0.1:8091' : (rawParamUrl || 'http://127.0.0.1:8091'))
      : rawParamUrl;
    const ttsUrl = resolvedTtsUrl.replace(/\/+$/, '');
    const language = (ctx.params.language as string | undefined) ?? 'Portuguese';
    const voice = (ctx.params.voice as string | undefined) ?? 'female';
    const sampleRateHz = (ctx.params.sampleRateHz as number | undefined) ?? 24000;
    const timeoutMs = (ctx.params.timeoutMs as number | undefined) ?? 60_000;
    const maxTextChars = (ctx.params.maxTextChars as number | undefined) ?? 1400;
    const player = (ctx.params.player as string | undefined) ?? '/opt/homebrew/bin/ffplay';
    const playbackRate = (ctx.params.playbackRate as number | undefined) ?? 1.25;
    const maxQueue = (ctx.params.maxQueue as number | undefined) ?? 2;
    const cb = ctx.bindings.__onCaption as
      | ((c: { text: string; final: boolean; trace?: TraceMeta }) => void)
      | undefined;
    const isAudioMuted = ctx.bindings.__isAudioMuted as (() => boolean) | undefined;
    const registerMute = ctx.bindings.__registerAudioMuteListener as
      | ((fn: (muted: boolean) => void) => (() => void) | void)
      | undefined;

    // stream de arquivo aberto só se outputFile definido
    let fileStream: ReturnType<typeof createWriteStream> | null = null;
    if (outputFile) {
      fileStream = createWriteStream(outputFile, { flags: 'a', encoding: 'utf-8' });
    }

    let pending = 0;
    let dropped = 0;
    let stopped = false;
    let generation = 0;
    let clearGen = -1;
    let activeCtrl: AbortController | null = null;
    let activeChild: ChildProcess | null = null;
    // Fila só de pendentes (o item em reprodução não entra aqui). Ao atrasar, derruba backlog antigo e mantém o mais recente.
    const speakQueue: Array<{ text: string; gen: number }> = [];
    let speakPump: Promise<void> = Promise.resolve();

    const unsubMute = registerMute?.((muted: boolean) => {
      if (muted) {
        clearGen = generation;
        generation += 1;
        activeCtrl?.abort();
        activeCtrl = null;
        if (activeChild) {
          try { activeChild.kill('SIGKILL'); } catch { /* ignore */ }
          activeChild = null;
        }
        speakQueue.length = 0;
        pending = 0;
      }
    });

    function write(text: string, final: boolean): void {
      if (!text) return;
      if (!final) {
        if (!showParcials) return;
        const line = text.length > 120 ? '…' + text.slice(-119) : text;
        process.stdout.write(`\r${line}\u001B[K`);
      } else {
        process.stdout.write(`\r${text}\u001B[K\n`);
        // salva só linhas finais no arquivo
        if (fileStream) fileStream.write(text + '\n');
      }
      ctx.metrics.counter('sink.captions.messages', 1);
    }

    // Fala em streaming: o sidecar manda PCM s16le por frame (80 ms) enquanto o
    // modelo gera e o player toca em paralelo. O 1º som cai de "frase inteira
    // sintetizada" (~1,2 s) para ~0,2 s.
    async function synthesizeAndPlay(text: string, myGen: number): Promise<void> {
      if (ctx.signal.aborted || myGen !== generation || isAudioMuted?.() === true) return;
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean) return;
      const truncated = clean.length > maxTextChars ? clean.slice(0, maxTextChars) + '…' : clean;

      const ctrl = new AbortController();
      activeCtrl = ctrl;
      const onAbort = () => ctrl.abort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      const tTts = Date.now();
      let res: Response;
      try {
        res = await fetch(`${ttsUrl}/tts-stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: truncated, language, voice, sample_rate: sampleRateHz }),
          // timeoutMs cobre só a espera pelo 1º chunk (o corpo flui até o fim da fala)
          signal: AbortSignal.any([ctrl.signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (e: unknown) {
        const err = e as Error;
        if (err?.name !== 'AbortError' && !ctx.signal.aborted && myGen === generation) {
          ctx.log('error', `output.tts falhou: ${err?.message ?? String(e)}`);
          ctx.metrics.counter('sink.captions.tts_errors', 1);
        }
        return;
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
        if (activeCtrl === ctrl) activeCtrl = null;
      }

      if (!res.ok || !res.body) {
        ctx.log('error', `output.tts: /tts-stream respondeu HTTP ${res.status}`);
        ctx.metrics.counter('sink.captions.tts_errors', 1);
        return;
      }
      if (ctx.signal.aborted || myGen !== generation || isAudioMuted?.() === true) return;

      const sr = Number(res.headers.get('x-sample-rate')) || sampleRateHz;
      const args = ['-f', 's16le', '-ar', String(sr), '-ch_layout', 'mono', '-nodisp', '-autoexit', '-loglevel', 'error'];
      if (playbackRate !== 1) args.push('-af', `atempo=${playbackRate}`);
      args.push('-');
      ctx.log('info', `fala: "${clean.slice(0, 80)}" (streaming ${sr} Hz)`);

      const tPlay = Date.now();
      let bytes = 0;
      try {
        await new Promise<void>((resolve, reject) => {
          const p = spawn(player, args, { stdio: ['pipe', 'ignore', 'ignore'] });
          activeChild = p;
          let settled = false;
          const onPlayAbort = () => {
            try { p.kill('SIGKILL'); } catch { /* ignore */ }
          };
          const done = (err?: Error) => {
            if (settled) return;
            settled = true;
            ctx.signal.removeEventListener('abort', onPlayAbort);
            if (activeChild === p) activeChild = null;
            if (err) reject(err);
            else resolve();
          };
          ctx.signal.addEventListener('abort', onPlayAbort, { once: true });
          p.on('error', (err) => done(err));
          p.on('close', (code) => {
            if (code === 0 || code === null || myGen !== generation) done();
            else done(new Error(`${player} exit ${code}`));
          });
          p.stdin?.on('error', () => { /* EPIPE ao interromper */ });
          // Sem esperar drain: o stdin absorve a frase (~KB) e o sidecar termina de
          // gerar rápido em vez de ficar preso no ritmo da reprodução.
          void (async () => {
            try {
              for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
                if (myGen !== generation || p.exitCode !== null || isAudioMuted?.() === true) break;
                bytes += chunk.byteLength;
                p.stdin?.write(Buffer.from(chunk));
              }
            } catch { /* abort/EPIPE */ }
            try { p.stdin?.end(); } catch { /* ignore */ }
          })();
        });
        if (myGen === generation) {
          ctx.metrics.timer('sink.captions.ttft.ms', tPlay - tTts);
          ctx.metrics.timer('sink.captions.playback.ms', Date.now() - tPlay);
          ctx.log(
            'info',
            `playback ok (${((Date.now() - tPlay) / 1000).toFixed(1)}s, ${(bytes / 1024).toFixed(0)} KB)`,
          );
        }
      } catch (e: unknown) {
        if (myGen === generation && !ctx.signal.aborted) {
          ctx.log('error', `output.playback: ${String(e)}`);
        }
      }
    }

    function pumpSpeak(): void {
      speakPump = speakPump.then(async () => {
        while (!stopped) {
          const next = speakQueue.shift();
          if (!next) break;
          try {
            await synthesizeAndPlay(next.text, next.gen);
          } catch (e: unknown) {
            ctx.log('error', `output.playback: ${String(e)}`);
          } finally {
            if (next.gen > clearGen) pending = Math.max(0, pending - 1);
          }
        }
      }).catch(() => { /* mantém cadeia viva */ });
    }

    function enqueueSpeak(text: string): void {
      if (outputMode !== 'speak' || stopped || ctx.signal.aborted || isAudioMuted?.() === true) return;
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean) return;
      // pending conta item em reprodução + pendentes na fila
      while (pending >= maxQueue && speakQueue.length > 0) {
        speakQueue.shift(); // descarta backlog antigo; mantém o mais recente
        pending -= 1;
        dropped += 1;
        ctx.metrics.counter('sink.captions.dropped', 1);
      }
      if (pending >= maxQueue) {
        dropped += 1;
        ctx.metrics.counter('sink.captions.dropped', 1);
        ctx.log('warn', `output: fila de fala cheia, mantendo a mais recente (${dropped} descartada(s))`);
        return;
      }
      speakQueue.push({ text: clean, gen: generation });
      pending += 1;
      if (dropped > 0) ctx.log('warn', `output: backlog antigo descartado para manter ao vivo (${dropped} total)`);
      pumpSpeak();
    }

    return {
      async start() {},
      async onInput(_port, msg) {
        if (msg.control) return;
        const pl = payloadText(msg.payload);
        if (!pl) return;
        if (mode === 'callback') {
          const trace =
            msg.meta?.trace && typeof msg.meta.trace === 'object'
              ? (msg.meta.trace as TraceMeta)
              : undefined;
          cb?.(trace ? { text: pl.text, final: pl.final, trace } : { text: pl.text, final: pl.final });
          // também salva no arquivo quando em modo callback
          if (fileStream && pl.final && pl.text) fileStream.write(pl.text + '\n');
          if (pl.final) enqueueSpeak(pl.text);
          return;
        }
        const isParcs = typeof msg.payload === 'object' && msg.payload !== null;
        if (isParcs && !pl.final && !showParcials) {
          if (pl.final) enqueueSpeak(pl.text);
          return;
        }
        write(pl.text, pl.final);
        if (pl.final) enqueueSpeak(pl.text);
      },
      async stop() {
        stopped = true;
        if (typeof unsubMute === 'function') {
          try { unsubMute(); } catch { /* ignore */ }
        }
        speakQueue.length = 0;
        pending = 0;
        await speakPump.catch(() => {});
        await new Promise<void>((res) => {
          if (fileStream) fileStream!.end(res);
          else res();
        });
      },
      onControl(c: ControlMsg) {
        if (c.kind === 'interrupt') {
          generation += 1;
          activeCtrl?.abort();
          activeCtrl = null;
          if (activeChild) {
            try { activeChild.kill('SIGKILL'); } catch { /* ignore */ }
            activeChild = null;
          }
          ctx.metrics.counter('sink.captions.interrupted', 1);
        }
      },
    };
  },
};

// ---- sink.playback --------------------------------------------------------

export const sinkPlayback: NodeTypeDef = {
  type: 'sink.playback',
  sink: true,
  paramNames: ['player', 'tempDir', 'maxQueue', 'playbackRate', 'muted'],
  bindingNames: ['__isAudioMuted', '__registerAudioMuteListener'],
  inputs: [{ name: 'in', type: 'audio_chunk' }],
  outputs: [],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    if (p.player !== undefined && typeof p.player !== 'string') {
      errs.push({ path: 'params.player', code: 'INVALID_PARAM', message: 'player deve ser string (caminho)"' });
    }
    if (p.muted !== undefined && typeof p.muted !== 'boolean') {
      errs.push({ path: 'params.muted', code: 'INVALID_PARAM', message: 'muted deve ser boolean' });
    }
    if (p.playbackRate !== undefined && (typeof p.playbackRate !== 'number' || p.playbackRate <= 0)) {
      errs.push({ path: 'params.playbackRate', code: 'INVALID_PARAM', message: 'playbackRate deve ser número > 0' });
    }
    if (p.maxQueue !== undefined && (typeof p.maxQueue !== 'number' || p.maxQueue < 1)) {
      errs.push({ path: 'params.maxQueue', code: 'INVALID_PARAM', message: 'maxQueue deve ser número >= 1' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const player = (ctx.params.player as string | undefined) ?? '/usr/bin/afplay';
    const playbackRate = (ctx.params.playbackRate as number | undefined) ?? 1.25;
    const maxQueue = (ctx.params.maxQueue as number | undefined) ?? 2;
    const muted = ctx.params.muted === true;
    const isAudioMuted = ctx.bindings.__isAudioMuted as (() => boolean) | undefined;
    const registerMute = ctx.bindings.__registerAudioMuteListener as
      | ((fn: (muted: boolean) => void) => (() => void) | void)
      | undefined;
    let dir: string | null = null;
    let pending = 0;
    let dropped = 0;
    let fileNo = 0;
    let stopped = false;
    let activeChild: ChildProcess | null = null;
    let generation = 0;
    let clearGen = -1;
    const queue: Array<{ payload: AudioChunkPayload; gen: number }> = [];
    let pump: Promise<void> = Promise.resolve();

    const unsubMute = registerMute?.((nowMuted: boolean) => {
      if (nowMuted) {
        clearGen = generation;
        generation += 1;
        queue.length = 0;
        pending = 0;
        if (activeChild) {
          try { activeChild.kill('SIGKILL'); } catch { /* ignore */ }
          activeChild = null;
        }
      }
    });

    async function play(payload: AudioChunkPayload, myGen: number): Promise<void> {
      if (stopped || ctx.signal.aborted || myGen !== generation || isAudioMuted?.() === true) return;
      if (!dir) dir = await mkdtemp(join(tmpdir(), 'falador-play-'));
      if (stopped || ctx.signal.aborted || myGen !== generation || isAudioMuted?.() === true) return;
      const file = join(dir, `chunk-${fileNo++}.wav`);
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(file);
        ws.on('error', reject);
        ws.on('finish', () => resolve());
        ws.end(Buffer.from(payload.data));
      });
      if (stopped || ctx.signal.aborted || myGen !== generation || isAudioMuted?.() === true) {
        await rm(file, { force: true }).catch(() => {});
        return;
      }
      const t0 = Date.now();
      await new Promise<void>((resolve, reject) => {
        const args = playbackRate !== 1 ? ['-r', String(playbackRate), '-q', '1', file] : [file, '-q', '1'];
        const p = spawn(player, args);
        activeChild = p;
        const onAbort = () => {
          try { p.kill('SIGKILL'); } catch { /* ignore */ }
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => {
          ctx.signal.removeEventListener('abort', onAbort);
          if (activeChild === p) activeChild = null;
        };
        p.on('error', (err) => {
          cleanup();
          reject(err);
        });
        p.on('exit', (code) => {
          cleanup();
          if (code === 0 || code === null || myGen !== generation) resolve(); // null = kill no stop/interrupt
          else reject(new Error(`afplay exit ${code}`));
        });
      });
      if (myGen === generation) {
        ctx.metrics.timer('sink.playback.ms', Date.now() - t0);
        ctx.log('info', `playback ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      }
      await rm(file, { force: true }).catch(() => {});
    }

    function pumpPlay(): void {
      pump = pump.then(async () => {
        while (!stopped) {
          const next = queue.shift();
          if (!next) break;
          try {
            await play(next.payload, next.gen);
          } catch (e: unknown) {
            ctx.log('error', `sink.playback: ${String(e)}`);
          } finally {
            if (next.gen > clearGen) pending = Math.max(0, pending - 1);
          }
        }
      }).catch(() => {});
    }

    return {
      async start() {},
      async onInput(_port, msg) {
        if (muted || isAudioMuted?.() === true || stopped || ctx.signal.aborted || msg.control) return;
        const payload = msg.payload as AudioChunkPayload | null;
        if (!payload || payload.format !== 'wav' || !(payload.data instanceof Uint8Array)) {
          ctx.log('warn', 'sink.playback: payload não é AudioChunkPayload — descartado');
          return;
        }
        while (pending >= maxQueue && queue.length > 0) {
          queue.shift();
          pending -= 1;
          dropped += 1;
          ctx.metrics.counter('sink.playback.dropped', 1);
        }
        if (pending >= maxQueue) {
          dropped += 1;
          ctx.metrics.counter('sink.playback.dropped', 1);
          ctx.log('warn', `sink.playback: fila cheia, mantendo a mais recente (${dropped} descartada(s))`);
          return;
        }
        queue.push({ payload, gen: generation });
        pending += 1;
        if (dropped > 0) ctx.log('warn', `sink.playback: backlog antigo descartado para manter ao vivo (${dropped} total)`);
        pumpPlay();
      },
      async stop() {
        stopped = true;
        if (typeof unsubMute === 'function') {
          try { unsubMute(); } catch { /* ignore */ }
        }
        queue.length = 0;
        pending = 0;
        // espera a fala em curso terminar (não as demais) e limpa temp
        const dirToClean = dir;
        await pump.catch(() => {}).then(() => {
          if (dirToClean) return rm(dirToClean, { recursive: true, force: true }).catch(() => {});
        });
      },
      onControl(c: ControlMsg) {
        if (c.kind === 'interrupt') {
          generation += 1;
          if (activeChild) {
            try { activeChild.kill('SIGKILL'); } catch { /* ignore */ }
            activeChild = null;
          }
          ctx.metrics.counter('sink.playback.interrupted', 1);
        }
      },
    };
  },
};
