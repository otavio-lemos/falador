// falador-nodes — translate.llm: nó dedicado de tradução via omlx (modelo + idioma).
// Se targetLanguage ou model estiver vazio / '-' / '—' / 'none' / 'off', atua em modo passthrough
// sem chamar nenhum LLM.
import type { ControlMsg, NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { payloadText, postSse } from './sse.ts';
import { inheritTrace } from './trace.ts';

const DEFAULT_BASE = 'http://127.0.0.1:8080';
const DEFAULT_MODEL = 'LiquidAI--LFM3-1.7B-MLX-4bit';

function isDisabledValue(v: string): boolean {
  const s = v.trim();
  return !s || s === '-' || s === '—' || s.toLowerCase() === 'none' || s.toLowerCase() === 'off';
}

export const translateLlm: NodeTypeDef = {
  type: 'translate.llm',
  paramNames: ['baseUrl', 'model', 'targetLanguage', 'temperature', 'maxTokens', 'enableThinking'],
  bindingNames: ['__onThought'],
  inputs: [
    { name: 'in', type: 'phrase' },
    { name: 'parcs', type: 'tokens_parcial' },
  ],
  outputs: [{ name: 'out', type: 'tokens_parcial' }],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    for (const k of ['baseUrl', 'model', 'targetLanguage'] as const) {
      if (p[k] !== undefined && typeof p[k] !== 'string') {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser string` });
      }
    }
    for (const k of ['temperature', 'maxTokens'] as const) {
      if (p[k] !== undefined && (typeof p[k] !== 'number' || Number.isNaN(p[k]))) {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser número` });
      }
    }
    if (p.enableThinking !== undefined && typeof p.enableThinking !== 'boolean') {
      errs.push({ path: 'params.enableThinking', code: 'INVALID_PARAM', message: 'enableThinking deve ser boolean' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const baseUrl = (ctx.params.baseUrl as string | undefined) ?? DEFAULT_BASE;
    const rawModel = (ctx.params.model as string | undefined) ?? DEFAULT_MODEL;
    const rawLang = String(ctx.params.targetLanguage ?? '').trim();
    const disabled = isDisabledValue(rawLang) || isDisabledValue(rawModel);
    const temperature = (ctx.params.temperature as number | undefined) ?? 0.1;
    const maxTokens = (ctx.params.maxTokens as number | undefined) ?? 256;
    const enableThinking = (ctx.params.enableThinking as boolean | undefined) ?? false;

    let controller: AbortController | null = null;
    let interruptedCurrent = false;
    let thoughtSeq = 0;
    const onThought = ctx.bindings.__onThought as
      | ((ev: { thoughtId: string; text: string; final: boolean }) => void)
      | undefined;

    return {
      async start() {},
      async onInput(port, msg) {
        if (msg.control) return;
        const pl = payloadText(msg.payload);
        if (!pl) return;

        if (disabled) {
          if (!pl.text) return;
          await ctx.emit('out', { text: pl.text, final: pl.final }, { meta: msg.meta });
          return;
        }

        if (port === 'parcs' && !pl.final) return;
        const userText = pl.text.trim();
        if (!userText) return;

        const ctrl = new AbortController();
        controller = ctrl;
        interruptedCurrent = false;
        const onRunAbort = () => ctrl.abort();
        ctx.signal.addEventListener('abort', onRunAbort, { once: true });

        const body: Record<string, unknown> = {
          model: rawModel,
          messages: [
            {
              role: 'system',
              content: `Translate the following text into ${rawLang}. Respond in text.`,
            },
            { role: 'user', content: `Translate into ${rawLang}:\n${userText}` },
          ],
          temperature,
          max_tokens: maxTokens,
          ...(userText.includes('\n\n') ? {} : { stop: ['\n\n'] }),
          stream: true,
          chat_template_kwargs: { enable_thinking: enableThinking },
        };

        let acc = '';
        let reasoningAcc = '';
        const thoughtId = `${ctx.id}:${++thoughtSeq}`;
        let t0 = 0;
        let tLlmTtftMs: number | undefined;
        const tStart = Date.now();
        let ttftLogged = false;

        try {
          await postSse(
            `${baseUrl}/v1/chat/completions`,
            body,
            {
              onData(json) {
                if (interruptedCurrent || ctrl.signal.aborted) return;
                const deltaObj = (json as { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }> })?.choices?.[0]?.delta ?? {};
                const delta = deltaObj.content;
                const reasoning = deltaObj.reasoning_content;
                if (typeof reasoning === 'string' && reasoning.length > 0) {
                  reasoningAcc += reasoning;
                  try { onThought?.({ thoughtId, text: reasoningAcc, final: false }); } catch { /* callback do host */ }
                }
                if (typeof delta !== 'string' || delta.length === 0) return;
                if (!ttftLogged) {
                  const now = Date.now();
                  tLlmTtftMs = now;
                  t0 = now - tStart;
                  ctx.metrics.timer('translate.llm.ttftMs', t0);
                  ttftLogged = true;
                }
                acc = (acc + delta).replace(/^(?:<\|(?:mixed_start|audio_start|text_end)\|>)+/, '');
                if (!acc) return;
                void ctx
                  .emit(
                    'out',
                    { text: acc, final: false },
                    { meta: { ...msg.meta, ...inheritTrace(msg, { tLlmTtftMs }), ttftMs: t0 } },
                  )
                  .catch(() => {});
              },
              onDone() {
                ctx.metrics.timer('translate.llm.totalMs', Date.now() - tStart);
              },
            },
            ctrl.signal,
          );
        } catch (e: unknown) {
          const err = e as Error;
          if (interruptedCurrent) {
            // já contabilizado em translate.llm.interrupted
          } else if (err?.name === 'AbortError' || ctx.signal.aborted) {
            ctx.metrics.counter('translate.llm.aborted', 1);
          } else {
            ctx.log('error', `translate.llm falhou: ${err?.message ?? String(e)}`);
          }
        } finally {
          ctx.signal.removeEventListener('abort', onRunAbort);
          if (controller === ctrl) controller = null;
        }

        if (interruptedCurrent) return;
        if (reasoningAcc) {
          try { onThought?.({ thoughtId, text: reasoningAcc, final: true }); } catch { /* callback do host */ }
        }

        if (acc.length > 0) {
          const tLlmFinalMs = Date.now();
          await ctx.emit(
            'out',
            { text: acc, final: true },
            {
              meta: {
                ...msg.meta,
                ...inheritTrace(msg, { tLlmTtftMs: tLlmTtftMs ?? tLlmFinalMs, tLlmFinalMs }),
                ttftMs: t0,
              },
            },
          );
        }
      },
      async stop() {
        controller?.abort();
        controller = null;
      },
      onControl(c: ControlMsg) {
        if (c.kind === 'interrupt' && controller !== null) {
          interruptedCurrent = true;
          controller.abort();
          ctx.metrics.counter('translate.llm.interrupted', 1);
        }
      },
    };
  },
};
