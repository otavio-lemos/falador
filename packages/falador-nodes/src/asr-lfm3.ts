// falador-nodes — asr.lfm3: transcrição+TRADUÇÃO NATIVA por utterance (LFM3-Audio task='chat').
// Diferença do asr.realtime (Voxtral): Voxtral não traduz (medido, AGENTS.md §4);
// LFM3-Audio traduz via messages com áudio tipado — mas NÃO é streaming.
// ENTRADA:  in (pcm16k): Uint8Array s16le mono 16 kHz (capture.ffmpeg) — o nó embrulha em WAV
//           antes do POST; envelope {format:'wav',data} também é tolerado em runtime (defensivo).
// SAÍDA:    out (tokens_parcial): {text, final:true} por janela de flush.
// Endpoint: POST /asr-translate no sts-sidecar (:8091) — ver services/sts-sidecar.py.
import type { Envelope, NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { postJsonBytes } from './sse.ts';

const DEFAULT_URL = 'http://127.0.0.1:8091';
const DEFAULT_INSTRUCTION =
  'Transcribe the audio and translate it to Brazilian Portuguese. Output only the translation, nothing else.';

export const asrLfm3: NodeTypeDef = {
  type: 'asr.lfm3',
  paramNames: ['url', 'model', 'targetLanguage', 'instruction', 'sampleRateHz', 'flushSec', 'timeoutMs', 'maxTranslateChars'],
  bindingNames: ['__onCaption'],
  inputs: [{ name: 'in', type: 'pcm16k' }],
  outputs: [{ name: 'out', type: 'tokens_parcial' }],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    for (const k of ['url', 'model', 'targetLanguage', 'instruction']) {
      if (p[k] !== undefined && typeof p[k] !== 'string') {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser string` });
      }
    }
    for (const k of ['sampleRateHz', 'flushSec', 'timeoutMs', 'maxTranslateChars'] as const) {
      if (p[k] !== undefined && (typeof p[k] !== 'number' || p[k] <= 0)) {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser número > 0` });
      }
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const url = (ctx.params.url as string | undefined) ?? DEFAULT_URL;
    const explicitInstruction = typeof ctx.params.instruction === 'string' ? ctx.params.instruction.trim() : '';
    let instruction = DEFAULT_INSTRUCTION;
    if (explicitInstruction) {
      instruction = explicitInstruction;
    } else if (ctx.params.targetLanguage !== undefined) {
      const lang = String(ctx.params.targetLanguage ?? '').trim();
      if (!lang || lang === '-' || lang === '—') {
        instruction = 'Transcribe the audio verbatim in its original language. Output only the transcription, nothing else.';
      } else {
        instruction = `Transcribe the audio and translate it to ${lang}. Output only the translation, nothing else.`;
      }
    }
    const sampleRateHz = (ctx.params.sampleRateHz as number | undefined) ?? 16000;
    const flushSec = (ctx.params.flushSec as number | undefined) ?? 30;
    const timeoutMs = (ctx.params.timeoutMs as number | undefined) ?? 120_000;
    const maxTranslateChars = (ctx.params.maxTranslateChars as number | undefined) ?? 4000;
    const onCaption = ctx.bindings.__onCaption as
      | ((c: { text: string; final: boolean }) => void)
      | undefined;

    let stopped = false;
    let pending: Uint8Array = new Uint8Array(0); // PCM s16le acumulado
    let inFlight = false;

    function appendPcm(bytes: Uint8Array): void {
      const merged = new Uint8Array(pending.byteLength + bytes.byteLength);
      merged.set(pending, 0);
      merged.set(bytes, pending.byteLength);
      pending = merged;
    }

    function toWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
      // header WAV PCM16 mono de 44 bytes + payload cru
      const header = new ArrayBuffer(44);
      const v = new DataView(header);
      const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
      str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      str(36, 'data'); v.setUint32(40, pcm.byteLength, true);
      const out = new Uint8Array(44 + pcm.byteLength);
      out.set(new Uint8Array(header), 0);
      out.set(pcm, 44);
      return out;
    }

    async function flush(fromStop = false): Promise<void> {
      if (stopped || inFlight || pending.byteLength === 0) return;
      const pcm = pending;
      pending = new Uint8Array(0);
      inFlight = true;
      const seconds = pcm.byteLength / 2 / sampleRateHz;
      const t0 = Date.now();
      try {
        const wav = toWav(pcm, sampleRateHz);
        const b64 = Buffer.from(wav).toString('base64');
        const raw = await postJsonBytes(
          `${url}/asr-translate`,
          { audioB64: b64, instruction, sample_rate: sampleRateHz },
          timeoutMs,
          // no flush do stop() o signal do run JÁ está abortado (motor aborta antes do
          // stop() dos nós) — fetch próprio limitado por timeoutMs, senão a última
          // janela pendente sempre se perde.
          fromStop ? undefined : ctx.signal,
        );
        ctx.metrics.timer('asr.lfm3.ms', Date.now() - t0);
        ctx.metrics.counter('asr.lfm3.seconds', seconds);
        let text = '';
        try {
          text = String((JSON.parse(new TextDecoder().decode(raw)) as { text?: string }).text ?? '');
        } catch {
          ctx.log('error', 'asr.lfm3: resposta não-JSON do sidecar');
        }
        text = text.slice(0, maxTranslateChars).trim();
        if (text) {
          ctx.log('info', `tradução (${seconds.toFixed(1)}s de áudio): "${text.slice(0, 80)}"`);
          await ctx.emit('out', { text, final: true }, { meta: { seconds } });
          try { onCaption?.({ text, final: true }); } catch { /* callback do host */ }
        } else {
          ctx.log('info', `tradução vazia (${seconds.toFixed(1)}s de áudio)`);
        }
      } catch (e: unknown) {
        const err = e as Error;
        if (err?.name === 'AbortError' || ctx.signal.aborted) return;
        ctx.log('error', `asr.lfm3 falhou: ${err?.message ?? String(e)}`);
        ctx.metrics.counter('asr.lfm3.errors', 1);
      } finally {
        inFlight = false;
      }
    }

    function extractPcm(payload: unknown): Uint8Array | null {
      if (payload instanceof Uint8Array) return payload; // s16le cru (capture.ffmpeg)
      if (payload !== null && typeof payload === 'object') {
        const pl = payload as { format?: string; data?: Uint8Array };
        if (pl.format === 'wav' && pl.data instanceof Uint8Array) {
          // descarta os 44 bytes de header (gerado por nós nossos; robusto o suficiente p/ PCM16 mono)
          return pl.data.byteLength > 44 ? pl.data.subarray(44) : null;
        }
      }
      return null;
    }

    return {
      async start() {},
      async onInput(_port, msg: Envelope) {
        if (stopped || ctx.signal.aborted || msg.control) return;
        const pcm = extractPcm(msg.payload);
        if (!pcm || pcm.byteLength === 0) return;
        appendPcm(pcm);
        if (pending.byteLength / 2 / sampleRateHz >= flushSec) await flush();
      },
      async stop() {
        // fim da fonte: traduz o resto pendente antes de encerrar.
        // ponytail: espera polling de 20 ms o flush em curso assentar (limitado pelo
        // timeoutMs do fetch); upgrade = evento/condvar se isso virar caminho quente.
        while (inFlight) await new Promise((r) => setTimeout(r, 20));
        await flush(true);
        stopped = true;
      },
    };
  },
};
