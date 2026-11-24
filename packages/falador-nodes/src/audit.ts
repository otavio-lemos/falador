// falador-nodes — audit.ts: contrato da trilha de auditoria única por run (ADR-012).
// Tipos + helpers puros + encadeamento tamper-evident SHA-256.
// O runner grava JSONL append-only; o host repassa via SSE.
// NADA fabricado: todo campo vem do que realmente aconteceu no loop do agente.
import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);

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
  op:
    | 'plan'
    | 'tool_call'
    | 'gate'
    | 'goal_validation'
    | 'agent_final'
    | 'exec'
    | 'chat_input'
    | 'run_started'
    | 'run_stopped';
  nodeId: string;
  runId?: string;
  seq?: number;
  step?: number;
  tool?: string;
  args?: Record<string, unknown>;
  risk?: 'seguro' | 'sensivel';
  confidence?: number;
  probabilities?: Record<string, number>;
  gate?: 'approved' | 'rejected' | 'edited' | 'not_required' | 'missing_gate' | 'pending';
  ok?: boolean;
  exitCode?: number | null;
  durationMs?: number;
  dryRun?: boolean;
  host?: string;
  transport?: string;
  command?: string;
  outputPreview?: string;
  errorType?: string;
  reason?: string;
  rag?: { query: string; hits: number; chunkIds?: string[] };
  plan?: PlanItem[];
  validation?: GoalValidationResult;
  goal?: string;
  text?: string;
  goalAchieved?: boolean;
  maxStepsReached?: boolean;
  prevHash?: string;
  hash?: string;
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

/** Serialização JSON canônica (chaves ordenadas recursivamente, omitindo undefined). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',') + '}';
}

/** Calcula hash SHA-256 encadeado: sha256(prevHash + canonicalJson(evento sem hash/prevHash)). */
export function computeAuditHash(prevHash: string, event: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (k === 'hash' || k === 'prevHash' || v === undefined) continue;
    clean[k] = v;
  }
  return createHash('sha256').update(prevHash + canonicalJson(clean)).digest('hex');
}

/** Adiciona prevHash e hash SHA-256 ao evento de auditoria. */
export function chainAuditEvent<T extends Record<string, unknown>>(
  event: T,
  prevHash: string = GENESIS_HASH,
): T & { prevHash: string; hash: string } {
  const hash = computeAuditHash(prevHash, event);
  return { ...event, prevHash, hash };
}

export type AuditChainVerification =
  | { ok: true; checked: number }
  | { ok: false; index: number; reason: string };

/** Verifica a integridade da hash chain SHA-256 de uma lista ordenada de eventos de auditoria. */
export function verifyAuditChain(events: Array<Record<string, unknown>>): AuditChainVerification {
  let expectedPrevHash = GENESIS_HASH;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') {
      return { ok: false, index: i, reason: 'evento malformado' };
    }
    if (typeof ev.prevHash !== 'string' || typeof ev.hash !== 'string') {
      return { ok: false, index: i, reason: 'evento sem prevHash ou hash' };
    }
    if (ev.prevHash !== expectedPrevHash) {
      return {
        ok: false,
        index: i,
        reason: `prevHash divergente (esperado ${expectedPrevHash.slice(0, 12)}…, recebido ${ev.prevHash.slice(0, 12)}…)`,
      };
    }
    const expectedHash = computeAuditHash(ev.prevHash, ev);
    if (ev.hash !== expectedHash) {
      return {
        ok: false,
        index: i,
        reason: `hash inválido (conteúdo adulterado; esperado ${expectedHash.slice(0, 12)}…, recebido ${ev.hash.slice(0, 12)}…)`,
      };
    }
    expectedPrevHash = ev.hash;
  }
  return { ok: true, checked: events.length };
}
