// falador-nodes — goal.validator: avaliador INDEPENDENTE de conclusão (ADR-012, evaluator-optimizer).
// O helper validateGoal() é usado pelo nó E pelo agent.tools na declaração de conclusão.
// Fail-closed: erro HTTP / JSON inválido ⇒ achieved:false, confidence:0.
// ENTRADA do nó: in (phrase) com { goal: string, evidence: string[] }
// SAÍDA do nó:   out (phrase) JSON { achieved, confidence, gaps[], nextActions[] }
import type { ControlMsg, NodeCtx, NodeRuntime, NodeTypeDef, ParamError } from '../../falador-graph/src/index.ts';
import { omlxAuthHeaders, payloadText } from './sse.ts';
import { inheritTrace } from './trace.ts';
import { redactSecrets } from './redact.ts';
import type { GoalValidationResult, PlanItem } from './audit.ts';

export type GoalValidation = GoalValidationResult;

export interface GoalGateMeta {
  goal: string;
  evidenceCount: number;
  trace?: Record<string, unknown>;
}

export interface GoalGateHolder {
  request(text: string, meta?: GoalGateMeta): Promise<string | null>;
  cancel?(reason?: string): void;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_MODEL = 'LiquidAI--LFM3-1.7B-MLX-4bit';
const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;
const DEFAULT_EVIDENCE_CHAR_BUDGET = 12000;

const VALIDATOR_SYSTEM = `Você valida se um objetivo técnico foi atingido.
Recebe: goal (string), evidence[] (outputs REAIS de ferramentas executadas) e, opcionalmente, um plano com itens e status.
Responda APENAS com JSON:
{
  "achieved": boolean,
  "confidence": 0-1,
  "gaps": string[],
  "nextActions": string[]
}
Seja rigoroso: achieved=true só se a evidência PROVAR conclusão completa de TODOS os itens do plano (se houver).
Evidência ausente, ambígua ou só parcial ⇒ achieved=false com gaps concretos.`;

function tryParseValidation(text: string): GoalValidation | null {
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
      const obj = parsed as Partial<GoalValidation>;
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

function failClosed(reason: string): GoalValidation {
  return { achieved: false, confidence: 0, gaps: [reason], nextActions: ['Coletar evidência real e tentar novamente'] };
}

/** Corta a evidência pelo budget mantendo a CAUDA (evidência mais recente é a mais relevante). */
function budgetEvidence(evidence: string[], budget: number): string {
  const joined = evidence.length > 0
    ? evidence.map((e, i) => `EVIDENCE ${i + 1}:\n${e}`).join('\n\n---\n\n')
    : '(nenhuma evidência coletada)';
  if (joined.length <= budget) return joined;
  return '[…evidência antiga cortada…]\n' + joined.slice(joined.length - budget);
}

export async function validateGoal(o: {
  baseUrl: string;
  model: string;
  goal: string;
  evidence: string[];
  plan?: PlanItem[];
  signal: AbortSignal;
  evidenceCharBudget?: number;
}): Promise<GoalValidation> {
  const budget = o.evidenceCharBudget ?? DEFAULT_EVIDENCE_CHAR_BUDGET;
  const safeEvidence = o.evidence.map((e) => redactSecrets(e).text);
  const evidenceText = budgetEvidence(safeEvidence, budget);
  const planText = o.plan && o.plan.length > 0
    ? `\n\nPLANO:\n${o.plan.map((p) => `- [${p.status}] ${p.id}: ${p.description} (verificação: ${p.verification})${p.evidence ? ` evidência: ${redactSecrets(p.evidence).text}` : ''}`).join('\n')}`
    : '';
  const messages = [
    { role: 'system', content: VALIDATOR_SYSTEM },
    { role: 'user', content: `GOAL: ${o.goal.trim()}\n\nEVIDENCE:\n${evidenceText}${planText}` },
  ];
  let content: string;
  try {
    const res = await fetch(`${o.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...omlxAuthHeaders() },
      body: JSON.stringify({
        model: o.model,
        messages,
        temperature: 0.1,
        max_tokens: 512,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: o.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return failClosed(`Validador indisponível: HTTP ${res.status} ${txt.slice(0, 120)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    content = data.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    return failClosed(`Erro no validador: ${(e as Error)?.message ?? String(e)}`);
  }
  return tryParseValidation(content) ?? failClosed('Validador não retornou JSON válido');
}

export const goalValidator: NodeTypeDef = {
  type: 'goal.validator',
  paramNames: ['baseUrl', 'model', 'confidenceThreshold'],
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
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const baseUrl = (ctx.params.baseUrl as string | undefined) ?? DEFAULT_BASE_URL;
    const model = (ctx.params.model as string | undefined) ?? DEFAULT_MODEL;
    const confidenceThreshold = (ctx.params.confidenceThreshold as number | undefined) ?? DEFAULT_CONFIDENCE_THRESHOLD;
    const gate = ctx.bindings.__gate as GoalGateHolder | undefined;

    return {
      async start() {},
      async onInput(_port, msg) {
        if (msg.control) return;
        const pl = payloadText(msg.payload);
        if (!pl || !pl.final) return;

        let input: { goal?: unknown; evidence?: unknown };
        try {
          input = JSON.parse(pl.text) as { goal?: unknown; evidence?: unknown };
        } catch {
          ctx.log('error', 'goal.validator: input deve ser JSON { goal, evidence[] }');
          return;
        }
        const goal = typeof input.goal === 'string' ? input.goal : '';
        const evidence = Array.isArray(input.evidence) ? input.evidence.map(String) : [];
        if (!goal.trim()) {
          ctx.log('error', 'goal.validator: goal vazio');
          return;
        }

        let result = await validateGoal({ baseUrl, model, goal, evidence, signal: ctx.signal });

        ctx.metrics.counter('goal.validator.checks', 1);
        ctx.metrics.counter(result.achieved ? 'goal.validator.achieved' : 'goal.validator.not_achieved', 1);

        // Conclusão com alta confiança ainda exige confirmação humana quando há gate.
        if (result.achieved && result.confidence >= confidenceThreshold && gate) {
          const preview = JSON.stringify(result);
          const gateMeta: GoalGateMeta = { goal, evidenceCount: evidence.length, trace: msg.meta?.trace as Record<string, unknown> };
          const decision = await new Promise<string | null>((resolve, reject) => {
            let settled = false;
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
      onControl(_c: ControlMsg) {},
    };
  },
};