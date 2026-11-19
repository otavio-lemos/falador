// falador-nodes — llm.omlx: LLM local omlx/LM-Studio-OpenAI-compat em :8080 (Spec r2)
// ENTRADA:  in (phrase) texto pronto; parcs (tokens_parcial) age só no final:true.
// SAÍDA:    out (tokens_parcial) cumulativo {text, final}.
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { postSse, payloadText } from './sse.ts';

const DEFAULT_BASE = 'http://127.0.0.1:8080';
const DEFAULT_MODEL = 'LiquidAI--LFM3-1.7B-MLX-4bit';

function requiredString(p: Record<string, unknown>, key: string, errs: { path: string; code: string; message: string }[]) {
  const v = p[key];
  if (v !== undefined && typeof v !== 'string') {
    errs.push({ path: `params.${key}`, code: 'INVALID_PARAM', message: `${key} deve ser string` });
  }
}

export const llmOmlx: NodeTypeDef = {
  type: 'llm.omlx',
  paramNames: ['baseUrl', 'model', 'system', 'template', 'temperature', 'maxTokens', 'enableThinking', 'historyMax'],
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
    const nums: string[] = ['temperature', 'maxTokens', 'historyMax'];
    for (const k of nums) {
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
    const model = (ctx.params.model as string | undefined) ?? DEFAULT_MODEL;
    const system = ctx.params.system as string | undefined;
    // template: FRAGMENTO com '{text}' que antecede a fala do usuário.
    // DEFAULT NEUTRO (só o texto) — cada flow declara sua instrução (nada fixo):
    //   cenário 1 (legendar): ["Traduza para brasileiro natural. Só a tradução, sem comentários."]
    //   entrevista EN:        ["Suggest a short first-person ANSWER in ENGLISH…"]
    // (o default antigo era uma instrução de tradução PT embutida — sobrescrevia o
    //  system prompt de outros flows; bug apanhado no pivô ADR-005)
    const template = (ctx.params.template as string[] | undefined) ?? [];
    const temperature = (ctx.params.temperature as number | undefined) ?? 0.2;
    const maxTokens = (ctx.params.maxTokens as number | undefined) ?? 256;
    const enableThinking = (ctx.params.enableThinking as boolean | undefined) ?? false;
    const historyMax = (ctx.params.historyMax as number | undefined) ?? 0;

    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let controller: AbortController | null = null;

    return {
      async start() {},
      async onInput(_port, msg) {
        const pl = payloadText(msg.payload);
        if (!pl) return; // ignore payloads não-textuais
        if (_port === 'parcs' && !pl.final) return; // LLM age só no fechamento da frase
        const userText = pl.text.trim();
        if (!userText) return;

        const messages: Array<{ role: string; content: string }> = [];
        if (system) messages.push({ role: 'system', content: system });
        for (const h of history) messages.push(h);
        messages.push({ role: 'user', content: [...template, userText].join('\n\n') });

        controller = new AbortController();
        ctx.signal.addEventListener('abort', () => controller?.abort(), { once: true });

        const body: Record<string, unknown> = {
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        };
        if (!enableThinking) {
          body.chat_template_kwargs = { enable_thinking: false };
        }

        let acc = '';
        let t0 = 0;
        const tStart = Date.now();
        let ttftLogged = false;
        await postSse(`${baseUrl}/v1/chat/completions`, body, {
          onData(json) {
            const delta = (json as any)?.choices?.[0]?.delta?.content;
            if (typeof delta !== 'string' || delta.length === 0) return;
            if (!ttftLogged) {
              t0 = Date.now() - tStart;
              ctx.metrics.timer('llm.omlx.ttftMs', t0);
              ttftLogged = true;
            }
            acc += delta;
            void ctx
              .emit('out', { text: acc, final: false }, { meta: { ttftMs: t0 } })
              .then(() => {
                if (controller?.signal.aborted && !ctx.signal.aborted) {
                  // abortou a request: fecha com o que temos
                }
              });
          },
          onDone() {
            ctx.metrics.timer('llm.omlx.totalMs', Date.now() - tStart);
          },
        }, controller.signal).catch((e: unknown) => {
          const err = e as Error;
          if (err?.name === 'AbortError' || ctx.signal.aborted) {
            // stop do Run ou cancel do host: encerra com o parcial atual
            ctx.metrics.counter('llm.omlx.aborted', 1);
            return;
          }
          ctx.log('error', `llm.omlx falhou: ${err?.message ?? String(e)}`);
        });
        // fecha o stream com final:true (mesmo em erro — mas nunca com texto vazio)
        if (acc.length > 0) await ctx.emit('out', { text: acc, final: true }, { meta: { ttftMs: t0 } });
        history.push({ role: 'user', content: userText });
        history.push({ role: 'assistant', content: acc });
        if (historyMax > 0 && history.length > historyMax * 2) history.splice(0, history.length - historyMax * 2);
      },
      async stop() {
        controller?.abort();
        controller = null;
      },
      onControl() {}, // cancel por porta lateral: motor já descarta envelopes; aqui nada a fazer
    };
  },
};
