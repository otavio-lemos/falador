// falador-nodes — capture.ffmpeg: fonte de áudio real via avfoundation (macOS), PCM16 mono 16k.
// SAÍDA: out (pcm16k) chunks crus de N ms (default 80 ms ⇒ 2560 bytes @16k).
//
// Seleção do dispositivo: params.input é o spec do avfoundation SEM vídeo, ex.:
//   ':0'  → primeiro dispositivo de áudio do sistema (built-in mic, geralmente)
//   ':1'  → segundo dispositivo de áudio (BlackHole costuma ser índice alto)
// Liste com: ffmpeg -f avfoundation -list_devices true -i ""
//   (linha "AVFoundation audio device ... [N]")
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';

export const captureFfmpeg: NodeTypeDef = {
  type: 'capture.ffmpeg',
  sourceOnly: true,
  paramNames: ['input', 'sampleRate', 'chunkMs', 'ffmpegPath'],
  inputs: [],
  outputs: [{ name: 'out', type: 'pcm16k' }],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    if (p.input !== undefined && typeof p.input !== 'string') {
      errs.push({ path: 'params.input', code: 'INVALID_PARAM', message: 'input deve ser string (ex. ":0")' });
    }
    for (const k of ['sampleRate', 'chunkMs'] as const) {
      if (p[k] !== undefined && (typeof p[k] !== 'number' || p[k] <= 0)) {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser número > 0` });
      }
    }
    if (p.ffmpegPath !== undefined && typeof p.ffmpegPath !== 'string') {
      errs.push({ path: 'params.ffmpegPath', code: 'INVALID_PARAM', message: 'ffmpegPath deve ser string' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const input = (ctx.params.input as string | undefined) ?? ':0';
    const sampleRate = (ctx.params.sampleRate as number | undefined) ?? 16000;
    const chunkMs = (ctx.params.chunkMs as number | undefined) ?? 80;
    const ffmpegPath = (ctx.params.ffmpegPath as string | undefined) ?? '/opt/homebrew/bin/ffmpeg';

    const bytesPerChunk = Math.round((sampleRate * chunkMs) / 1000) * 2; // s16le mono
    let child: ChildProcessWithoutNullStreams | null = null;
    let stopped = false;
    let rest = Buffer.alloc(0);

    return {
      async start() {
        const args = [
          '-f', 'avfoundation',
          '-i', input,
          '-vn',                      // ignore o vídeo do dispositivo
          '-f', 's16le',
          '-acodec', 'pcm_s16le',
          '-ac', '1',
          '-ar', String(sampleRate),
          '-loglevel', 'error',
          'pipe:1',
        ];
        await new Promise<void>((resolve, reject) => {
          child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          child.stderr.on('data', (d: Buffer) => {
            const s = d.toString().trim();
            if (s) ctx.log('warn', `ffmpeg: ${s.slice(0, 300)}`);
          });
          child.on('error', reject);
          child.on('spawn', () => resolve());
          child.on('exit', (code) => {
            if (!stopped) ctx.log('warn', `ffmpeg exit code=${code}`);
          });
          child.stdout.on('data', (buf: Buffer) => {
            if (stopped || ctx.signal.aborted) return;
            let acc = rest.length ? Buffer.concat([rest, buf]) : buf;
            while (acc.length >= bytesPerChunk) {
              const chunk = acc.subarray(0, bytesPerChunk);
              acc = acc.subarray(bytesPerChunk);
              void ctx.emit('out', new Uint8Array(chunk)).catch(() => {
                /* edge fechada no stop: ignora */
              });
              ctx.metrics.counter('capture.ffmpeg.chunks', 1);
              ctx.metrics.counter('capture.ffmpeg.bytes', bytesPerChunk);
            }
            rest = Buffer.from(acc); // resto para o próximo chunk
          });
        });
      },
      async onInput() {},
      async stop() {
        stopped = true;
        if (child) {
          try {
            child.kill('SIGTERM');
          } catch { /* já morto */ }
          child = null;
        }
      },
    };
  },
};
