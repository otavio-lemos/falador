// Conversão flow JSON (runner) ↔ React Flow + auto-layout (flows não guardam posições).
import type { Node, Edge } from '@xyflow/react';
import type { Catalog, CatalogNode, Flow } from './api';
import { accentOf, NODE_META } from './data';

export interface FaladorNodeData {
  type: string;
  params: Record<string, unknown>;
  enabled: boolean;
  paramNames: string[];
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  accent: string;
  title: string;
  subtitle: string;
  metrics?: { p50?: number; ttft?: number; in: number; out: number };
  running?: boolean;
  [k: string]: unknown;
}
export type FNode = Node<FaladorNodeData, 'falador'>;

function portsFor(cn: CatalogNode | undefined, params: Record<string, unknown>): { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] } {
  const inputs = cn?.inputs ?? [];
  let outputs = cn?.outputs ?? [];
  // decision.llm: uma porta de saída por opção (outputsFor dinâmico do motor)
  if (cn?.type === 'decision.llm' && Array.isArray(params.options)) {
    outputs = (params.options as string[]).map((o) => ({ name: o, type: 'phrase' }));
  }
  return { inputs, outputs };
}

// layout em camadas esquerda→direita por profundidade topológica
function autoLayout(nodes: Flow['nodes'], edges: Flow['edges']): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  nodes.forEach((n) => incoming.set(n.id, []));
  edges.forEach((e) => {
    const to = e.to.split('.')[0];
    const from = e.from.split('.')[0];
    incoming.get(to)?.push(from);
  });
  const calc = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // ciclo (não deve haver)
    seen.add(id);
    const preds = incoming.get(id) ?? [];
    const d = preds.length ? Math.max(...preds.map((p) => calc(p, seen))) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => calc(n.id, new Set()));
  const byDepth = new Map<number, string[]>();
  nodes.forEach((n) => {
    const d = depth.get(n.id) ?? 0;
    byDepth.set(d, [...(byDepth.get(d) ?? []), n.id]);
  });
  const pos = new Map<string, { x: number; y: number }>();
  const COL = 245, ROW = 118;
  byDepth.forEach((ids, d) => {
    ids.forEach((id, i) => pos.set(id, { x: 60 + d * COL, y: 60 + i * ROW }));
  });
  return pos;
}

export function flowToRf(flow: Flow, catalog: Catalog): { nodes: FNode[]; edges: Edge[] } {
  const cnByType = new Map(catalog.nodes.map((n) => [n.type, n]));
  const pos = autoLayout(flow.nodes, flow.edges);
  const nodes: FNode[] = flow.nodes.map((n) => {
    const cn = cnByType.get(n.type);
    const { inputs, outputs } = portsFor(cn, n.params);
    const meta = NODE_META[n.type] ?? { title: n.type, subtitle: '' };
    return {
      id: n.id,
      type: 'falador',
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: {
        type: n.type, params: n.params, enabled: n.enabled !== false,
        paramNames: cn?.paramNames ?? [], inputs, outputs,
        accent: accentOf(n.type), title: meta.title, subtitle: meta.subtitle,
      },
    };
  });
  const edges: Edge[] = flow.edges.map((e, i) => {
    const [source, sourceHandle] = splitPort(e.from);
    const [target, targetHandle] = splitPort(e.to);
    return {
      id: `e${i}-${e.from}-${e.to}`,
      source, sourceHandle, target, targetHandle,
      data: { capacity: e.capacity, overflow: e.overflow },
    };
  });
  return { nodes, edges };
}

function splitPort(s: string): [string, string] {
  const i = s.lastIndexOf('.');
  return [s.slice(0, i), s.slice(i + 1)];
}

export function rfToFlow(nodes: FNode[], edges: Edge[], prev: Flow): Flow {
  return {
    version: prev.version ?? 1,
    stopWhenSourcesDone: prev.stopWhenSourcesDone ?? false,
    description: prev.description ?? '',
    nodes: nodes.map((n) => ({
      id: n.id, type: n.data.type, params: n.data.params,
      ...(n.data.enabled === false ? { enabled: false } : {}),
    })),
    edges: edges.map((e) => ({
      from: `${e.source}.${e.sourceHandle ?? 'out'}`,
      to: `${e.target}.${e.targetHandle ?? 'in'}`,
      capacity: (e.data?.capacity as number) ?? 16,
      overflow: (e.data?.overflow as string) ?? 'block',
    })),
  };
}

let idCounter = 0;
export function newNodeId(type: string): string {
  idCounter += 1;
  return `${type.split('.')[0]}${idCounter}`;
}