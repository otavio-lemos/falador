// falador-graph — tipos nucleares (Spec §2, §4)
// TS com type-stripping nativo (Node >= 26): apenas sintaxe erasável.

export type PortType =
  | 'pcm16k'
  | 'pcm48k'
  | 'audio_chunk'
  | 'tokens_parcial'
  | 'phrase'
  | 'control'
  | 'tool'
  | 'decider'
  | 'gate'
  | 'validator';

export interface DeciderResult {
  chosen: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export interface DeciderProvider {
  decide(
    text: string,
    opts?: {
      signal?: AbortSignal;
      options?: string[];
      criteria?: Record<string, string>;
      instructions?: string;
    },
  ): Promise<DeciderResult>;
}

export interface GateProvider {
  request(text: string, meta?: Record<string, unknown>): Promise<string | null>;
  cancel?(reason?: string): void;
}

export interface ValidatorProviderInput {
  goal: string;
  evidence: string[];
  plan?: Array<{
    id: string;
    description: string;
    verification: string;
    status: 'pending' | 'verified' | 'failed';
    evidence?: string;
  }>;
  signal: AbortSignal;
}

export interface ValidatorProviderResult {
  achieved: boolean;
  confidence: number;
  gaps: string[];
  nextActions: string[];
}

export interface ValidatorProvider {
  validate(input: ValidatorProviderInput): Promise<ValidatorProviderResult>;
  readonly confidenceThreshold?: number;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readonly?: boolean;
  sourceNodeId: string;
}

export interface ToolCallResult {
  ok: boolean;
  output: string;
  exitCode?: number;
  dryRun?: boolean;
  durationMs: number;
  meta?: Record<string, unknown>;
}

export interface ToolProvider {
  listTools(): Promise<ToolDef[]> | ToolDef[];
  invoke(
    name: string,
    args: Record<string, unknown>,
    opts: { signal: AbortSignal; runId: string; callerNodeId: string },
  ): Promise<ToolCallResult>;
}

export type OverflowPolicy = 'drop_oldest' | 'drop_newest' | 'block';
export type NodeErrorPolicy = 'isolate' | 'stop_run';
export type ControlScope = 'port' | 'node' | 'run';

export interface ControlMsg {
  kind: 'cancel' | 'interrupt';
  scope: ControlScope;
  /** Para scope 'port': seq máximo cancelado nessa porta. */
  uptoSeq?: number;
  /** Para scope 'node' | 'run': cancelamento por porta. */
  uptoSeqByPort?: Record<string, number>;
  /** Identificador de origem para evitar loops/duplicação na propagação. */
  sourceNode?: string;
  /** Turno/item sendo interrompido (opcional). */
  turnId?: string;
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
  /**
   * Portas de saída DINÂMICAS por instância (ex.: decision.llm emite uma porta por
   * opção). Resolvidas na validação e no emit com os params do nó; têm precedência
   * sobre `outputs` quando presentes.
   */
  outputsFor?: (params: Record<string, unknown>) => PortDecl[];
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
  /** Retorna provedores conectados à porta de entrada `'tool'` na ordem das arestas (ADR-008). */
  getTools?(port: string): ToolProvider[];
  /** Retorna provedor conectado a uma porta de capability (`decider` | `gate` | `validator`), ou null. */
  getProvider?<T = unknown>(port: string): T | null;
}

export interface NodeRuntime {
  start(): Promise<void>;
  onInput(port: string, msg: Envelope): Promise<void>;
  /** Chamado uma vez no stop do Run (ordem reversa topológica). Idempotente. */
  stop(reason: string): Promise<void>;
  /** Default do motor: registra cancelamentos. Sobrescreva para reagir. */
  onControl?(c: ControlMsg): void;
  /** Provedor de tools exposto por nós com porta de saída `'tool'` (ADR-008). */
  toolProvider?: ToolProvider;
  /** Provedor de decisão exposto por nós com porta de saída `'decider'`. */
  deciderProvider?: DeciderProvider;
  /** Provedor de gate humano exposto por nós com porta de saída `'gate'`. */
  gateProvider?: GateProvider;
  /** Provedor de validação de objetivo exposto por nós com porta de saída `'validator'`. */
  validatorProvider?: ValidatorProvider;
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
  | { type: 'interrupted'; by: string; reason?: string; affectedNodes: string[] }
  | { type: 'run_stopped'; runId: string; reason: string };

export interface TimerStat {
  count: number;
  lastMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}
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
  /** Contadores nomeados pelo nó (ctx.metrics.counter) — ex.: capture.ffmpeg.chunks. */
  counters: Record<string, number>;
  /** Timers nomeados pelo nó (ctx.metrics.timer) — ex.: llm.omlx.ttftMs. */
  timers: Record<string, TimerStat>;
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
