// falador-nodes — telemetria leve ponta-a-ponta (ADR-006 Fase 5)
import type { Envelope } from '../../falador-graph/src/index.ts';

export interface TraceMeta {
  turnId: string;
  tCaptureMs?: number;
  tAsrFirstMs?: number;
  tAsrFinalMs?: number;
  tTurnMs?: number;
  tLlmTtftMs?: number;
  tLlmFinalMs?: number;
  tDecisionMs?: number;
  tExecStartMs?: number;
  tExecEndMs?: number;
  exitCode?: number;
}

let seqCounter = 0;

function nextTurnId(): string {
  seqCounter = (seqCounter + 1) & 0xffff;
  return `t-${Date.now().toString(36)}-${seqCounter.toString(36)}`;
}

/**
 * Preserva os carimbos de trace do envelope anterior e acrescenta os campos de `patch`.
 * Gera um `turnId` curto caso ainda não exista.
 */
export function inheritTrace(
  msg: Envelope | undefined,
  patch: Partial<TraceMeta>,
): { trace: TraceMeta } {
  const prevRaw = msg?.meta?.trace;
  const prev: Partial<TraceMeta> =
    prevRaw && typeof prevRaw === 'object' ? (prevRaw as Partial<TraceMeta>) : {};
  const turnId =
    typeof patch.turnId === 'string' && patch.turnId.length > 0
      ? patch.turnId
      : typeof prev.turnId === 'string' && prev.turnId.length > 0
        ? prev.turnId
        : nextTurnId();
  const merged: TraceMeta = { ...prev, turnId };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && k !== 'turnId') {
      (merged as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return { trace: merged };
}
