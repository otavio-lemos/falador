// falador-nodes — capture.ffmpeg: fonte de áudio real (macOS), PCM16 mono 16k.
// SAÍDA: out (pcm16k) chunks crus de N ms (default 80 ms ⇒ 2560 bytes @16k).
//
// Backends (params.backend):
//   'chat' (default): modo texto interativo via __registerChatInput (sem áudio; emite out_text e parcs).
//   'ffmpeg': avfoundation, input ':N' (índice de ÁUDIO do
//     ffmpeg — liste com `ffmpeg -f avfoundation -list_devices true -i ""`).
//     ⚠ ffmpeg 9.0.2/macOS 27 perde ~75% dos samples (medido 2026-11-19, AGENTS §4).
//   'sounddevice': services/capture-sidecar.py (PortAudio) — captura 100%.
//     input = NOME do device (substring, ex. 'BlackHole', 'Microfone') ou índice
//     PortAudio de entrada (≠ índice avfoundation!). Requer .venv com sounddevice.
//   'sck': ScreenCaptureKit (services/capture-sck.swift, compilado sob demanda) —
//     captura o áudio RENDERIZADO pelo app, SEM Multi-Output/BlackHole/routing.
//     input = NOME do app da call (ex. 'Teams', 'zoom.us', 'Chrome'); vazio = todos.
//     Filtro por app = TTS de outro processo NÃO entra → sem eco digital.
//     Requer permissão de Gravação de Tela (TCC). macOS 13+ (audio-only na prática).
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { inheritTrace } from './trace.ts';

// defaults de caminho ancorados NO REPO (não no cwd do runner — testes rodam de
// packages/falador-nodes, o host da raiz; ambos precisam achar o sidecar).
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function resolveSounddeviceInput(rawInput: string): string {
  const trimmed = rawInput.trim();
  return trimmed === '' ? 'Microfone' : trimmed.replace(/^:/, '').trim();
}

export const captureFfmpeg: NodeTypeDef = {
  type: 'capture.ffmpeg',
  sourceOnly: true,
  paramNames: [
    'input',
    'sampleRate',
    'chunkMs',
    'ffmpegPath',
    'backend',
    'isDefault',
    'pythonPath',
    'sidecarPath',
    'sckPath',
    'muted',
    'placeholder',
    'initialMessage',
  ],
  bindingNames: ['__registerChatInput'],
  inputs: [],
  outputs: [
    { name: 'out', type: 'pcm16k', required: false },
    { name: 'out_text', type: 'phrase', required: false },
    { name: 'parcs', type: 'tokens_parcial', required: false },
  ],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    if (p.input !== undefined && typeof p.input !== 'string') {
      errs.push({ path: 'params.input', code: 'INVALID_PARAM', message: 'input deve ser string (ex. ":0" ffmpeg, "BlackHole" sounddevice)' });
    }
    if (p.muted !== undefined && typeof p.muted !== 'boolean') {
      errs.push({ path: 'params.muted', code: 'INVALID_PARAM', message: 'muted deve ser boolean' });
    }
    if (p.isDefault !== undefined && typeof p.isDefault !== 'boolean') {
      errs.push({ path: 'params.isDefault', code: 'INVALID_PARAM', message: 'isDefault deve ser boolean' });
    }
    for (const k of ['sampleRate', 'chunkMs'] as const) {
      if (p[k] !== undefined && (typeof p[k] !== 'number' || p[k] <= 0)) {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser número > 0` });
      }
    }
    for (const k of ['ffmpegPath', 'pythonPath', 'sidecarPath', 'sckPath', 'placeholder', 'initialMessage'] as const) {
      if (p[k] !== undefined && typeof p[k] !== 'string') {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser string` });
      }
    }
    if (
      p.backend !== undefined &&
      p.backend !== 'ffmpeg' &&
      p.backend !== 'sounddevice' &&
      p.backend !== 'sck' &&
      p.backend !== 'chat'
    ) {
      errs.push({ path: 'params.backend', code: 'INVALID_PARAM', message: "backend deve ser 'ffmpeg' | 'sounddevice' | 'sck' | 'chat'" });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const backend = (ctx.params.backend as string | undefined) ?? 'chat';
    const input = (ctx.params.input as string | undefined) ?? ((backend === 'chat' || backend === 'sck') ? '' : ':0');
    const muted = ctx.params.muted === true;
    const initialMessage =
      typeof ctx.params.initialMessage === 'string' ? ctx.params.initialMessage.trim() : '';
    const sampleRate = (ctx.params.sampleRate as number | undefined) ?? 16000;
    const chunkMs = (ctx.params.chunkMs as number | undefined) ?? 80;
    const ffmpegPath = (ctx.params.ffmpegPath as string | undefined) ?? '/opt/homebrew/bin/ffmpeg';
    const pythonPath = (ctx.params.pythonPath as string | undefined) ?? join(REPO_ROOT, '.venv/bin/python');
    const sidecarPath = (ctx.params.sidecarPath as string | undefined) ?? join(REPO_ROOT, 'services/capture-sidecar.py');
    const sckPath = (ctx.params.sckPath as string | undefined) ?? join(REPO_ROOT, 'services/capture-sck');

    const bytesPerChunk = Math.round((sampleRate * chunkMs) / 1000) * 2; // s16le mono
    let child: ChildProcessWithoutNullStreams | null = null;
    let stopped = false;
    let rest = Buffer.alloc(0);

    const emitText = async (raw: string): Promise<void> => {
      if (stopped || ctx.signal.aborted) return;
      const text = raw.trim();
      if (!text) return;
      const meta = inheritTrace(undefined, { tCaptureMs: Date.now() });
      ctx.metrics.counter('input.chat.messages', 1);
      await ctx.emit('out_text', text, { meta });
      await ctx.emit('parcs', { text, final: true }, { meta });
    };

    // rede de segurança: QUALQUER process.exit() (normal ou via handler de sinal)
    // executa handlers 'exit' SÍNCRONOS — matar o child aqui garante que o
    // capture-sck/ffmpeg/sidecar não vira órfão capturando para sempre, mesmo
    // que stop() nunca rode (ex.: runner morto por sinal do host).
    const killChildOnExit = () => {
      const c = child;
      child = null;
      if (!c || c.killed || c.exitCode !== null) return;
      try {
        c.kill('SIGKILL');
      } catch { /* já morto */ }
    };
    process.on('exit', killChildOnExit);

    return {
      async start() {
        const register = ctx.bindings?.__registerChatInput as
          | ((fn: (t: string) => Promise<void>) => void)
          | undefined;
        if (register) register(emitText);
        if (backend === 'chat') {
          ctx.log('info', 'input: modo chat (sem áudio)');
          if (initialMessage) await emitText(initialMessage);
          return;
        }
        if (muted) {
          ctx.log('info', 'input: silenciado (muted=true)');
          return;
        }
        // sck: ScreenCaptureKit por app (sem routing). Binário recompilado se ausente ou stale.
        const swiftPath = `${sckPath}.swift`;
        const needsBuild =
          backend === 'sck' &&
          (!existsSync(sckPath) || (existsSync(swiftPath) && statSync(swiftPath).mtimeMs > statSync(sckPath).mtimeMs));
        if (needsBuild) {
          ctx.log('info', 'compilando capture-sck.swift…');
          await promisify(execFile)('swiftc', ['-O', swiftPath, '-o', sckPath]);
        }
        const rawInput = input.trim();
        const sckApp = rawInput.replace(/^:/, '').trim();
        const isLegacyIndex = /^:\d+$/.test(rawInput);
        // sounddevice: device de entrada — vazio ⇒ 'Microfone' como substring padrão.
        const sdDevice = resolveSounddeviceInput(input);
        const args = backend === 'sounddevice'
          ? [sidecarPath, '--device', sdDevice, '--rate', String(sampleRate), '--chunk-ms', String(chunkMs)]
          : backend === 'sck'
            ? (sckApp && sckApp !== 'auto' && !isLegacyIndex
              ? ['--app', sckApp, '--rate', String(sampleRate)]
              : ['--rate', String(sampleRate)])
            : [
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
        const cmd = backend === 'sounddevice' ? pythonPath : backend === 'sck' ? sckPath : ffmpegPath;
        await new Promise<void>((resolve, reject) => {
          child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          child.stderr.on('data', (d: Buffer) => {
            const s = d.toString().trim();
            if (s) ctx.log('warn', `capture: ${s.slice(0, 300)}`);
          });
          child.on('error', reject);
          child.on('spawn', () => resolve());
          child.on('exit', (code) => {
            if (!stopped) {
              ctx.log(code && code !== 0 ? 'error' : 'warn', `capture (${backend}) encerrou (code=${code})`);
            }
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
        process.off('exit', killChildOnExit);
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
