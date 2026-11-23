// falador-nodes — goal.validator: valida se objetivo foi atingido via LLM (ADR-008 Fase 5).
// ENTRADA: in (phrase) com { goal: string, evidence: string[] }
// SAÍDA:  out (phrase) JSON { achieved: boolean, confidence: number, gaps: string[], nextActions: string[] }
import type { ControlMsg, NodeCtx, NodeRuntime, NodeTypeDef, ParamError } from '../../falador-graph/src/index.ts';
import { payloadText } from './sse.ts';
import { inheritTrace } from './trace.ts';

interface GoalValidatorInput {
  goal: string;
  evidence: string[];
}

interface GoalValidatorOutput {
  achieved: boolean;
  confidence: number;
  gaps: string[];
  nextActions: string[];
}

export interface GoalGateMeta {
  goal: string;
  evidenceCount: number;
  trace?: Record<string, unknown>;
}

export interface GoalGateHolder {
  request(text: string, meta?: GoalGateMeta): Promise<string | null>;
  cancel?(reason?: string): void;
}

function tryParseJsonObject(text: string): GoalValidatorOutput | null {
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
      const obj = parsed as Partial<GoalValidatorOutput>;
      if (typeof obj.achieved === 'boolean' && typeof obj.confidence === 'number') {
        return {
          achieved: obj.achieved,
          confidence: obj.confidence,
          gaps: Array.isArray(obj.gaps) ? obj.gaps.map(String) : [],
          nextActions: Array.isArray(obj.nextActions) ? obj.nextActions.map(String) : [],
        };
      }
    }
  } catch {
    /* não é JSON válido */
  }
  return null;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_MODEL = 'LiquidAI--LFM3-1.7B-MLX-4bit';
const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

async function callChatCompletions(
  baseUrl: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ content: string; reasoning?: string }> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} de ${baseUrl}/v1/chat/completions: ${txt.slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
  return {
    content: data.choices?.[0]?.message?.content ?? '',
    reasoning: data.choices?.[0]?.message?.reasoning_content,
  };
}

export const goalValidator: NodeTypeDef = {
  type: 'goal.validator',
  paramNames: ['baseUrl', 'model', 'confidenceThreshold', 'system'],
  bindingNames: ['__gate'],
  inputs: [{ name: 'in', type: 'phrase' }],
  outputs: [{ name: 'out', type: 'phrase', required: true }],
  validateParams: (p): ParamError[] => {
    const errs: ParamError[] = [];
    if (p.baseUrl !== undefined && typeof p.baseUrl !== 'string') {
      errs.push({ path: 'params.baseUrl', code: 'INVALID_PARAM', message: 'baseUrl deve ser string' });
    }
    if (p.model !== undefined && typeof p.model !== 'string') {
      errs.push({ path: 'params.model', code: 'INVALID_PARAM', message: 'model deve ser string' });
    }
    if (p.confidenceThreshold !== undefined && (typeof p.confidenceThreshold !== 'number' || Number.isNaN(p.confidenceThreshold) || p.confidenceThreshold < 0 || p.confidenceThreshold > 1)) {
      errs.push({ path: 'params.confidenceThreshold', code: 'INVALID_PARAM', message: 'confidenceThreshold deve ser número entre 0 e 1' });
    }
    if (p.system !== undefined && typeof p.system !== 'string') {
      errs.push({ path: 'params.system', code: 'INVALID_PARAM', message: 'system deve ser string' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const baseUrl = (ctx.params.baseUrl as string | undefined) ?? DEFAULT_BASE_URL;
    const model = (ctx.params.model as string | undefined) ?? DEFAULT_MODEL;
    const confidenceThreshold = (ctx.params.confidenceThreshold as number | undefined) ?? DEFAULT_CONFIDENCE_THRESHOLD;
    const system = (ctx.params.system as string | undefined) ?? '';
    const gate = ctx.bindings.__gate as GoalGateHolder | undefined;

    return {
      async start() {},
      async onInput(_port, msg) {
        if (msg.control) return;
        const pl = payloadText(msg.payload);
        if (!pl) return;
        if (!pl.final) return;

        const input = tryParseJsonObject(pl.text);
        if (!input) {
          ctx.log('error', 'goal.validator: input deve ser JSON { goal, evidence[] }');
          return;
        }

        const { goal, evidence } = input;
        if (!goal || !goal.trim()) {
          ctx.log('error', 'goal.validator: goal vazio');
          return;
        }

        const evidenceText = evidence.length > 0
          ? evidence.map((e, i) => `EVIDENCE ${i + 1}:\n${e}`).join('\n\n---\n\n')
          : '(nenhuma evidência coletada)';

        const messages = [
          { role: 'system', content: system.trim() || `Você valida se um objetivo técnico foi atingido.
Recebe: goal (string) + evidence[] (outputs de ferramentas executadas).
Responda APENAS com JSON:
{
  "achieved": boolean,
  "confidence": 0-1,
  "gaps": string[],
  "nextActions": string[]
}
Seja rigoroso: achieved=true só se evidência PROVAR conclusão completa.` },
          { role: 'user', content: `GOAL: ${goal.trim()}\n\nEVIDENCE:\n${evidenceText}` },
        ];

        let result: GoalValidatorOutput;
        try {
          const res = await callChatCompletions(baseUrl, {
            model,
            messages,
            temperature: 0.1,
            max_tokens: 512,
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
          }, ctx.signal);

          const parsed = tryParseJsonObject(res.content);
          if (!parsed) {
            ctx.log('error', 'goal.validator: LLM não retornou JSON válido');
            result = { achieved: false, confidence: 0, gaps: ['Resposta inválida do validador'], nextActions: ['Tentar novamente'] };
          } else {
            result = parsed;
          }
        } catch (e) {
          ctx.log('error', `goal.validator falhou: ${(e as Error)?.message ?? String(e)}`);
          result = { achieved: false, confidence: 0, gaps: [`Erro: ${(e as Error)?.message ?? String(e)}`], nextActions: ['Tentar novamente'] };
        }

        ctx.metrics.counter('goal.validator.checks', 1);
        ctx.metrics.counter(result.achieved ? 'goal.validator.achieved' : 'goal.validator.not_achieved', 1);

        // Se confidence >= threshold e tem gate, pedir aprovação humana para confirmar conclusão
        if (result.achieved && result.confidence >= confidenceThreshold && gate) {
          const preview = JSON.stringify({ achieved: true, confidence: result.confidence, gaps: result.gaps, nextActions: result.nextActions });
          const gateMeta: GoalGateMeta = { goal, evidenceCount: evidence.length, trace: msg.meta?.trace as Record<string, unknown> };
          const decision = await new Promise<string | null>((resolve, reject) => {
            let settled = false;
            const cancelPending = (reason: string) => {
              if (settled) return;
              settled = true;
              gate.cancel?.(reason);
              resolve(null);
            };
            Promise.resolve(gate.request(preview, gateMeta)).then(
              (v) => { if (!settled) { settled = true; resolve(v); } },
              (err) => { if (!settled) { settled = true; reject(err); } },
            );
          });
          if (decision === null) {
            result = { achieved: false, confidence: 0, gaps: ['Humano rejeitou validação de conclusão'], nextActions: ['Continuar execução'] };
          }
        }

        await ctx.emit('out', JSON.stringify(result), {
          meta: {
            ...msg.meta,
            ...inheritTrace(msg, { tGoalValidatorMs: Date.now() }),
            goalValidator: result,
          },
        });
      },
      async stop() {},
      onControl(c: ControlMsg) {
        // gate cancel handled via promise
      },
    };
  },
};