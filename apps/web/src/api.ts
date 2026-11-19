// Schema do flow = o que o runner `falador-cli/run-flow.mjs` consome (fonte da verdade).
export interface FlowNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  enabled?: boolean;
  position?: { x: number; y: number }; // persiste a posição no canvas
}
export interface FlowEdge {
  from: string; // 'nodeId.out'
  to: string; // 'nodeId.in'
  capacity?: number;
  overflow?: 'block' | 'drop_oldest' | 'drop_newest';
}
export interface Flow {
  version: number;
  stopWhenSourcesDone?: boolean;
  description?: string; // descritivo humano — aparece no seletor de flows
  nodes: FlowNode[];
  edges: FlowEdge[];
  bindings?: Record<string, Record<string, unknown>>;
  /** Perfis de Run (ADR-003 W8): nome → nodeId → override de params, aplicado só na execução. */
  profiles?: FlowProfiles;
}
export type FlowProfiles = Record<string, Record<string, Record<string, unknown>>>;

// Métricas por nó (snapshot do motor — mesmos campos de falador-graph/types.ts).
export interface TimerStat { count: number; lastMs: number; avgMs: number; minMs: number; maxMs: number; }
export interface NodeMetrics {
  started: boolean;
  errored: boolean;
  in: number;
  out: number;
  dropped: number;
  expired: number;
  errors: number;
  procMsP50: number | null;
  procMsP95: number | null;
  counters: Record<string, number>;
  timers: Record<string, TimerStat>;
}
export interface RunSnapshot {
  runId: string;
  stopped: boolean;
  nodes: Record<string, NodeMetrics>;
  edges: Record<string, { depth: number; dropped: number; expired: number }>;
}

export interface CatalogEntry {
  type: string;
  sourceOnly: boolean;
  paramNames: string[];
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
}

export async function fetchCatalog(): Promise<CatalogEntry[]> {
  const r = await fetch('/api/catalog');
  const j = (await r.json()) as { nodes: CatalogEntry[] };
  return j.nodes;
}
export interface FlowInfo {
  name: string;
  description: string;
}
export async function fetchFlowList(): Promise<FlowInfo[]> {
  const r = await fetch('/api/flows');
  const j = (await r.json()) as { flows: FlowInfo[] };
  return j.flows;
}
export async function fetchFlow(name: string): Promise<Flow> {
  const r = await fetch(`/api/flows/${encodeURIComponent(name)}`);
  const j = (await r.json()) as { name: string; flow: Flow };
  return j.flow;
}
export async function saveFlow(name: string, flow: Flow, renameFrom?: string): Promise<void> {
  await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, flow, renameFrom }) });
}
export async function fetchModels(): Promise<{ omlx: string[]; cache: string[] }> {
  const r = await fetch('/api/models');
  return (await r.json()) as { omlx: string[]; cache: string[] };
}
// apps rodando (ScreenCaptureKit --list) — picker de captura por app
export async function fetchApps(): Promise<string[]> {
  const r = await fetch('/api/apps');
  const j = (await r.json()) as { apps: { name: string; bundleId: string }[] };
  return [...new Set(j.apps.map((a) => a.name).filter((n) => n && n.trim() && !n.startsWith('Open and Save Panel Service')))];
}
export function openRun(flow: Flow, onEvent: (ev: RunnerEvent) => void, onEnd: (code: number) => void, onOpen?: () => void): AbortController {
  const ctl = new AbortController();
  fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flow }), signal: ctl.signal })
    .then(async (r) => {
      onOpen?.();
      if (!r.body) throw new Error('sem stream');
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let ended = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const pkt = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const evLine = pkt.split('\n').find((l) => l.startsWith('event: '));
          const dataLine = pkt.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          const ev = evLine?.slice(7) ?? 'message';
          const data = JSON.parse(dataLine.slice(6));
          if (ev === 'runner') onEvent(data as RunnerEvent);
          else if (ev === 'ended') { ended = true; onEnd((data as { code: number }).code); }
        }
      }
      // stream fechou sem 'ended' (host morreu/409): não deixa o botão preso em "running"
      if (!ended) onEnd(-1);
    })
    .catch(() => onEnd(-1));
  return ctl;
}
export function stopRun(): Promise<void> {
  return fetch('/api/stop', { method: 'POST' }).then(() => undefined);
}
export function gateAction(nodeId: string, text: string | null): Promise<void> {
  return fetch('/api/gate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, text }),
  }).then(() => undefined);
}

export type RunnerEvent = { type: string; [k: string]: unknown };
