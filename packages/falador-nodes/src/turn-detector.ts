// falador-nodes — turn.detector: detecção semântica de fim de turno (ADR-006 Fase 3)
// Usa d1-2B via /v1/systemone (~40 ms warm) com fast-path `?` e fallback por timeout maxWaitMs.
// ENTRADA:  in (tokens_parcial)
// SAÍDA:    out (tokens_parcial)
import type { ControlMsg, Envelope, NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { payloadText, postJsonBytes } from './sse.ts';
import { inheritTrace } from './trace.ts';

const DEFAULT_BASE = 'http://127.0.0.1:8080';
const DEFAULT_MODEL = 'd1-2B-MLX-4bit';
const SYSTEMONE_TIMEOUT_MS = 300;

function wordCount(s: string): number {
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export const turnDetector: NodeTypeDef = {
  type: 'turn.detector',
  paramNames: [
    'baseUrl',
    'model',
    'mode',
    'minWords',
    'completeThreshold',
    'maxWaitMs',
    'maxMergedTurns',
  ],
  inputs: [{ name: 'in', type: 'tokens_parcial' }],
  outputs: [{ name: 'out', type: 'tokens_parcial', required: true }],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    for (const k of ['baseUrl', 'model']) {
      if (p[k] !== undefined && typeof p[k] !== 'string') {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser string` });
      }
    }
    if (p.mode !== undefined && p.mode !== 'systemone' && p.mode !== 'heuristic') {
      errs.push({ path: 'params.mode', code: 'INVALID_PARAM', message: "mode deve ser 'systemone' | 'heuristic'" });
    }
    if (p.minWords !== undefined && (typeof p.minWords !== 'number' || Number.isNaN(p.minWords) || p.minWords < 1)) {
      errs.push({ path: 'params.minWords', code: 'INVALID_PARAM', message: 'minWords deve ser número >= 1' });
    }
    if (
      p.completeThreshold !== undefined &&
      (typeof p.completeThreshold !== 'number' || Number.isNaN(p.completeThreshold) || p.completeThreshold < 0 || p.completeThreshold > 1)
    ) {
      errs.push({ path: 'params.completeThreshold', code: 'INVALID_PARAM', message: 'completeThreshold deve estar em [0, 1]' });
    }
    if (p.maxWaitMs !== undefined && (typeof p.maxWaitMs !== 'number' || Number.isNaN(p.maxWaitMs) || p.maxWaitMs <= 0)) {
      errs.push({ path: 'params.maxWaitMs', code: 'INVALID_PARAM', message: 'maxWaitMs deve ser número > 0' });
    }
    if (p.maxMergedTurns !== undefined && (typeof p.maxMergedTurns !== 'number' || Number.isNaN(p.maxMergedTurns) || p.maxMergedTurns < 1)) {
      errs.push({ path: 'params.maxMergedTurns', code: 'INVALID_PARAM', message: 'maxMergedTurns deve ser número >= 1' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const baseUrl = (ctx.params.baseUrl as string | undefined) ?? DEFAULT_BASE;
    const model = (ctx.params.model as string | undefined) ?? DEFAULT_MODEL;
    const mode = (ctx.params.mode as 'systemone' | 'heuristic' | undefined) ?? 'systemone';
    const minWords = (ctx.params.minWords as number | undefined) ?? 3;
    const completeThreshold = (ctx.params.completeThreshold as number | undefined) ?? 0.65;
    const maxWaitMs = (ctx.params.maxWaitMs as number | undefined) ?? 2200;
    const maxMergedTurns = (ctx.params.maxMergedTurns as number | undefined) ?? 4;

    let buffer = '';
    let mergedCount = 0;
    let lastMsg: Envelope | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function clearWait(): void {
      if (waitTimer !== null) {
        clearTimeout(waitTimer);
        waitTimer = null;
      }
    }

    async function flushBuffer(reason: 'immediate' | 'timeoutFlush' | 'stop'): Promise<void> {
      clearWait();
      const text = buffer.trim();
      const refMsg = lastMsg;
      buffer = '';
      mergedCount = 0;
      lastMsg = undefined;
      if (!text) return;
      if (reason === 'immediate') {
        ctx.metrics.counter('turn.detector.immediate', 1);
      } else if (reason === 'timeoutFlush') {
        ctx.metrics.counter('turn.detector.timeoutFlush', 1);
      }
      await ctx.emit(
        'out',
        { text, final: true },
        { meta: { ...refMsg?.meta, ...inheritTrace(refMsg, { tTurnMs: Date.now() }) } },
      );
    }

    function armWait(): void {
      clearWait();
      waitTimer = setTimeout(() => {
        waitTimer = null;
        if (stopped) return;
        void flushBuffer('timeoutFlush').catch(() => {});
      }, maxWaitMs);
    }

    async function checkSystemOne(text: string): Promise<'complete' | 'incomplete'> {
      const body = {
        model,
        state: text.slice(0, 4000),
        questions: {
          turn: {
            type: 'choice',
            instructions:
              'Determine if the speaker has finished their thought/question or paused mid-sentence.',
            criteria: {
              complete: 'Complete question, statement, or clear end of turn',
              incomplete: 'Cut off mid-sentence, filler pause, or clearly continuing',
            },
          },
        },
      };
      try {
        const raw = await postJsonBytes(`${baseUrl}/v1/systemone`, body, SYSTEMONE_TIMEOUT_MS, ctx.signal);
        const parsed = JSON.parse(new TextDecoder().decode(raw)) as {
          answers?: { turn?: { choice?: string; confidence?: number } };
        };
        const ans = parsed.answers?.turn;
        if (ans?.choice === 'complete' && (ans.confidence ?? 1) >= completeThreshold) {
          return 'complete';
        }
        return 'incomplete';
      } catch (e: unknown) {
        ctx.log('warn', `turn.detector systemone fallback: ${(e as Error)?.message ?? String(e)}`);
        return 'incomplete';
      }
    }

    return {
      async start() {},
      async onInput(_port, msg) {
        if (msg.control || stopped) return;
        const pl = payloadText(msg.payload);
        if (!pl) return;

        // Parciais: cancelam waitTimer (falante retomou) e repassam preview
        if (!pl.final) {
          clearWait();
          const preview = buffer ? `${buffer} ${pl.text}`.trim() : pl.text;
          await ctx.emit(
            'out',
            { text: preview, final: false },
            { meta: { ...msg.meta, ...inheritTrace(msg, {}) } },
          );
          return;
        }

        const seg = pl.text.trim();
        if (!seg) return;
        clearWait();
        buffer = buffer ? `${buffer} ${seg}` : seg;
        mergedCount += 1;
        lastMsg = msg;

        const words = wordCount(buffer);

        // Fast-path: termina com `?` e >= minWords fecha sem HTTP
        if (buffer.endsWith('?') && words >= minWords) {
          await flushBuffer('immediate');
          return;
        }

        // Teto de segmentos concatenados
        if (mergedCount >= maxMergedTurns) {
          await flushBuffer('immediate');
          return;
        }

        // Turno muito curto só fecha por timeout
        if (words < minWords) {
          armWait();
          return;
        }

        if (mode === 'heuristic') {
          if (/[.!?]$/.test(buffer)) {
            await flushBuffer('immediate');
          } else {
            armWait();
          }
          return;
        }

        // mode === 'systemone'
        const verdict = await checkSystemOne(buffer);
        if (stopped) return;
        if (verdict === 'complete') {
          await flushBuffer('immediate');
        } else {
          armWait();
        }
      },
      async stop() {
        stopped = true;
        clearWait();
        if (buffer.trim().length > 0) {
          // Flush limpo sem depender de ctx.signal (que já foi abortado no doStop)
          await flushBuffer('stop').catch(() => {});
        }
      },
      onControl(c: ControlMsg) {
        if (c.kind === 'interrupt') {
          // Cancela waitTimer sem apagar o novo trecho que acabou de começar
          clearWait();
        }
      },
    };
  },
};
