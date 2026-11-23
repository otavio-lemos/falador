// falador-nodes — audit.ts: contrato da trilha de auditoria única por run (ADR-012).
// Tipos + helpers puros. O runner grava JSONL append-only; o host repassa via SSE.
// NADA fabricado: todo campo vem do que realmente aconteceu no loop do agente.

export interface PlanItem {
  id: string;
  description: string;
  /** Como PROVAR que o item foi concluído (comando/checagem concreta). */
  verification: string;
  status: 'pending' | 'verified' | 'failed';
  evidence?: string;
}

export interface GoalValidationResult {
  achieved: boolean;
  confidence: number;
  gaps: string[];
  nextActions: string[];
}

export interface AuditEvent {
  ts: number;
  op: 'plan' | 'tool_call' | 'gate' | 'goal_validation' | 'agent_final';
  nodeId: string;
  step?: number;
  tool?: string;
  args?: Record<string, unknown>;
  risk?: 'seguro' | 'sensivel';
  gate?: 'approved' | 'rejected' | 'edited' | 'not_required' | 'missing_gate' | 'pending';
  ok?: boolean;
  exitCode?: number | null;
  durationMs?: number;
  dryRun?: boolean;
  host?: string;
  transport?: string;
  outputPreview?: string;
  errorType?: string;
  rag?: { query: string; hits: number; chunkIds?: string[] };
  plan?: PlanItem[];
  validation?: GoalValidationResult;
  goal?: string;
  text?: string;
  goalAchieved?: boolean;
  maxStepsReached?: boolean;
}

const PLAN_STATUSES = new Set(['pending', 'verified', 'failed']);

/** Valida o payload de update_plan vindo do LLM (fronteira de confiança). */
export function parsePlanItems(raw: unknown): { ok: true; items: PlanItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: 'items deve ser um array de itens do plano' };
  if (raw.length === 0) return { ok: false, error: 'items não pode ser vazio' };
  const seen = new Set<string>();
  const items: PlanItem[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: `items[${i}] deve ser objeto` };
    }
    const it = entry as Record<string, unknown>;
    const id = typeof it.id === 'string' ? it.id.trim() : '';
    const description = typeof it.description === 'string' ? it.description.trim() : '';
    const verification = typeof it.verification === 'string' ? it.verification.trim() : '';
    const status = typeof it.status === 'string' ? it.status : '';
    if (!id) return { ok: false, error: `items[${i}].id obrigatório (string não-vazia)` };
    if (seen.has(id)) return { ok: false, error: `id duplicado no plano: ${id}` };
    if (!description) return { ok: false, error: `items[${i}].description obrigatório` };
    if (!verification) return { ok: false, error: `items[${i}].verification obrigatório (como provar a conclusão)` };
    if (!PLAN_STATUSES.has(status)) {
      return { ok: false, error: `items[${i}].status inválido: ${String(it.status)} (use pending|verified|failed)` };
    }
    if (it.evidence !== undefined && typeof it.evidence !== 'string') {
      return { ok: false, error: `items[${i}].evidence deve ser string` };
    }
    seen.add(id);
    items.push({
      id,
      description,
      verification,
      status: status as PlanItem['status'],
      ...(typeof it.evidence === 'string' ? { evidence: it.evidence } : {}),
    });
  }
  return { ok: true, items };
}

const DEFAULT_PREVIEW_MAX = 2000;

/** Preview de output para auditoria: corta no INÍCIO mantendo a cauda (o fim costuma ter o resultado/erro). */
export function preview(output: string, max: number = DEFAULT_PREVIEW_MAX): string {
  if (output.length <= max) return output;
  const marker = '[…cortado…]\n';
  const keep = Math.max(0, max - marker.length);
  return marker + output.slice(output.length - keep);
}