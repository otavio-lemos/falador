// falador-nodes — decision.llm: nó de DECISÃO (System 1 barato) para roteirização no grafo.
// DOIS modos:
//   mode='chat' (default): usa o LLM residente (omlx/LFM3-1.7B) — escolhe UMA opção de
//     params.options por geração de texto e emite o payload NA PORTA da opção escolhida.
//   mode='systemone': usa o ENDPOINT DE DECISÃO do omlx (/v1/systemone) com d1-2B —
//     1 forward pass, probabilidade CALIBRADA por opção. VERIFICADO AO VIVO 2026-11-19:
//     frio 0,70 s (carga do modelo) / warm ~40 ms, d1-2B-MLX-4bit servido pelo omlx.
// Ex. cenario2-auto: options ['auto','humano'] → human.approve só no ramo 'humano'.
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { payloadText, postSse, postJsonBytes } from './sse.ts';
import { inheritTrace } from './trace.ts';

const DEFAULT_BASE = 'http://127.0.0.1:8080';
const DEFAULT_MODEL = 'LiquidAI--LFM3-1.7B-MLX-4bit';

export const decisionLlm: NodeTypeDef = {
  type: 'decision.llm',
  paramNames: ['baseUrl', 'model', 'mode', 'options', 'criteria', 'instructions', 'temperature', 'maxTokens', 'enableThinking', 'defaultOption'],
  inputs: [{ name: 'in', type: 'tokens_parcial' }],
  outputs: [], // dinâmicas: uma por opção (preenchidas em validate/create via options)
  validateParams: (p) => {
    if (!Array.isArray(p.options) || p.options.length < 1) {
      return [{ path: 'params.options', code: 'INVALID_PARAM', message: 'options deve ser array de strings (nomes das portas de saída)' }];
    }
    for (const o of p.options as unknown[]) {
      if (typeof o !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(o)) {
        return [{ path: 'params.options', code: 'INVALID_PARAM', message: `opção inválida: ${String(o)}` }];
      }
    }
    if (p.defaultOption !== undefined && !(p.options as string[]).includes(p.defaultOption as string)) {
      return [{ path: 'params.defaultOption', code: 'INVALID_PARAM', message: 'defaultOption deve estar em options' }];
    }
    return [];
  },
  // porta dinâmica: o registry/grafo lê outputs DURO do def — declaramos options como
  // def "opcional": outputs preenchidos durante build via outputsFor()
  outputsFor: (p) => {
    const opts = (Array.isArray(p.options) ? (p.options as string[]) : []) ?? [];
    return opts.map((o) => ({ name: o, type: 'tokens_parcial', required: false }));
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const baseUrl = (ctx.params.baseUrl as string | undefined) ?? DEFAULT_BASE;
    const model = (ctx.params.model as string | undefined) ?? DEFAULT_MODEL;
    const mode = (ctx.params.mode as string | undefined) ?? 'chat';
    const options = (ctx.params.options as string[]) ?? [];
    const criteria = ctx.params.criteria as Record<string, string> | undefined;
    const defaultOption = (ctx.params.defaultOption as string | undefined) ?? options[0];
    const instructions =
      (ctx.params.instructions as string | undefined) ??
      'Decida a qual categoria o texto abaixo pertence. Responda EXATAMENTE com UMA das opções, nada mais.';
    const temperature = (ctx.params.temperature as number | undefined) ?? 0.0;
    const maxTokens = (ctx.params.maxTokens as number | undefined) ?? 8;
    const enableThinking = (ctx.params.enableThinking as boolean | undefined) ?? false;

    function pickOption(answer: string): string {
      const a = answer.toLowerCase();
      for (const o of options) {
        if (a.includes(o.toLowerCase())) return o;
      }
      return defaultOption;
    }

    // mode='systemone': /v1/systemone do omlx com d1 (decisão calibrada, 1 forward pass).
    async function decideSystemOne(text: string): Promise<{ chosen: string; confidence?: number; probabilities?: Record<string, number> } | null> {
      const crit: Record<string, string> = {};
      for (const o of options) crit[o] = criteria?.[o] ?? o;
      const body = {
        model,
        state: text.slice(0, 8000),
        questions: {
          route: { type: 'choice', instructions, criteria: crit },
        },
      };
      const raw = await postJsonBytes(`${baseUrl}/v1/systemone`, body, 30_000, ctx.signal);
      const ans = (JSON.parse(new TextDecoder().decode(raw)) as {
        answers?: { route?: { choice?: string; confidence?: number; probabilities?: Record<string, number> } };
      }).answers?.route;
      if (!ans?.choice) return null;
      const chosen = options.find((o) => o === ans.choice) ?? defaultOption;
      return { chosen, confidence: ans.confidence, probabilities: ans.probabilities };
    }

    return {
      async start() {},
      async onInput(_port, msg) {
        if (msg.control) return;
        const pl = payloadText(msg.payload);
        if (!pl || !pl.final) return; // decide no fechamento
        const text = (pl.text ?? '').trim();
        if (!text) return;

        let chosen: string;
        let decisionMeta: Record<string, unknown> | undefined;
        if (mode === 'systemone') {
          try {
            const r = await decideSystemOne(text);
            if (!r) throw new Error('resposta sem choice');
            chosen = r.chosen;
            decisionMeta = { mode, confidence: r.confidence, probabilities: r.probabilities };
          } catch (e: unknown) {
            ctx.log('error', `decision.llm (systemone) falhou: ${(e as Error)?.message ?? String(e)}`);
            chosen = defaultOption;
            decisionMeta = { mode, error: String((e as Error)?.message ?? e) };
          }
        } else {
          const body: Record<string, unknown> = {
            model,
            messages: [
              { role: 'system', content: `${instructions}\nOpções válidas: ${options.join(', ')}` },
              { role: 'user', content: text.slice(0, 2000) },
            ],
            temperature,
            max_tokens: maxTokens,
            stream: true,
          };
          if (!enableThinking) body.chat_template_kwargs = { enable_thinking: false };

          let acc = '';
          await postSse(`${baseUrl}/v1/chat/completions`, body, {
            onData(json) {
              const delta = (json as any)?.choices?.[0]?.delta?.content;
              if (typeof delta === 'string') acc += delta;
            },
            onDone() {},
          }, ctx.signal).catch((e: unknown) => {
            ctx.log('error', `decision.llm falhou: ${(e as Error)?.message ?? String(e)}`);
          });
          chosen = pickOption(acc);
        }

        ctx.metrics.counter(`decision.llm.${chosen}`, 1);
        await ctx.emit(
          chosen,
          { text: pl.text, final: true, decision: decisionMeta },
          {
            meta: {
              ...msg.meta,
              ...inheritTrace(msg, { tDecisionMs: Date.now() }),
              decision: chosen,
            },
          },
        );
      },
      async stop() {},
    } as NodeRuntime & { _chosen?: string };
  },
};
