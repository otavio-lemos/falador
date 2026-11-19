// falador-nodes — sinks: legenda no terminal e reprodução de áudio (afplay).
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { payloadText } from './sse.ts';
import { ttsSts as _ttsSts } from './tts-sts.ts';
import type { AudioChunkPayload } from './tts-sts.ts';

// ---- sink.captions --------------------------------------------------------

export const sinkCaptions: NodeTypeDef = {
  type: 'sink.captions',
  sink: true,
  paramNames: ['mode', 'showParcials'],
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
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const mode = (ctx.params.mode as 'stdout' | 'callback' | undefined) ?? 'stdout';
    const showParcials = (ctx.params.showParcials as boolean | undefined) ?? true;
    const cb = ctx.bindings.__onCaption as ((c: { text: string; final: boolean }) => void) | undefined;

    function write(text: string, final: boolean): void {
      if (!text) return;
      if (!final) {
        if (!showParcials) return;
        // linha parcial viva: \r recomeça e limita a 120 cols
        const line = text.length > 120 ? '…' + text.slice(-119) : text;
        process.stdout.write(`\r${line}\u001B[K`);
      } else {
        process.stdout.write(`\r${text}\u001B[K\n`);
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
          cb?.({ text: pl.text, final: pl.final });
          return;
        }
        const isParcs = typeof msg.payload === 'object' && msg.payload !== null;
        if (isParcs && !pl.final && !showParcials) return;
        write(pl.text, pl.final);
      },
      async stop() {
        // nada persistente: stdout já terminou cada linha no `final`
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

    async function play(payload: AudioChunkPayload): Promise<void> {
      if (stopped || ctx.signal.aborted) return;
      if (!dir) dir = await mkdtemp(join(tmpdir(), 'falador-play-'));
      const file = join(dir, `chunk-${fileNo++}.wav`);
      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(file);
        ws.on('error', reject);
        ws.on('finish', () => resolve());
        ws.end(Buffer.from(payload.data));
      });
      const t0 = Date.now();
      await new Promise<void>((resolve, reject) => {
        const p = spawn(player, [file, '-q', '1']);
        p.on('error', reject);
        p.on('exit', (code) => {
          if (code === 0 || code === null) resolve(); // null = kill no stop
          else reject(new Error(`afplay exit ${code}`));
        });
        ctx.signal.addEventListener('abort', () => p.kill('SIGKILL'), { once: true });
      });
      ctx.metrics.timer('sink.playback.ms', Date.now() - t0);
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
        chain = chain
          .then(() => play(payload))
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
    };
  },
};
