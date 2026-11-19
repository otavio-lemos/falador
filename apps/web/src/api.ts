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
  nodes: FlowNode[];
  edges: FlowEdge[];
  bindings?: Record<string, Record<string, unknown>>;
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
export async function fetchFlowList(): Promise<string[]> {
  const r = await fetch('/api/flows');
  const j = (await r.json()) as { flows: string[] };
  return j.flows;
}
export async function fetchFlow(name: string): Promise<Flow> {
  const r = await fetch(`/api/flows/${encodeURIComponent(name)}`);
  const j = (await r.json()) as { name: string; flow: Flow };
  return j.flow;
}
export async function saveFlow(name: string, flow: Flow): Promise<void> {
  await fetch('/api/flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, flow }) });
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
          else if (ev === 'ended') onEnd((data as { code: number }).code);
        }
      }
    })
    .catch(() => onEnd(-1));
  return ctl;
}
export function stopRun(): Promise<void> {
  return fetch('/api/stop', { method: 'POST' }).then(() => undefined);
}

export type RunnerEvent = { type: string; [k: string]: unknown };
