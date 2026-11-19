// falador-nodes — human.approve: Cenário 2 (entrevista técnica).
// Segura a sugestão do LLM; NÃO emite nada até o host aprovar/editar/rejeitar
// via binding __gate: { request(text) → Promise<string|null> }.
// null = rejeitado; string = texto (editado ou original) emitido como phrase.
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { payloadText } from './sse.ts';

export interface GateHolder {
  request(text: string): Promise<string | null>;
}

export const humanApprove: NodeTypeDef = {
  type: 'human.approve',
  paramNames: [],
  bindingNames: ['__gate'],
  requiredBindings: ['__gate'],
  inputs: [{ name: 'in', type: 'tokens_parcial' }],
  outputs: [{ name: 'out', type: 'phrase' }],
  validateParams: () => [],
  create: (ctx: NodeCtx): NodeRuntime => {
    const gate = ctx.bindings.__gate as GateHolder;
    let inFlight = false;

    return {
      async start() {},
      async onInput(_port, msg) {
        if (msg.control) return;
        const pl = payloadText(msg.payload);
        if (!pl) return;
        if (!pl.final) return; // age só no fechamento (parciais do LLM passam direto)
        const text = (pl.text ?? '').trim();
        if (!text) return;
        if (inFlight) return; // uma sugestão por vez; ignora novas até decidir
        inFlight = true;
        try {
          const decision = await gate.request(text);
          if (decision !== null && decision.trim()) {
            ctx.metrics.counter('human.approve.approved', 1);
            await ctx.emit('out', decision);
          } else {
            ctx.metrics.counter('human.approve.rejected', 1);
          }
        } finally {
          inFlight = false;
        }
      },
      async stop() {},
    };
  },
};
