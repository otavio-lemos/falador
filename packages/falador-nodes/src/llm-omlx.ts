// falador-nodes — llm.omlx: LLM local omlx/LM-Studio-OpenAI-compat em :8080 (Spec r2)
// ENTRADA:  in (phrase) texto pronto; parcs (tokens_parcial) age só no final:true.
// SAÍDA:    out (tokens_parcial) cumulativo {text, final}.
// BINDINGS OPCIONAIS:
//   __registerReset?: (resetFn: () => void) => void — registra callback de limpeza do histórico em runtime (ADR-006 Fase 4).
//   __onResetHistory?: (resetFn: () => void) => void — alias opcional para __registerReset.
//   __getContext?: (query: string, opts: { topK: number; tags?: string[]; maxChars: number }) => string — RAG local (ADR-007).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlMsg, NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { postSse, payloadText } from './sse.ts';
import { inheritTrace } from './trace.ts';
import { formatContextBlock, searchChunks, type ContextDocument } from './context-store.ts';

function defaultGetContext(
  query: string,
  opts: { topK: number; tags?: string[]; maxChars: number },
): string {
  try {
    const dir = process.env.FALADOR_CONTEXT_DIR || join(process.cwd(), 'context');
    const file = join(dir, 'docs.json');
    if (!existsSync(file)) return '';
    const raw = readFileSync(file, 'utf-8');
    const docs = JSON.parse(raw) as ContextDocument[];
    if (!Array.isArray(docs) || docs.length === 0) return '';
    const chunks = searchChunks(docs, query, opts);
    if (chunks.length === 0) return '';
    return formatContextBlock(chunks, opts.maxChars);
  } catch {
    return '';
  }
}

const DEFAULT_BASE = 'http://127.0.0.1:8080';
const DEFAULT_MODEL = 'LiquidAI--LFM3-1.7B-MLX-4bit';

export type ContextProvider = (
  query: string,
  opts: { topK: number; tags?: string[]; maxChars: number },
) => string;

function requiredString(p: Record<string, unknown>, key: string, errs: { path: string; code: string; message: string }[]) {
  const v = p[key];
  if (v !== undefined && typeof v !== 'string') {
    errs.push({ path: `params.${key}`, code: 'INVALID_PARAM', message: `${key} deve ser string` });
  }
}

function historyTotalChars(hist: Array<{ role: 'user' | 'assistant'; content: string }>): number {
  let total = 0;
  for (const h of hist) total += h.content.length;
  return total;
}

export const llmOmlx: NodeTypeDef = {
  type: 'llm.omlx',
  paramNames: [
    'baseUrl',
    'model',
    'targetLanguage',
    'system',
    'template',
    'temperature',
    'maxTokens',
    'enableThinking',
    'historyMax',
    'historyCharBudget',
    'useContext',
    'contextTopK',
    'contextTags',
    'contextMaxChars',
  ],
  bindingNames: ['__registerReset', '__onResetHistory', '__getContext'],
  inputs: [
    { name: 'in', type: 'phrase' },
    { name: 'parcs', type: 'tokens_parcial' },
  ],
  outputs: [{ name: 'out', type: 'tokens_parcial' }],
  validateParams: (p) => {
    const errs: { path: string; code: string; message: string }[] = [];
    requiredString(p, 'baseUrl', errs);
    requiredString(p, 'model', errs);
    requiredString(p, 'system', errs);
    if (p.template !== undefined && !Array.isArray(p.template)) {
      errs.push({ path: 'params.template', code: 'INVALID_PARAM', message: 'template deve ser array de strings' });
    } else if (Array.isArray(p.template) && p.template.some((t: unknown) => typeof t !== 'string')) {
      errs.push({ path: 'params.template', code: 'INVALID_PARAM', message: 'template deve ser array de strings' });
    }
    const nums: string[] = ['temperature', 'maxTokens', 'historyMax', 'historyCharBudget', 'contextTopK', 'contextMaxChars'];
    for (const k of nums) {
      if (p[k] !== undefined && (typeof p[k] !== 'number' || Number.isNaN(p[k]))) {
        errs.push({ path: `params.${k}`, code: 'INVALID_PARAM', message: `${k} deve ser número` });
      }
    }
    if (p.historyCharBudget !== undefined && typeof p.historyCharBudget === 'number' && p.historyCharBudget < 0) {
      errs.push({ path: 'params.historyCharBudget', code: 'INVALID_PARAM', message: 'historyCharBudget deve ser >= 0' });
    }
    if (p.contextTopK !== undefined && typeof p.contextTopK === 'number' && p.contextTopK <= 0) {
      errs.push({ path: 'params.contextTopK', code: 'INVALID_PARAM', message: 'contextTopK deve ser > 0' });
    }
    if (p.contextMaxChars !== undefined && typeof p.contextMaxChars === 'number' && p.contextMaxChars <= 0) {
      errs.push({ path: 'params.contextMaxChars', code: 'INVALID_PARAM', message: 'contextMaxChars deve ser > 0' });
    }
    if (p.enableThinking !== undefined && typeof p.enableThinking !== 'boolean') {
      errs.push({ path: 'params.enableThinking', code: 'INVALID_PARAM', message: 'enableThinking deve ser boolean' });
    }
    if (p.useContext !== undefined && typeof p.useContext !== 'boolean') {
      errs.push({ path: 'params.useContext', code: 'INVALID_PARAM', message: 'useContext deve ser boolean' });
    }
    if (p.contextTags !== undefined && (!Array.isArray(p.contextTags) || p.contextTags.some((t: unknown) => typeof t !== 'string'))) {
      errs.push({ path: 'params.contextTags', code: 'INVALID_PARAM', message: 'contextTags deve ser array de strings' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const baseUrl = (ctx.params.baseUrl as string | undefined) ?? DEFAULT_BASE;
    const model = (ctx.params.model as string | undefined) ?? DEFAULT_MODEL;
    const system = ctx.params.system as string | undefined;
    // targetLanguage: atalho conveniente — se definido, injeta instrução de tradução no template.
    // O flow pode usar template explícito OU targetLanguage, não os dois.
    const targetLanguage = ctx.params.targetLanguage as string | undefined;
    const baseTemplate = (ctx.params.template as string[] | undefined) ?? [];
    const template = targetLanguage && baseTemplate.length === 0
      ? [`Translate to ${targetLanguage}, natural and spoken. Reply ONLY with the translation, no comments.`]
      : baseTemplate;
    const temperature = (ctx.params.temperature as number | undefined) ?? 0.2;
    const maxTokens = (ctx.params.maxTokens as number | undefined) ?? 256;
    const enableThinking = (ctx.params.enableThinking as boolean | undefined) ?? false;
    const historyMax = (ctx.params.historyMax as number | undefined) ?? 0;
    const historyCharBudget = (ctx.params.historyCharBudget as number | undefined) ?? 4000;
    const useContext = (ctx.params.useContext as boolean | undefined) ?? false;
    const contextTopK = (ctx.params.contextTopK as number | undefined) ?? 3;
    const contextTags = ctx.params.contextTags as string[] | undefined;
    const contextMaxChars = (ctx.params.contextMaxChars as number | undefined) ?? 2400;

    const getContext = ctx.bindings.__getContext as ContextProvider | undefined;
    const registerReset = (ctx.bindings.__registerReset ?? ctx.bindings.__onResetHistory) as
      | ((fn: () => void) => void)
      | undefined;

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let reportedHistoryTurns = 0;
    let controller: AbortController | null = null;
    let interruptedCurrent = false;

    function syncHistoryTurnsMetric(): void {
      const turns = Math.floor(history.length / 2);
      const delta = turns - reportedHistoryTurns;
      if (delta !== 0) {
        ctx.metrics.counter('llm.omlx.historyTurns', delta);
        reportedHistoryTurns = turns;
      }
    }

    function resetHistory(): void {
      history.length = 0;
      ctx.metrics.counter('llm.omlx.historyResets', 1);
      syncHistoryTurnsMetric();
    }

    if (typeof registerReset === 'function') {
      registerReset(resetHistory);
    }

    return {
      async start() {},
      async onInput(_port, msg) {
        const pl = payloadText(msg.payload);
        if (!pl) return; // ignore payloads não-textuais
        if (_port === 'parcs' && !pl.final) return; // LLM age só no fechamento da frase
        const userText = pl.text.trim();
        if (!userText) return;

        // Poda pares mais antigos para respeitar historyCharBudget antes de montar messages
        while (history.length >= 2 && historyTotalChars(history) > historyCharBudget) {
          history.splice(0, 2);
        }
        syncHistoryTurnsMetric();

        let effectiveSystem = system;
        if (useContext) {
          const provider = typeof getContext === 'function' ? getContext : defaultGetContext;
          try {
            const retrieved = provider(userText, {
              topK: contextTopK,
              tags: contextTags,
              maxChars: contextMaxChars,
            });
            if (retrieved && retrieved.trim().length > 0) {
              const trimmed = retrieved.trim();
              const block = trimmed.startsWith('[DOCUMENTAÇÃO OFICIAL RELEVANTE]')
                ? trimmed
                : `[DOCUMENTAÇÃO OFICIAL RELEVANTE]\n${trimmed}`;
              effectiveSystem = effectiveSystem ? `${effectiveSystem}\n\n${block}` : block;
            }
          } catch (e: unknown) {
            ctx.log('warn', `llm.omlx context retrieval falhou: ${(e as Error)?.message ?? String(e)}`);
          }
        }

        const messages: Array<{ role: string; content: string }> = [];
        if (effectiveSystem) messages.push({ role: 'system', content: effectiveSystem });
        for (const h of history) messages.push(h);
        messages.push({ role: 'user', content: [...template, userText].join('\n\n') });

        const ctrl = new AbortController();
        controller = ctrl;
        interruptedCurrent = false;
        const onRunAbort = () => ctrl.abort();
        ctx.signal.addEventListener('abort', onRunAbort, { once: true });

        const body: Record<string, unknown> = {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
          chat_template_kwargs: { enable_thinking: enableThinking },
        };

        let acc = '';
        let t0 = 0;
        let tLlmTtftMs: number | undefined;
        const tStart = Date.now();
        let ttftLogged = false;
        try {
          await postSse(`${baseUrl}/v1/chat/completions`, body, {
            onData(json) {
              if (interruptedCurrent || ctrl.signal.aborted) return;
              const delta = (json as any)?.choices?.[0]?.delta?.content;
              if (typeof delta !== 'string' || delta.length === 0) return;
              if (!ttftLogged) {
                const now = Date.now();
                tLlmTtftMs = now;
                t0 = now - tStart;
                ctx.metrics.timer('llm.omlx.ttftMs', t0);
                ttftLogged = true;
              }
              acc += delta;
              void ctx
                .emit(
                  'out',
                  { text: acc, final: false },
                  { meta: { ...msg.meta, ...inheritTrace(msg, { tLlmTtftMs }), ttftMs: t0 } },
                )
                .catch(() => {});
            },
            onDone() {
              ctx.metrics.timer('llm.omlx.totalMs', Date.now() - tStart);
            },
          }, ctrl.signal);
        } catch (e: unknown) {
          const err = e as Error;
          if (interruptedCurrent) {
            // já contabilizado em llm.omlx.interrupted
          } else if (err?.name === 'AbortError' || ctx.signal.aborted) {
            // stop do Run ou cancel do host
            ctx.metrics.counter('llm.omlx.aborted', 1);
          } else {
            ctx.log('error', `llm.omlx falhou: ${err?.message ?? String(e)}`);
          }
        } finally {
          ctx.signal.removeEventListener('abort', onRunAbort);
          if (controller === ctrl) controller = null;
        }

        // Em interrupt: NÃO emite final:true e NÃO grava no history
        if (interruptedCurrent) return;

        // Fecha o stream com final:true (nunca com texto vazio)
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

        // Bugfix historyMax === 0: só grava quando historyMax > 0, texto não-vazio e sem abort
        if (historyMax > 0 && acc.trim().length > 0 && !ctx.signal.aborted) {
          history.push({ role: 'user', content: userText });
          history.push({ role: 'assistant', content: acc });
          if (history.length > historyMax * 2) {
            history.splice(0, history.length - historyMax * 2);
          }
          while (history.length >= 2 && historyTotalChars(history) > historyCharBudget) {
            history.splice(0, 2);
          }
          syncHistoryTurnsMetric();
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
          ctx.metrics.counter('llm.omlx.interrupted', 1);
        }
      },
    };
  },
};
