// falador-graph — tipos nucleares (Spec §2, §4)
// TS com type-stripping nativo (Node >= 26): apenas sintaxe erasável.

export type PortType =
  | 'pcm16k'
  | 'pcm48k'
  | 'audio_chunk'
  | 'tokens_parcial'
  | 'phrase'
  | 'control';

export type OverflowPolicy = 'drop_oldest' | 'drop_newest' | 'block';
export type NodeErrorPolicy = 'isolate' | 'stop_run';
export type ControlScope = 'port' | 'node' | 'run';

export interface ControlMsg {
  kind: 'cancel';
  scope: ControlScope;
  /** Para scope 'port': seq máximo cancelado nessa porta. */
  uptoSeq?: number;
  /** Para scope 'node' | 'run': cancelamento por porta. */
  uptoSeqByPort?: Record<string, number>;
  reason?: string;
}

export interface Envelope {
  /** Monotônico por porta de saída, começa em 1. */
  seq: number;
  /** Epoch ms do clock do Run. */
  ts: number;
  /** TTL em ms a partir de ts (opcional). */
  ttl?: number;
  meta?: Record<string, unknown>;
  payload: unknown;
  /** true quando cancelado por control e ainda entregue (Spec §5). */
  cancelled?: boolean;
  /** true quando payload é um ControlMsg. */
  control?: boolean;
}

export interface PortDecl {
  name: string;
  type: PortType;
  /** Marca a declaração da porta (uso futuro em UI). */
  required?: boolean;
}

export interface NodeTypeDef {
  type: string;
  inputs: PortDecl[];
  outputs: PortDecl[];
  /** Nó sem entradas conectáveis (fonte). */
  sourceOnly?: boolean;
  /** Nó sem saídas (coletor). */
  sink?: boolean;
  /** Nomes de params aceitos (estrito: param fora da lista = erro de montagem). */
  paramNames?: string[];
  /** Nomes de bindings aceitos para este tipo. */
  bindingNames?: string[];
  /** Bindings obrigatórios do tipo (validados se seção bindings presente — Spec A4). */
  requiredBindings?: string[];
  /** Política de erro default (Spec §4). */
  onError?: NodeErrorPolicy;
  /** Valida params: retorna lista de erros {path, code, message}. */
  validateParams?: (params: Record<string, unknown>) => ParamError[];
  create: (ctx: NodeCtx) => NodeRuntime;
}

export interface ParamError {
  path: string;
  code: string;
  message: string;
}

export interface NodeCtx {
  /** id da instância no grafo. */
  readonly id: string;
  /** Params da instância (validados, Spec V5). */
  readonly params: Record<string, unknown>;
  /** Bindings de run para este nó (Spec W8/W9). */
  readonly bindings: Record<string, unknown>;
  /** Emite em porta de SAÍDA. seq gerado por porta. block pode pausar o chamador. */
  emit(port: string, payload: unknown, opts?: { ttl?: number; meta?: Record<string, unknown> }): Promise<void>;
  /** Envia control sincronamente (não espera espaço). */
  emitControl(port: string, c: ControlMsg): void;
  /** seq <= n foi cancelada para a porta dada? */
  isCancelled(port: string, seq: number): boolean;
  metrics: MetricsSink;
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void;
  /** Abortado no stop() do Run. */
  readonly signal: AbortSignal;
}

export interface NodeRuntime {
  start(): Promise<void>;
  onInput(port: string, msg: Envelope): Promise<void>;
  /** Chamado uma vez no stop do Run (ordem reversa topológica). Idempotente. */
  stop(reason: string): Promise<void>;
  /** Default do motor: registra cancelamentos. Sobrescreva para reagir. */
  onControl?(c: ControlMsg): void;
}

export interface MetricsSink {
  counter(name: string, delta?: number): void;
  timer(name: string, ms: number): void;
}

export type Clock = { now(): number };

// ---- Eventos de Run -------------------------------------------------------

export type RunEvent =
  | { type: 'run_started'; runId: string }
  | { type: 'node_started'; nodeId: string }
  | { type: 'node_stopped'; nodeId: string; reason: string }
  | { type: 'node_error'; nodeId: string; code: string; message: string }
  | { type: 'edge_overflow'; edge: string; dropped: number; policy: OverflowPolicy }
  | { type: 'edge_expired'; edge: string; count: number }
  | { type: 'edge_closed'; edge: string; reason: string }
  | { type: 'cancelled'; scope: ControlScope; by?: string }
  | { type: 'run_stopped'; runId: string; reason: string };

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
}

export interface EdgeMetrics {
  depth: number;
  dropped: number;
  expired: number;
}

export interface Snapshot {
  runId: string;
  stopped: boolean;
  nodes: Record<string, NodeMetrics>;
  edges: Record<string, EdgeMetrics>;
}

export class GraphError extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string, message: string) {
    super(`${code} @ ${path}: ${message}`);
    this.name = 'GraphError';
    this.code = code;
    this.path = path;
  }
}
