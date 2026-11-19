// falador-nodes — tts.sts: sintetiza voz via sidecar residente :8091 (STS LFM3-Audio)
// ENTRADA:  in (tokens_parcial) fala no final:true (default); phrase (phrase) fala direta.
// SAÍDA:    out (audio_chunk) WAV PCM16 mono 24 kHz: {format:'wav', sampleRateHz, data:Uint8Array}
import type { Envelope, NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { postJsonBytes, payloadText } from './sse.ts';

const DEFAULT_URL = 'http://127.0.0.1:8091';

export interface AudioChunkPayload {
  format: 'wav';
  sampleRateHz: number;
  data: Uint8Array;
}

export const ttsSts: NodeTypeDef = {
  type: 'tts.sts',
  paramNames: ['url', 'language', 'voice', 'sampleRateHz', 'timeoutMs', 'speakOn', 'maxTextChars'],
  inputs: [
    { name: 'in', type: 'tokens_parcial' },
    { name: 'phrase', type: 'phrase' },
  ],
  outputs: [{ name: 'out', type: 'audio_chunk' }],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    for (const k of ['url', 'language', 'voice']) {
      if (p[k] !== undefined && typeof p[k] !== 'string') {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser string` });
      }
    }
    for (const k of ['sampleRateHz', 'timeoutMs', 'maxTextChars'] as const) {
      if (p[k] !== undefined && (typeof p[k] !== 'number' || p[k] <= 0)) {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser número > 0` });
      }
    }
    if (p.speakOn !== undefined && p.speakOn !== 'final' && p.speakOn !== 'always') {
      errs.push({ path: 'params.speakOn', code: 'INVALID_PARAM', message: "speakOn deve ser 'final' | 'always'" });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const url = (ctx.params.url as string | undefined) ?? DEFAULT_URL;
    const language = (ctx.params.language as string | undefined) ?? 'English';
    const voice = (ctx.params.voice as string | undefined) ?? 'female';
    const sampleRateHz = (ctx.params.sampleRateHz as number | undefined) ?? 24000;
    const timeoutMs = (ctx.params.timeoutMs as number | undefined) ?? 60_000;
    const speakOn = (ctx.params.speakOn as 'final' | 'always' | undefined) ?? 'final';
    const maxTextChars = (ctx.params.maxTextChars as number | undefined) ?? 1400;

    let stopped = false; // engine serializa onInput por pump; sidecar tem lock próprio

    async function speak(text: string): Promise<void> {
      const clean = text.replace(/\s+/g, ' ').trim();
      if (!clean) return;
      const truncated = clean.length > maxTextChars ? clean.slice(0, maxTextChars) + '…' : clean;
      const t0 = Date.now();
      let bytes: Uint8Array;
      try {
        bytes = await postJsonBytes(
          `${url}/tts`,
          { text: truncated, language, voice, sample_rate: sampleRateHz },
          timeoutMs,
          ctx.signal,
        );
      } catch (e: unknown) {
        const err = e as Error;
        if (err?.name === 'AbortError' || ctx.signal.aborted) return;
        ctx.log('error', `tts.sts falhou: ${err?.message ?? String(e)}`);
        ctx.metrics.counter('tts.sts.errors', 1);
        return;
      }
      ctx.metrics.timer('tts.sts.ms', Date.now() - t0);
      ctx.metrics.counter('tts.sts.bytes', bytes.byteLength);
      ctx.log('info', `fala: "${clean.slice(0, 80)}" (${(bytes.byteLength / 1024).toFixed(0)} KB)`);
      const payload: AudioChunkPayload = { format: 'wav', sampleRateHz, data: bytes };
      await ctx.emit('out', payload, { meta: { chars: clean.length } });
    }

    async function onEnvelope(msg: Envelope): Promise<void> {
      if (stopped || ctx.signal.aborted) return;
      const pl = payloadText(msg.payload);
      if (!pl) return;
      // tokens_parcial no modo 'final': só o fechamento vira fala
      if (msg.control) return;
      const isParcs = typeof msg.payload !== 'string' && msg.payload !== null && typeof msg.payload === 'object';
      if (isParcs && speakOn === 'final' && !pl.final) return;
      await speak(pl.text);
    }

    return {
      async start() {},
      async onInput(_port, msg) {
        await onEnvelope(msg);
      },
      async stop() {
        stopped = true;
      },
    };
  },
};
