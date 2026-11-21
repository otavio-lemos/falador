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

// ---- sink.captions --------------------------------------------------------

export const sinkCaptions: NodeTypeDef = {
  type: 'sink.captions',
  sink: true,
  paramNames: ['mode', 'showParcials', 'outputFile'],
  bindingNames: ['__onCaption'],
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
    if (p.showParcials !== undefined && typeof p.showParcials !== 'boolean') {
      errs.push({ path: 'params.showParcials', code: 'INVALID_PARAM', message: 'showParcials deve ser boolean' });
    }
    if (p.outputFile !== undefined && typeof p.outputFile !== 'string') {
      errs.push({ path: 'params.outputFile', code: 'INVALID_PARAM', message: 'outputFile deve ser string (caminho)' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const mode = (ctx.params.mode as 'stdout' | 'callback' | undefined) ?? 'stdout';
    const showParcials = (ctx.params.showParcials as boolean | undefined) ?? true;
    const outputFile = (ctx.params.outputFile as string | undefined);
    const cb = ctx.bindings.__onCaption as
      | ((c: { text: string; final: boolean; trace?: TraceMeta }) => void)
      | undefined;

    // stream de arquivo aberto só se outputFile definido
    let fileStream: ReturnType<typeof createWriteStream> | null = null;
    if (outputFile) {
      fileStream = createWriteStream(outputFile, { flags: 'a', encoding: 'utf-8' });
    }

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
          return;
        }
        const isParcs = typeof msg.payload === 'object' && msg.payload !== null;
        if (isParcs && !pl.final && !showParcials) return;
        write(pl.text, pl.final);
      },
      async stop() {
        await new Promise<void>((res) => {
          if (fileStream) fileStream!.end(res);
          else res();
        });
      },
    };
  },
};

// ---- sink.playback --------------------------------------------------------

export const sinkPlayback: NodeTypeDef = {
  type: 'sink.playback',
  sink: true,
  paramNames: ['player', 'tempDir', 'maxQueue'],
  inputs: [{ name: 'in', type: 'audio_chunk' }],
  outputs: [],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    if (p.player !== undefined && typeof p.player !== 'string') {
      errs.push({ path: 'params.player', code: 'INVALID_PARAM', message: 'player deve ser string (caminho)"' });
    }
    if (p.maxQueue !== undefined && (typeof p.maxQueue !== 'number' || p.maxQueue < 1)) {
      errs.push({ path: 'params.maxQueue', code: 'INVALID_PARAM', message: 'maxQueue deve ser número >= 1' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const player = (ctx.params.player as string | undefined) ?? '/usr/bin/afplay';
    const maxQueue = (ctx.params.maxQueue as number | undefined) ?? 4;
    let dir: string | null = null;
    let chain: Promise<void> = Promise.resolve();
    let pending = 0;
    let dropped = 0;
    let fileNo = 0;
    let stopped = false;
    let activeChild: ChildProcess | null = null;
    let generation = 0;

    async function play(payload: AudioChunkPayload, myGen: number): Promise<void> {
      if (stopped || ctx.signal.aborted || myGen !== generation) return;
      if (!dir) dir = await mkdtemp(join(tmpdir(), 'falador-play-'));
      if (stopped || ctx.signal.aborted || myGen !== generation) return;
      const file = join(dir, `chunk-${fileNo++}.wav`);
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(file);
        ws.on('error', reject);
        ws.on('finish', () => resolve());
        ws.end(Buffer.from(payload.data));
      });
      if (stopped || ctx.signal.aborted || myGen !== generation) {
        await rm(file, { force: true }).catch(() => {});
        return;
      }
      const t0 = Date.now();
      await new Promise<void>((resolve, reject) => {
        const p = spawn(player, [file, '-q', '1']);
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

    return {
      async start() {},
      async onInput(_port, msg) {
        if (stopped || ctx.signal.aborted || msg.control) return;
        const payload = msg.payload as AudioChunkPayload | null;
        if (!payload || payload.format !== 'wav' || !(payload.data instanceof Uint8Array)) {
          ctx.log('warn', 'sink.playback: payload não é AudioChunkPayload — descartado');
          return;
        }
        pending += 1;
        if (pending > maxQueue) {
          // deixa tocar o que está, derruba o excedente (latência > 3 falas empilhadas = inútil ao vivo)
          pending -= 1;
          dropped += 1;
          ctx.metrics.counter('sink.playback.dropped', 1);
          ctx.log('warn', `sink.playback: fila cheia, fala n.${fileNo + maxQueue} + ${dropped} descartadas`);
          return;
        }
        const myGen = generation;
        chain = chain
          .then(() => play(payload, myGen))
          .then(() => {
            pending -= 1;
          })
          .catch((e: unknown) => {
            pending -= 1;
            ctx.log('error', `sink.playback: ${String(e)}`);
          });
      },
      async stop() {
        stopped = true;
        // espera a fala em curso terminar (não as demais) e limpa temp
        const dirToClean = dir;
        await chain.catch(() => {}).then(() => {
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
