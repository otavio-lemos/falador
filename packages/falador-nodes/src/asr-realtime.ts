// falador-nodes — asr.realtime: STT streaming via WS /v1/realtime do server mlx-audio :8090
// ENTRADA:  in (pcm16k) PCM16 mono 16k (chunks crus de capture.ffmpeg).
// SAÍDA:    out (tokens_parcial) CUMULATIVO por item: {text: tudo até agora, final}.
// Protocolo (mlx_audio/server.py, handler realtime_ws):
//   client → server: session.update (declara taxa de entrada; turn_detection), input_audio_buffer.append (b64),
//                    input_audio_buffer.commit (modo manual).
//   server → client: session.created/.updated, input_audio_buffer.committed,
//                    conversation.item.added, conversation.item.input_audio_transcription.delta/.completed,
//                    input_audio_buffer.speech_started/.speech_stopped, error.
// Modo 'server_vad' (default): Silero roda no server e auto-committa cada fala — ideal p/ conferência.
// Modo 'manual': cliente comita por commitEveryMs após a última chegada de áudio.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { inheritTrace, type TraceMeta } from './trace.ts';

const DEFAULT_URL = process.env.FALADOR_ASR_URL ?? 'ws://127.0.0.1:8090/v1/realtime';
// LFM3-Audio 2B — SEM streaming STT (sem create_streaming_session): só serve p/ STS/TTS.
export const LFM3_AUDIO_SNAPSHOT =
  '/Users/otaviolemos/.cache/huggingface/hub/models--LiquidAI--LFM3-Audio-2B-MLX-8bit/snapshots/000ea4f93adbfdabd4b24295b5e838f6a1f0ffa8';
// Voxtral-Mini-4B-Realtime 4bit — streaming STT nativo (contrato StreamingSession), PT incluído.
export const VOXTRAL_SNAPSHOT =
  '/Users/otaviolemos/.cache/huggingface/hub/models--mlx-community--Voxtral-Mini-4B-Realtime-2602-4bit/snapshots/fdebf7b2af834a1db4b8a3c99ab7480b333adf9e';

/**
 * mlx_audio/server.py (:8090) exige path local do snapshot para não tentar baixar do HF
 * nem rejeitar IDs do omlx com `--` ou repo sem org (L28). Se `raw` já existe ou não há
 * match local, devolve `raw` inalterado.
 */
export function resolveLocalAsrModelPath(raw: string, home = homedir()): string {
  const trimmed = raw.trim();
  if (!trimmed || existsSync(trimmed)) return trimmed;
  const normalized = trimmed.replace(/^models--/, '').replace(/--/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const lmRoot = join(home, '.lmstudio', 'models');
  const hfRoot = join(home, '.cache', 'huggingface', 'hub');

  if (parts.length >= 2) {
    const [org, repo] = [parts[parts.length - 2], parts[parts.length - 1]];
    const lmCandidate = join(lmRoot, org, repo);
    if (existsSync(lmCandidate)) return lmCandidate;
    const hfSnaps = join(hfRoot, `models--${org}--${repo}`, 'snapshots');
    if (existsSync(hfSnaps)) {
      try {
        const revs = readdirSync(hfSnaps).filter((d) => !d.startsWith('.'));
        if (revs.length > 0) return join(hfSnaps, revs[0]);
      } catch { /* ignore */ }
    }
  } else if (parts.length === 1) {
    const repo = parts[0];
    if (existsSync(lmRoot)) {
      try {
        for (const org of readdirSync(lmRoot)) {
          if (org.startsWith('.')) continue;
          const cand = join(lmRoot, org, repo);
          if (existsSync(cand)) return cand;
        }
      } catch { /* ignore */ }
    }
    if (existsSync(hfRoot)) {
      try {
        const hit = readdirSync(hfRoot).find((d) => d.startsWith('models--') && d.endsWith(`--${repo}`));
        if (hit) {
          const snaps = join(hfRoot, hit, 'snapshots');
          const revs = readdirSync(snaps).filter((d) => !d.startsWith('.'));
          if (revs.length > 0) return join(snaps, revs[0]);
        }
      } catch { /* ignore */ }
    }
  }
  return trimmed;
}

export const asrRealtime: NodeTypeDef = {
  type: 'asr.realtime',
  paramNames: [
    'url',
    'model',
    'inputRate',
    'serverVad',
    'commitEveryMs',
    'silenceThresholdMs',
    'maxPendingMs',
    'emitInterruptOnSpeech',
    'bargeInDebounceMs',
    'outputRequired',
  ],
  bindingNames: ['__onCaption'],
  inputs: [{ name: 'in', type: 'pcm16k' }],
  outputs: [
    { name: 'out', type: 'tokens_parcial', required: false },
    { name: 'final', type: 'phrase', required: false },
  ],
  outputsFor: (p) => [
    { name: 'out', type: 'tokens_parcial', required: p.outputRequired === true },
    { name: 'final', type: 'phrase', required: false },
  ],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    for (const k of ['url', 'model']) {
      if (p[k] !== undefined && typeof p[k] !== 'string') {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser string` });
      }
    }
    for (const k of ['inputRate', 'commitEveryMs', 'silenceThresholdMs', 'maxPendingMs'] as const) {
      if (p[k] !== undefined && (typeof p[k] !== 'number' || Number.isNaN(p[k]) || p[k] <= 0)) {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser número > 0` });
      }
    }
    if (p.bargeInDebounceMs !== undefined && (typeof p.bargeInDebounceMs !== 'number' || Number.isNaN(p.bargeInDebounceMs) || p.bargeInDebounceMs < 0)) {
      errs.push({ path: 'params.bargeInDebounceMs', code: 'INVALID_PARAM', message: 'bargeInDebounceMs deve ser número >= 0' });
    }
    if (p.serverVad !== undefined && typeof p.serverVad !== 'boolean') {
      errs.push({ path: 'params.serverVad', code: 'INVALID_PARAM', message: 'serverVad deve ser boolean' });
    }
    if (p.emitInterruptOnSpeech !== undefined && typeof p.emitInterruptOnSpeech !== 'boolean') {
      errs.push({ path: 'params.emitInterruptOnSpeech', code: 'INVALID_PARAM', message: 'emitInterruptOnSpeech deve ser boolean' });
    }
    if (p.outputRequired !== undefined && typeof p.outputRequired !== 'boolean') {
      errs.push({ path: 'params.outputRequired', code: 'INVALID_PARAM', message: 'outputRequired deve ser boolean' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    if (process.env.FALADOR_ASR_DEBUG) console.error('[asr dbg] CREATE chamado');
    const baseUrl = (ctx.params.url as string | undefined) ?? DEFAULT_URL;
    const rawModel = (ctx.params.model as string | undefined) ?? VOXTRAL_SNAPSHOT;
    const model = resolveLocalAsrModelPath(rawModel);
    const inputRate = (ctx.params.inputRate as number | undefined) ?? 16000;
    const serverVad = (ctx.params.serverVad as boolean | undefined) ?? true;
    const commitEveryMs = (ctx.params.commitEveryMs as number | undefined) ?? 900;
    const silenceThresholdMs = (ctx.params.silenceThresholdMs as number | undefined) ?? 800;
    const maxPendingMs = (ctx.params.maxPendingMs as number | undefined) ?? 2000;
    const emitInterruptOnSpeech = (ctx.params.emitInterruptOnSpeech as boolean | undefined) ?? false;
    const bargeInDebounceMs = (ctx.params.bargeInDebounceMs as number | undefined) ?? 300;
    const onCaption = ctx.bindings.__onCaption as
      | ((c: { text: string; final: boolean; trace?: TraceMeta }) => void)
      | undefined;

    let ws: WebSocket | null = null;
    let opened = false;
    // áudio que chegou antes da sessão abrir fica em buffer limitado por maxPendingMs
    let directSent = 0;
    const pending: Array<{ bytes: Uint8Array; ts: number }> = [];
    let accByItem = new Map<string, string>();
    const firstDeltaMsByItem = new Map<string, number>();
    let curItem: string | null = null;
    let lastAudioAt = 0;
    let lastCaptureMs = 0;
    let lastCommitAt = 0;
    let commitTimer: ReturnType<typeof setInterval> | null = null;
    let bargeInTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let backoff = 200;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let everOpened = false; // reconexão automática só depois da primeira abertura

    function clearBargeInTimer(): void {
      if (bargeInTimer !== null) {
        clearTimeout(bargeInTimer);
        bargeInTimer = null;
      }
    }

    function dropStalePending(now: number): number {
      let dropped = 0;
      while (pending.length > 0 && now - pending[0].ts > maxPendingMs) {
        pending.shift();
        dropped++;
      }
      if (dropped > 0) {
        ctx.metrics.counter('asr.realtime.pendingDropped', dropped);
      }
      return dropped;
    }

    function b64encode(bytes: Uint8Array): string {
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CH));
      }
      return btoa(bin);
    }

    async function connect(): Promise<void> {
      if (stopped || ctx.signal.aborted) return;
      const url = `${baseUrl}?model=${encodeURIComponent(model)}`;
      ws = new WebSocket(url);
      ws.onopen = () => {
        opened = true;
        everOpened = true;
        backoff = 200;
        ctx.log('info', 'asr.realtime: sessão aberta');
        // Declara taxa 16k e turn detection. (server default é 24000.)
        const audioInput: Record<string, unknown> = {
          format: { type: 'audio/pcm', rate: inputRate },
          turn_detection: serverVad ? { type: 'server_vad' } : null,
        };
        if (process.env.FALADOR_ASR_DEBUG) console.error(`[asr dbg ${Math.round(Date.now() / 1000) % 10000}] ONOPEN inputRate=${inputRate} serverVad=${serverVad} pending=${pending.length}`);
        ws?.send(JSON.stringify({ type: 'session.update', session: { audio: { input: audioInput } } }));
        // flush do buffer pré-abertura (descartando frames mais velhos que maxPendingMs)
        const flush = () => {
          dropStalePending(Date.now());
          let n = 0;
          while (pending.length > 0) {
            const frame = pending.shift()!;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64encode(frame.bytes) }));
              n++;
            }
          }
          if (process.env.FALADOR_ASR_DEBUG) ctx.log('info', `flush ${n} frames`);
          ctx.metrics.counter('asr.realtime.bufferedFlushed', 1);
        };
        setTimeout(flush, 0);
        if (!serverVad) {
          commitTimer = setInterval(maybeCommit, Math.min(commitEveryMs, 200));
        }
      };
      ws.onmessage = (ev: MessageEvent) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return;
        }
        void handleServerEvent(m);
      };
      ws.onerror = () => {
        ctx.log('warn', 'asr.realtime: erro no WebSocket');
      };
      ws.onclose = () => {
        if (process.env.FALADOR_ASR_DEBUG) ctx.log('info', `ws-CLOSE ${JSON.stringify({ code: (arguments as never), wasClean: true }).slice(0, 80)}`);
        opened = false;
        clearBargeInTimer();
        if (commitTimer) {
          clearInterval(commitTimer);
          commitTimer = null;
        }
        if (stopped || ctx.signal.aborted) return;
        ctx.metrics.counter('asr.realtime.reconnects', 1);
        const wait = backoff;
        backoff = Math.min(backoff * 2, 5000);
        reconnectTimer = setTimeout(() => void connect(), wait);
        void reconnectTimer;
      };
    }

    async function handleServerEvent(m: Record<string, unknown>): Promise<void> {
      const type = String(m.type ?? '');
      if (process.env.FALADOR_ASR_DEBUG) console.error(`[asr dbg ${Math.round(Date.now() / 1000) % 10000}] ws-ev ${type} ${JSON.stringify(m).slice(0, 120)}`);
      if (type === 'error') {
        ctx.log('error', `asr.realtime server: ${JSON.stringify((m as any).error ?? m)}`);
        return;
      }
      if (type === 'input_audio_buffer.speech_started') {
        if (emitInterruptOnSpeech && !stopped && !ctx.signal.aborted) {
          clearBargeInTimer();
          bargeInTimer = setTimeout(() => {
            bargeInTimer = null;
            if (stopped || ctx.signal.aborted) return;
            ctx.metrics.counter('asr.realtime.interrupts', 1);
            ctx.emitControl('out', { kind: 'interrupt', scope: 'port', reason: 'speech_started' });
            ctx.emitControl('final', { kind: 'interrupt', scope: 'port', reason: 'speech_started' });
          }, bargeInDebounceMs);
        }
        return;
      }
      if (type === 'input_audio_buffer.speech_stopped') {
        clearBargeInTimer();
        return;
      }
      if (type === 'conversation.item.added') {
        curItem = String((m as any).item?.id ?? '');
        if (!accByItem.has(curItem)) accByItem.set(curItem, '');
        return;
      }
      if (type === 'conversation.item.input_audio_transcription.delta') {
        const item = String((m as any).item_id ?? curItem ?? '');
        const delta = String((m as any).delta ?? '');
        const acc = (accByItem.get(item) ?? '') + delta;
        accByItem.set(item, acc);
        const now = Date.now();
        if (!firstDeltaMsByItem.has(item)) firstDeltaMsByItem.set(item, now);
        const tAsrFirstMs = firstDeltaMsByItem.get(item)!;
        const tracePatch: Partial<TraceMeta> = {
          turnId: item || undefined,
          tCaptureMs: lastCaptureMs || undefined,
          tAsrFirstMs,
        };
        const meta = { itemId: item, ...inheritTrace(undefined, tracePatch) };
        await ctx.emit('out', { text: acc, final: false }, { meta });
        if (acc) {
          try { onCaption?.({ text: acc, final: false, trace: meta.trace }); } catch { /* callback do host */ }
        }
        return;
      }
      if (type === 'conversation.item.input_audio_transcription.completed') {
        const item = String((m as any).item_id ?? curItem ?? '');
        const transcript = String((m as any).transcript ?? accByItem.get(item) ?? '');
        accByItem.delete(item);
        const now = Date.now();
        const tAsrFirstMs = firstDeltaMsByItem.get(item) ?? now;
        firstDeltaMsByItem.delete(item);
        ctx.metrics.counter('asr.realtime.turns', 1);
        const tracePatch: Partial<TraceMeta> = {
          turnId: item || undefined,
          tCaptureMs: lastCaptureMs || undefined,
          tAsrFirstMs,
          tAsrFinalMs: now,
        };
        const meta = { itemId: item, ...inheritTrace(undefined, tracePatch) };
        await ctx.emit('out', { text: transcript, final: true }, { meta });
        if (transcript) {
          try { onCaption?.({ text: transcript, final: true, trace: meta.trace }); } catch { /* callback do host */ }
        }
        if (transcript.trim()) {
          await ctx.emit('final', transcript, { meta });
        }
        return;
      }
      // committed / session.* : nada a emitir
    }

    function maybeCommit(): void {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (lastAudioAt === 0) return;
      if (curItem === null) {
        // nada em andamento: comite só se passou commitEveryMs desde a última fala (loop curto)
        if (now - lastCommitAt < commitEveryMs) return;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        lastCommitAt = now;
        return;
      }
      // item aberto: só comite após silêncio >= silenceThresholdMs e commitEveryMs decorridos
      if (now - lastAudioAt >= silenceThresholdMs && now - lastCommitAt >= commitEveryMs) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        lastCommitAt = now;
      }
    }

    return {
      async start() {
        if (process.env.FALADOR_ASR_DEBUG) console.error('[asr dbg] START chamado');
        await connect();
      },
      async onInput(_port, msg) {
        if (msg.control || stopped || ctx.signal.aborted) return;
        const bytes =
          msg.payload instanceof Uint8Array
            ? msg.payload
            : typeof (msg.payload as any)?.data === 'string' // {data: b64}
              ? new Uint8Array(Buffer.from(String((msg.payload as any).data), 'base64'))
              : null;
        if (bytes == null || bytes.length === 0) return;
        const now = Date.now();
        lastAudioAt = now;
        const incomingTrace = msg.meta?.trace as TraceMeta | undefined;
        lastCaptureMs = incomingTrace?.tCaptureMs ?? msg.ts ?? now;
        if (!opened || !ws || ws.readyState !== WebSocket.OPEN) {
          dropStalePending(now);
          pending.push({ bytes, ts: now });
          ctx.metrics.counter('asr.realtime.bufferedPushed', 1);
          return;
        }
        directSent++;
        if (process.env.FALADOR_ASR_DEBUG && directSent <= 3) ctx.log('info', `send append #${directSent} len=${bytes.length}`);
        ws.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: b64encode(bytes),
        }));
        if (!serverVad) maybeCommit();
      },
      async stop(_reason: string) {
        stopped = true;
        clearBargeInTimer();
        if (commitTimer) clearInterval(commitTimer);
        commitTimer = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        try {
          if (!serverVad && ws && ws.readyState === WebSocket.OPEN && curItem !== null) {
            ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          }
          ws?.close();
        } catch { /* already closed */ }
        ws = null;
        opened = false;
      },
    };
  },
};
