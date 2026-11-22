// falador-nodes — human.approve: Cenário 2 (entrevista técnica) e Ops/SRE (ADR-007).
// Segura a sugestão do LLM; NÃO emite nada até o host aprovar/editar/rejeitar
// via binding __gate: { request(text, meta?) → Promise<string|null>, cancel?(reason?) }.
// null = rejeitado; string = texto (editado ou original) emitido como phrase.
import type { ControlMsg, NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { payloadText } from './sse.ts';
import { inheritTrace, type TraceMeta } from './trace.ts';

export interface GateMeta {
  decision?: string;
  host?: string;
  command?: string;
  reason?: string;
  trace?: TraceMeta;
}

export interface GateHolder {
  request(text: string, meta?: GateMeta): Promise<string | null>;
  cancel?(reason?: string): void;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  let candidate = trimmed;
  if (!candidate.startsWith('{')) {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (match) candidate = match[1].trim();
  }
  if (!candidate.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* texto não é JSON válido */
  }
  return null;
}

function extractGateMeta(text: string, msgMeta?: Record<string, unknown>): GateMeta {
  const out: GateMeta = {};
  if (typeof msgMeta?.decision === 'string') out.decision = msgMeta.decision;
  if (msgMeta?.trace && typeof msgMeta.trace === 'object') {
    out.trace = msgMeta.trace as TraceMeta;
  }
  const obj = tryParseJsonObject(text);
  if (obj) {
    if (typeof obj.host === 'string') out.host = obj.host;
    if (typeof obj.command === 'string') out.command = obj.command;
    if (typeof obj.reason === 'string') out.reason = obj.reason;
    if (typeof obj.decision === 'string' && !out.decision) out.decision = obj.decision;
  }
  return out;
}

export const humanApprove: NodeTypeDef = {
  type: 'human.approve',
  paramNames: ['mode'],
  bindingNames: ['__gate'],
  requiredBindings: ['__gate'],
  inputs: [{ name: 'in', type: 'tokens_parcial' }],
  outputs: [{ name: 'out', type: 'phrase' }],
  validateParams: (p) => {
    if (p.mode !== undefined && p.mode !== 'manual' && p.mode !== 'auto') {
      return [{ path: 'params.mode', code: 'INVALID_PARAM', message: "mode deve ser 'manual' | 'auto'" }];
    }
    return [];
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const gate = ctx.bindings.__gate as GateHolder;
    const mode = (ctx.params.mode as 'manual' | 'auto' | undefined) ?? 'manual';
    let inFlight = false;
    let cancelPending: ((reason: string) => void) | null = null;

    return {
      async start() {},
      async onInput(_port, msg) {
        if (msg.control) return;
        const pl = payloadText(msg.payload);
        if (!pl) return;
        if (!pl.final) return; // age só no fechamento (parciais do LLM passam direto)
        const text = (pl.text ?? '').trim();
        if (!text) return;
        if (mode === 'auto') {
          ctx.metrics.counter('human.approve.bypassed', 1);
          await ctx.emit('out', text, {
            meta: { ...msg.meta, ...inheritTrace(msg, {}) },
          });
          return;
        }
        if (inFlight) return; // uma sugestão por vez; ignora novas até decidir
        inFlight = true;
        let interrupted = false;
        const gateMeta = extractGateMeta(text, msg.meta);
        try {
          const decision = await new Promise<string | null>((resolve, reject) => {
            let settled = false;
            cancelPending = (reason: string) => {
              if (settled) return;
              settled = true;
              interrupted = true;
              try {
                gate.cancel?.(reason);
              } catch {
                /* ignore */
              }
              resolve(null);
            };
            Promise.resolve(gate.request(text, gateMeta)).then(
              (val) => {
                if (settled) return;
                settled = true;
                resolve(val);
              },
              (err) => {
                if (settled) return;
                settled = true;
                reject(err);
              },
            );
          });
          if (interrupted) {
            ctx.metrics.counter('human.approve.interrupted', 1);
          } else if (decision !== null && decision.trim()) {
            ctx.metrics.counter('human.approve.approved', 1);
            await ctx.emit('out', decision, {
              meta: { ...msg.meta, ...inheritTrace(msg, {}) },
            });
          } else {
            ctx.metrics.counter('human.approve.rejected', 1);
          }
        } finally {
          cancelPending = null;
          inFlight = false;
        }
      },
      async stop() {
        cancelPending?.('stop');
      },
      onControl(c: ControlMsg) {
        if (c.kind === 'interrupt' && cancelPending) {
          cancelPending('interrupted');
        }
      },
    };
  },
};
