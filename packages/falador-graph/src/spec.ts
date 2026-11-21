// falador-graph — validação da spec de fluxo (Spec v1.1 §3, V0..V7)
import { GraphError, type NodeTypeDef, type PortDecl, type PortType } from './types.ts';

export interface EdgeSpec {
  from: string; // "<nodeId>.<portName>"
  to: string;   // "<nodeId>.<portName>"
  capacity?: number;
  overflow?: 'drop_oldest' | 'drop_newest' | 'block';
  ttlMs?: number;
  blockTimeoutMs?: number;
}

export interface NodeSpec {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  /** Nó desabilitado é removido do grafo com suas edges (TUI/canvas toggle). */
  enabled?: boolean;
}

export interface FlowSpec {
  version: number;
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  bindings?: Record<string, Record<string, unknown>>;
  /** Run termina sozinho quando fontes esgotaram e filas drenaram (útil em testes/batch). */
  stopWhenSourcesDone?: boolean;
}

export interface ValidatedEdge extends Required<Pick<EdgeSpec, 'from' | 'to' | 'overflow'>> {
  capacity: number;
  ttlMs?: number;
  blockTimeoutMs: number;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
  portType: PortType;
}

export interface ValidatedNode {
  id: string;
  def: NodeTypeDef;
  params: Record<string, unknown>;
  bindings: Record<string, unknown>;
}

export interface ValidatedFlow {
  nodes: Map<string, ValidatedNode>;
  /** ordem topológica (Kahn) dos ids. */
  topoOrder: string[];
  edges: ValidatedEdge[];
}

const ID_RE = /^[A-Za-z0-9_-]+$/;
const OVERFLOWS = ['drop_oldest', 'drop_newest', 'block'] as const;

function portOf(def: NodeTypeDef, name: string, dir: 'in' | 'out', params?: Record<string, unknown>): PortDecl | null {
  if (dir === 'out' && def.outputsFor) {
    const list = def.outputsFor(params ?? {});
    return list.find((p) => p.name === name) ?? null;
  }
  const list = dir === 'in' ? def.inputs : def.outputs;
  return list.find((p) => p.name === name) ?? null;
}

export function validateFlow(raw: FlowSpec, registry: Map<string, NodeTypeDef>): ValidatedFlow {
  if (raw.version !== 1) {
    throw new GraphError('SPEC_VERSION_UNSUPPORTED', 'version', `versão ${String(raw.version)} não suportada (só 1)`);
  }
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new GraphError('SPEC_MALFORMED', 'nodes/edges', 'nodes e edges devem ser arrays');
  }

  // V0: ids únicos + charset
  const nodes = new Map<string, ValidatedNode>();
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  // nós desabilitados saem do grafo junto com suas edges (Spec: enabled=false)
  const enabledNodes = raw.nodes.filter((n) => n.enabled !== false);
  const removedIds = new Set(raw.nodes.filter((n) => n.enabled === false).map((n) => n.id));
  const rawEdges = raw.edges.filter(
    (e) =>
      !removedIds.has(e.from.split('.')[0]) &&
      !removedIds.has(e.to.split('.')[0]),
  );
  for (const n of enabledNodes) {
    if (nodes.has(n.id)) throw new GraphError('DUPLICATE_NODE_ID', `nodes[${n.id}]`, `id duplicado`);
    if (typeof n.id !== 'string' || !ID_RE.test(n.id)) {
      throw new GraphError('INVALID_NODE_ID', `nodes[${String(n.id)}]`, 'id deve casar [A-Za-z0-9_-]+ (sem ".")');
    }
    const def = registry.get(n.type);
    if (!def) throw new GraphError('UNKNOWN_NODE_TYPE', `nodes[${n.id}].type`, `tipo "${n.type}" não registrado`);

    // V5: params estritos
    const params = n.params ?? {};
    for (const k of Object.keys(params)) {
      if (!def.paramNames || !def.paramNames.includes(k)) {
        throw new GraphError('UNKNOWN_PARAM', `nodes[${n.id}].params.${k}`, `param não declarado em ${n.type}.paramNames`);
      }
    }
    if (def.validateParams) {
      for (const err of def.validateParams(params)) {
        throw new GraphError(err.code, `nodes[${n.id}].${err.path}`, err.message);
      }
    }
    // V7: bindings
    const bindings = raw.bindings?.[n.id] ?? {};
    for (const k of Object.keys(bindings)) {
      if (!def.bindingNames || !def.bindingNames.includes(k)) {
        throw new GraphError('UNKNOWN_BINDING', `bindings.${n.id}.${k}`, `binding não declarado em ${n.type}.bindingNames`);
      }
    }
    if (def.requiredBindings) {
      for (const k of def.requiredBindings) {
        if (!(k in bindings)) {
          throw new GraphError('MISSING_BINDING', `bindings.${n.id}.${k}`, `binding obrigatório ausente`);
        }
      }
    }
    nodes.set(n.id, { id: n.id, def, params, bindings });
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }

  // edges
  const edges: ValidatedEdge[] = [];
  const outEdges = new Map<string, ValidatedEdge[]>();
  for (const e of rawEdges) {
    const path = `edges[${e.from}->${e.to}]`;
    const [fromNode, fromPort] = e.from.split('.');
    const [toNode, toPort] = e.to.split('.');
    if (!fromNode || !fromPort || !toNode || !toPort) {
      throw new GraphError('INVALID_EDGE_REF', path, 'referência deve ser "<nodeId>.<portName>"');
    }
    const src = nodes.get(fromNode);
    const dst = nodes.get(toNode);
    if (!src) throw new GraphError('UNKNOWN_NODE', path, `nó de origem "${fromNode}" não existe`);
    if (!dst) throw new GraphError('UNKNOWN_NODE', path, `nó de destino "${toNode}" não existe`);
    const sp = portOf(src.def, fromPort, 'out', src.params);
    if (!sp) throw new GraphError('UNKNOWN_PORT', path, `"${fromNode}" não tem porta de SAÍDA "${fromPort}"`);
    const dp = portOf(dst.def, toPort, 'in');
    if (!dp) throw new GraphError('UNKNOWN_PORT', path, `"${toNode}" não tem porta de ENTRADA "${toPort}"`);
    if (sp.type !== dp.type) {
      throw new GraphError('PORT_TYPE_MISMATCH', path, `${sp.type} → ${dp.type}`);
    }
    const cap = e.capacity ?? 64;
    if (!Number.isInteger(cap) || cap < 1 || cap > 4096) {
      throw new GraphError('INVALID_CAPACITY', path, `capacity ${String(cap)} fora de [1,4096] ou não-inteira`);
    }
    const ovf = e.overflow ?? 'drop_oldest';
    if (!OVERFLOWS.includes(ovf)) {
      throw new GraphError('INVALID_POLICY', path, `overflow "${String(ovf)}" inválido`);
    }
    const ttl = e.ttlMs;
    if (ttl !== undefined && (typeof ttl !== 'number' || ttl < 0)) {
      throw new GraphError('INVALID_TTL', path, 'ttlMs deve ser número >= 0');
    }
    const bt = e.blockTimeoutMs ?? 30_000;
    if (!Number.isFinite(bt) || bt <= 0) {
      throw new GraphError('INVALID_BLOCK_TIMEOUT', path, 'blockTimeoutMs deve ser > 0');
    }
    const ve: ValidatedEdge = {
      from: e.from, to: e.to, overflow: ovf, capacity: cap,
      ttlMs: ttl, blockTimeoutMs: bt,
      fromNode, fromPort, toNode, toPort, portType: sp.type,
    };
    edges.push(ve);
    if (!outEdges.has(fromNode)) outEdges.set(fromNode, []);
    outEdges.get(fromNode)!.push(ve);
  }

  // V2: in-degree <= 1 por (nó, porta), exceto portas do tipo 'tool' (ADR-008)
  const inEdges = new Map<string, ValidatedEdge[]>();
  for (const e of edges) {
    const key = `${e.toNode}.${e.toPort}`;
    if (!inEdges.has(key)) inEdges.set(key, []);
    inEdges.get(key)!.push(e);
    if (e.portType !== 'tool' && inEdges.get(key)!.length > 1) {
      throw new GraphError('IN_DEGREE_EXCEEDED', `edges→${key}`, 'porta de entrada recebe no máximo 1 edge (use merge.*)');
    }
  }

  // V6: fonte/sink + portas de saída mortas
  for (const n of nodes.values()) {
    const hasIn = edges.some((e) => e.toNode === n.id);
    const hasOut = edges.some((e) => e.fromNode === n.id);
    const hasToolOut = edges.some((e) => e.fromNode === n.id && e.portType === 'tool');
    const isToolOnlyNode = n.def.outputs.length > 0 && n.def.outputs.every((p) => p.type === 'tool');
    if (!hasIn && !n.def.sourceOnly && !n.def.sink && !hasToolOut && !isToolOnlyNode) {
      throw new GraphError('DISCONNECTED_NODE', `nodes[${n.id}]`, 'nó sem entrada: declare sourceOnly (ou é um sink?)');
    }
    for (const p of n.def.outputs) {
      const required = p.required !== false;
      const used = edges.some((e) => e.fromNode === n.id && e.fromPort === p.name);
      if (required && !used) {
        throw new GraphError('DEAD_OUTPUT_PORT', `nodes[${n.id}].${p.name}`, 'porta de saída required sem edge (marque required: false se for opcional)');
      }
    }
    if (n.def.sink && n.def.outputs.length > 0) {
      throw new GraphError('SINK_WITH_OUTPUTS', `nodes[${n.id}]`, 'nó sink não pode declarar saídas');
    }
    if (!hasOut && n.def.outputs.length > 0) {
      // coberto acima porta a porta; nada a fazer
    }
  }

  // V3: DAG via Kahn
  const topoOrder: string[] = [];
  const deg = new Map(inDeg);
  for (const e of edges) deg.set(e.toNode, (deg.get(e.toNode) ?? 0) + 1);
  const ready = [...nodes.keys()].filter((id) => (deg.get(id) ?? 0) === 0);
  while (ready.length > 0) {
    const id = ready.shift()!;
    topoOrder.push(id);
    for (const e of outEdges.get(id) ?? []) {
      const d = (deg.get(e.toNode) ?? 1) - 1;
      deg.set(e.toNode, d);
      if (d === 0) ready.push(e.toNode);
    }
  }
  if (topoOrder.length !== nodes.size) {
    const cyclic = [...nodes.keys()].filter((id) => !topoOrder.includes(id));
    throw new GraphError('CYCLE', 'edges', `ciclo envolvendo: ${cyclic.join(' -> ')}`);
  }

  return { nodes, topoOrder, edges };
}
