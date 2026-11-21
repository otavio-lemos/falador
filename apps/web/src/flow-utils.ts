// Conversão flow JSON (runner) ↔ React Flow + auto-layout em camadas sem cruzamentos.
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

export function portsFor(
  cn: CatalogNode | undefined,
  params: Record<string, unknown>,
): { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] } {
  const inputs = cn?.inputs ?? [];
  let outputs = cn?.outputs ?? [];
  // decision.llm: no motor real (decision-llm.ts), outputsFor gera portas do tipo 'tokens_parcial'
  if (cn?.type === 'decision.llm' && Array.isArray(params.options)) {
    outputs = (params.options as string[]).map((o) => ({ name: o, type: 'tokens_parcial' }));
  }
  return { inputs, outputs };
}

function splitPort(s: string): [string, string] {
  const i = s.lastIndexOf('.');
  return [s.slice(0, i), s.slice(i + 1)];
}

/**
 * Layout em camadas esquerda → direita com minimização de cruzamentos:
 * 1. Profundidade topológica (longest path) define a coluna X.
 * 2. Ordem vertical dentro de cada coluna usa a posição Y do(s) pai(s) + índice
 *    da porta de saída do pai (ex.: porta 0 'auto' fica em cima, porta 1 'humano' embaixo).
 * 3. Centraliza verticalmente cada coluna em relação ao centro do grafo.
 */
function autoLayout(
  flow: Flow,
  cnByType: Map<string, CatalogNode>,
): Map<string, { x: number; y: number }> {
  const { nodes, edges } = flow;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();
  const incoming = new Map<string, { from: string; fromPort: string }[]>();
  nodes.forEach((n) => incoming.set(n.id, []));
  edges.forEach((e) => {
    const [from, fromPort] = splitPort(e.from);
    const [to] = splitPort(e.to);
    incoming.get(to)?.push({ from, fromPort });
  });

  const calc = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const preds = incoming.get(id) ?? [];
    const d = preds.length ? Math.max(...preds.map((p) => calc(p.from, seen))) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  nodes.forEach((n) => calc(n.id, new Set()));

  const maxDepth = Math.max(0, ...Array.from(depth.values()));
  const byDepth = new Map<number, string[]>();
  for (let d = 0; d <= maxDepth; d++) byDepth.set(d, []);
  nodes.forEach((n) => {
    const d = depth.get(n.id) ?? 0;
    byDepth.get(d)!.push(n.id);
  });

  // ordem vertical (índice) já decidida para cada nó nas colunas anteriores
  const orderInCol = new Map<string, number>();

  const outPortIndex = (nodeId: string, portName: string): number => {
    const n = nodeById.get(nodeId);
    if (!n) return 0;
    const { outputs } = portsFor(cnByType.get(n.type), n.params);
    const idx = outputs.findIndex((o) => o.name === portName);
    return idx >= 0 ? idx : 0;
  };

  for (let d = 0; d <= maxDepth; d++) {
    const col = byDepth.get(d)!;
    if (d > 0) {
      // ordena pelo barycenter dos pais + peso da porta de saída do pai
      const score = (id: string): number => {
        const preds = incoming.get(id) ?? [];
        if (!preds.length) return 0;
        let sum = 0;
        for (const p of preds) {
          const parentRank = orderInCol.get(p.from) ?? 0;
          const pIdx = outPortIndex(p.from, p.fromPort);
          sum += parentRank * 10 + pIdx;
        }
        return sum / preds.length;
      };
      col.sort((a, b) => score(a) - score(b));
    }
    col.forEach((id, idx) => orderInCol.set(id, idx));
  }

  const COL_W = 310;
  const ROW_H = 180;
  const maxRows = Math.max(1, ...Array.from(byDepth.values()).map((c) => c.length));
  const totalH = (maxRows - 1) * ROW_H;

  const pos = new Map<string, { x: number; y: number }>();
  for (let d = 0; d <= maxDepth; d++) {
    const col = byDepth.get(d)!;
    const colH = (col.length - 1) * ROW_H;
    const startY = 60 + (totalH - colH) / 2;
    col.forEach((id, i) => {
      pos.set(id, { x: 60 + d * COL_W, y: Math.round(startY + i * ROW_H) });
    });
  }
  return pos;
}

export function flowToRf(flow: Flow, catalog: Catalog): { nodes: FNode[]; edges: Edge[] } {
  const cnByType = new Map(catalog.nodes.map((n) => [n.type, n]));
  const pos = autoLayout(flow, cnByType);
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
      data: { capacity: e.capacity, overflow: e.overflow, ...(e.ttlMs !== undefined ? { ttlMs: e.ttlMs } : {}) },
    };
  });
  return { nodes, edges };
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
      ...(typeof e.data?.ttlMs === 'number' ? { ttlMs: e.data.ttlMs } : {}),
    })),
  };
}

let idCounter = 0;
export function newNodeId(type: string): string {
  idCounter += 1;
  return `${type.split('.')[0]}${idCounter}`;
}
