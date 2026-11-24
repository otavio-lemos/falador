// Conversão flow JSON (runner) ↔ React Flow + auto-layout em camadas sem cruzamentos.
import type { Node, Edge } from '@xyflow/react';
import type { Catalog, CatalogNode, Flow, NodeMetrics } from './api';
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
  metrics?: NodeMetrics;
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

export function isRaia2Node(
  node: { id: string; type: string },
  hasAgentInFlow: boolean,
): boolean {
  if (
    node.type.startsWith('tool.') ||
    node.type === 'exec.command' ||
    node.type === 'rag.search' ||
    node.type === 'goal.validator'
  ) {
    return true;
  }
  if (
    node.id === 'decisor_d1' ||
    node.id === 'gate_humano' ||
    node.id === 'validador_objetivo'
  ) {
    return true;
  }
  // When an agent is present, deciders and gates connected to the agent belong to Raia 2
  if (hasAgentInFlow && (node.type === 'decision.llm' || node.type === 'human.approve')) {
    return true;
  }
  return false;
}

/**
 * Layout em 2 raias:
 * - Raia 1 (topo, esquerda → direita): fluxo principal de dados (Input → ASR → Agent → Output).
 * - Raia 2 (inferior, ancorada abaixo de agent.tools): provedores de capability (decider, gate, validator)
 *   e conectores tool (máx. 3–4 por linha, nunca empilhados na Coluna 0 com o Input).
 */
function autoLayout(
  flow: Flow,
  cnByType: Map<string, CatalogNode>,
): Map<string, { x: number; y: number }> {
  const { nodes, edges } = flow;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const pos = new Map<string, { x: number; y: number }>();

  const hasAgent = nodes.some((n) => n.type === 'agent.tools');
  const raia1Nodes = nodes.filter((n) => !isRaia2Node(n, hasAgent));
  const raia2Nodes = nodes.filter((n) => isRaia2Node(n, hasAgent));

  // If there are no nodes in Raia 2, lay out everything in Raia 1
  const r1List = raia2Nodes.length === 0 ? nodes : raia1Nodes;
  const r1Ids = new Set(r1List.map((n) => n.id));

  const incoming1 = new Map<string, { from: string; fromPort: string }[]>();
  r1List.forEach((n) => incoming1.set(n.id, []));
  edges.forEach((e) => {
    const [from, fromPort] = splitPort(e.from);
    const [to] = splitPort(e.to);
    if (r1Ids.has(from) && r1Ids.has(to)) {
      incoming1.get(to)?.push({ from, fromPort });
    }
  });

  const depth1 = new Map<string, number>();
  const calc1 = (id: string, seen: Set<string>): number => {
    if (depth1.has(id)) return depth1.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const preds = incoming1.get(id) ?? [];
    const d = preds.length ? Math.max(...preds.map((p) => calc1(p.from, seen))) + 1 : 0;
    depth1.set(id, d);
    return d;
  };
  r1List.forEach((n) => calc1(n.id, new Set()));

  const maxDepth1 = Math.max(0, ...Array.from(depth1.values()));
  const byDepth1 = new Map<number, string[]>();
  for (let d = 0; d <= maxDepth1; d++) byDepth1.set(d, []);
  r1List.forEach((n) => {
    const d = depth1.get(n.id) ?? 0;
    byDepth1.get(d)!.push(n.id);
  });

  const orderInCol1 = new Map<string, number>();
  const outPortIndex = (nodeId: string, portName: string): number => {
    const n = nodeById.get(nodeId);
    if (!n) return 0;
    const { outputs } = portsFor(cnByType.get(n.type), n.params);
    const idx = outputs.findIndex((o) => o.name === portName);
    return idx >= 0 ? idx : 0;
  };

  for (let d = 0; d <= maxDepth1; d++) {
    const col = byDepth1.get(d)!;
    if (d > 0) {
      const score = (id: string): number => {
        const preds = incoming1.get(id) ?? [];
        if (!preds.length) return 0;
        let sum = 0;
        for (const p of preds) {
          const parentRank = orderInCol1.get(p.from) ?? 0;
          const pIdx = outPortIndex(p.from, p.fromPort);
          sum += parentRank * 10 + pIdx;
        }
        return sum / preds.length;
      };
      col.sort((a, b) => score(a) - score(b));
    }
    col.forEach((id, idx) => orderInCol1.set(id, idx));
  }

  const COL_W = 310;
  const ROW_H = 180;
  const maxRows1 = Math.max(1, ...Array.from(byDepth1.values()).map((c) => c.length));
  const totalH1 = (maxRows1 - 1) * ROW_H;

  for (let d = 0; d <= maxDepth1; d++) {
    const col = byDepth1.get(d)!;
    const colH = (col.length - 1) * ROW_H;
    const startY = 60 + (totalH1 - colH) / 2;
    col.forEach((id, i) => {
      pos.set(id, { x: 60 + d * COL_W, y: Math.round(startY + i * ROW_H) });
    });
  }

  // Raia 2 (inferior, ancorada abaixo de agent.tools)
  if (raia2Nodes.length > 0) {
    const agentNode = r1List.find((n) => n.type === 'agent.tools') ?? r1List.find((n) => n.type.startsWith('llm.'));
    const agentDepth = agentNode ? (depth1.get(agentNode.id) ?? 2) : 2;
    // Ancorada abaixo do agente: coluna de início nunca pode ser 0 (nunca empilhada com Input)
    const startCol = Math.max(1, agentDepth - 1);
    const raia2StartY = 60 + totalH1 + ROW_H + 30;

    const isCapability = (n: typeof raia2Nodes[0]) =>
      n.type === 'goal.validator' ||
      n.type === 'decision.llm' ||
      n.type === 'human.approve' ||
      n.id === 'decisor_d1' ||
      n.id === 'gate_humano' ||
      n.id === 'validador_objetivo';

    // Ordena provedores de capability: decider -> gate -> validator
    const capRank = (n: typeof raia2Nodes[0]) => {
      if (n.id === 'decisor_d1' || n.type === 'decision.llm') return 0;
      if (n.id === 'gate_humano' || n.type === 'human.approve') return 1;
      if (n.id === 'validador_objetivo' || n.type === 'goal.validator') return 2;
      return 3;
    };
    const capNodes = raia2Nodes.filter(isCapability).sort((a, b) => capRank(a) - capRank(b));
    const toolNodes = raia2Nodes.filter((n) => !isCapability(n));

    let r2Row = 0;
    if (capNodes.length > 0) {
      capNodes.forEach((n, i) => {
        const colInRow = i % 3;
        const curRow = r2Row + Math.floor(i / 3);
        pos.set(n.id, {
          x: 60 + (startCol + colInRow) * COL_W,
          y: Math.round(raia2StartY + curRow * ROW_H),
        });
      });
      r2Row += Math.ceil(capNodes.length / 3);
    }

    if (toolNodes.length > 0) {
      toolNodes.forEach((n, i) => {
        const colInRow = i % 3;
        const curRow = r2Row + Math.floor(i / 3);
        pos.set(n.id, {
          x: 60 + (startCol + colInRow) * COL_W,
          y: Math.round(raia2StartY + curRow * ROW_H),
        });
      });
    }
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
