// falador-nodes — decision.llm: nó de DECISÃO (System 1 barato) para roteirização no grafo.
// Usa o LLM residente (omlx/LFM3-1.7B) para escolher UMA opção dentre params.options
// e emite o payload recebido NA PORTA da opção escolhida (uma porta de saída por opção).
// Ex. cenario2-auto: options ['auto','humano'] → human.approve só no ramo 'humano'.
// NÃO VERIFICADO vs. modelos de decisão dedicados (Laya): decisão zero-shot de LLM
// é mais lenta e menos calibrada que um encoder treinado — trocar/instalar depois se medir.
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { payloadText, postSse } from './sse.ts';

const DEFAULT_BASE = 'http://127.0.0.1:8080';
const DEFAULT_MODEL = 'LiquidAI--LFM3-1.7B-MLX-4bit';

export const decisionLlm: NodeTypeDef = {
  type: 'decision.llm',
  paramNames: ['baseUrl', 'model', 'options', 'instructions', 'temperature', 'maxTokens', 'enableThinking', 'defaultOption'],
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
    const options = (ctx.params.options as string[]) ?? [];
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

    return {
      async start() {},
      async onInput(_port, msg) {
        if (msg.control) return;
        const pl = payloadText(msg.payload);
        if (!pl || !pl.final) return; // decide no fechamento
        const text = (pl.text ?? '').trim();
        if (!text) return;

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

        const chosen = pickOption(acc);
        ctx.metrics.counter(`decision.llm.${chosen}`, 1);
        await ctx.emit(chosen, { text: pl.text, final: true });
      },
      async stop() {},
    } as NodeRuntime & { _chosen?: string };
  },
};
