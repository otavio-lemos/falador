// Camada de API — fala com o host zero-dep (apps/web-server.mjs :8787).
// Catálogo, flows (save/load), run via SSE, gate humano, modelos, apps.

export interface CatalogPort { name: string; type: string }
export interface CatalogNode {
  type: string;
  paramNames: string[];
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  outputsFor?: unknown;
}
export interface Catalog { nodes: CatalogNode[] }

export interface FlowNode { id: string; type: string; params: Record<string, unknown>; enabled?: boolean }
export interface FlowEdge { from: string; to: string; capacity?: number; overflow?: string }
export interface Flow {
  version?: number;
  stopWhenSourcesDone?: boolean;
  description?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface TimerStat { count: number; lastMs: number; avgMs: number; minMs: number; maxMs: number }
export interface NodeMetrics {
  in: number; out: number; errors: number; dropped: number; expired: number;
  procMsP50?: number; procMsP95?: number;
  counters: Record<string, number>;
  timers: Record<string, TimerStat>;
}
export type RunSnapshot = Record<string, NodeMetrics>;
export type RunnerEvent = { type: string; [k: string]: unknown };

export async function fetchCatalog(): Promise<Catalog> {
  return (await fetch('/api/catalog')).json();
}
export async function fetchFlows(): Promise<{ name: string; description: string }[]> {
  return (await fetch('/api/flows')).json().then((j) => j.flows);
}
export async function fetchFlow(name: string): Promise<Flow> {
  return (await fetch('/api/flows/' + encodeURIComponent(name))).json().then((j) => j.flow);
}
export async function saveFlow(name: string, flow: Flow, renameFrom?: string): Promise<void> {
  const r = await fetch('/api/flows', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, flow, renameFrom }),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? 'falha ao salvar');
}
export async function fetchModels(): Promise<{ omlx: string[]; cache: string[] }> {
  return (await fetch('/api/models')).json();
}
export async function fetchApps(): Promise<string[]> {
  const j = await (await fetch('/api/apps')).json();
  return [...new Set((j.apps as { name: string }[]).map((a) => a.name).filter((n) => n && n.trim() && !n.startsWith('Open and Save Panel Service')))];
}
export async function stopRun(): Promise<void> {
  await fetch('/api/stop', { method: 'POST' });
}
export async function gateAction(nodeId: string, text: string | null): Promise<void> {
  await fetch('/api/gate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, text }),
  });
}

// POST /api/run → SSE. Cada frame: "event: <nome>\ndata: <json>".
// nome 'runner' = evento do motor; 'ended' = fim (code); 'attached' = conectou.
export function openRun(
  flow: Flow,
  onEvent: (ev: RunnerEvent) => void,
  onEnd: (code: number) => void,
  onOpen?: () => void,
): AbortController {
  const ctl = new AbortController();
  fetch('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow }), signal: ctl.signal,
  }).then(async (r) => {
    if (!r.ok || !r.body) { onEnd(-1); return; }
    onOpen?.();
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let evName = 'message'; let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) evName = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed: unknown; try { parsed = JSON.parse(data); } catch { continue; }
        if (evName === 'runner') onEvent(parsed as RunnerEvent);
        else if (evName === 'ended') { onEnd((parsed as { code: number }).code ?? 0); return; }
      }
    }
    onEnd(-1); // stream fechou sem 'ended'
  }).catch(() => onEnd(-1));
  return ctl;
}