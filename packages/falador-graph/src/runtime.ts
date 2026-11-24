// falador-graph — runtime do motor (Spec v1.1 §4, §5)
import { BoundedEdge, EdgeClosedError } from './queue.ts';
import { registryToMap, type Registry } from './registry.ts';
import { validateFlow, type FlowSpec, type ValidatedEdge, type ValidatedNode } from './spec.ts';
import {
  GraphError,
  type Clock,
  type ControlMsg,
  type DeciderProvider,
  type Envelope,
  type GateProvider,
  type NodeCtx,
  type NodeMetrics,
  type NodeRuntime,
  type RunEvent,
  type Snapshot,
  type ToolProvider,
  type ValidatorProvider,
} from './types.ts';

const realClock: Clock = { now: () => Date.now() };

export interface RunOpts {
  runId?: string;
  clock?: Clock;
  /** janela p/ amostras de procMs (default 256). */
  procWindow?: number;
  drainTimeoutMs?: number;
  /** run termina sozinho quando fontes esgotam e filas drenam (também declarável no fluxo). */
  stopWhenSourcesDone?: boolean;
}

interface NodeState {
  id: string;
  ctx: NodeCtx;
  runtime: NodeRuntime;
  metrics: NodeMetricsInternal;
  errored: boolean;
  started: boolean;
  startPromise: Promise<void> | null;
  stopCalled: boolean;
}

interface NodeMetricsInternal {
  in: number;
  out: number;
  errors: number;
  proc: number[];
  counters: Record<string, number>;
  timers: Record<string, { count: number; sum: number; last: number; min: number; max: number }>;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export class RunningGraph {
  private eventsQ: RunEvent[] = [];
  private eventWaiters: (() => void)[] = [];
  private eventDone = false;
  private readonly listeners: ((e: RunEvent) => void)[] = [];

  private nodeStates = new Map<string, NodeState>();
  private edges = new Map<string, { e: ValidatedEdge; q: BoundedEdge }>();
  private cancelledSeqs = new Map<string, Map<string, Set<number>>>(); // nodeId -> port -> seqs
  private seqByPort = new Map<string, number>(); // "<node>.<port>" -> último seq emitido
  private stopped = false;
  /** running → draining (durante doStop) → done (emit vira RUN_STOPPED). */
  private phase: 'running' | 'draining' | 'done' = 'running';
  private stopPromise: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private readonly procWindow: number;
  private onNaturalDone: (() => void) | null = null;

  readonly runId: string;
  readonly clock: Clock;
  private readonly flow: { nodes: Map<string, ValidatedNode>; topoOrder: string[]; edges: ValidatedEdge[] };
  private readonly opts: RunOpts;

  constructor(
    flow: { nodes: Map<string, ValidatedNode>; topoOrder: string[]; edges: ValidatedEdge[] },
    opts: RunOpts,
  ) {
    this.flow = flow;
    this.opts = opts;
    this.runId = opts.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.clock = opts.clock ?? realClock;
    this.procWindow = opts.procWindow ?? 256;
    for (const id of flow.topoOrder) {
      this.cancelledSeqs.set(id, new Map());
    }
  }

  // ---- eventos ------------------------------------------------------------

  on(cb: (e: RunEvent) => void): void {
    this.listeners.push(cb);
  }

  private emitEvent(e: RunEvent): void {
    this.eventsQ.push(e);
    for (const cb of this.listeners) {
      try { cb(e); } catch { /* listener do host não derruba o run */ }
    }
    for (const w of this.eventWaiters.splice(0)) w();
  }

  private waitForEvents(): Promise<void> {
    return new Promise((res) => this.eventWaiters.push(res));
  }

  /** Iterador de eventos; termina após run_stopped (que já está na fila antes de stop() resolver). */
  async *events(): AsyncGenerator<RunEvent> {
    let i = 0;
    while (true) {
      while (i < this.eventsQ.length) yield this.eventsQ[i++];
      if (this.eventDone) return;
      await this.waitForEvents();
    }
  }

  /** Log completo de eventos até agora (replay direto, p/ asserts e pós-mortem). */
  eventsSnapshot(): RunEvent[] {
    return [...this.eventsQ];
  }

  // ---- NodeCtx ------------------------------------------------------------

  private buildCtx(vn: ValidatedNode, state: NodeState): NodeCtx {
    const self = this;
    return {
      id: vn.id,
      params: vn.params,
      bindings: vn.bindings,
      signal: self.abort.signal,
      metrics: {
        // 'in/out' são contados pelo motor; aqui vão os contadores/timers NOMEADOS dos nós
        // (llm.omlx.ttftMs, tts.sts.ms, decision.llm.<opção>…) — agregados no snapshot().
        counter: (name, delta = 1) => {
          state.metrics.counters[name] = (state.metrics.counters[name] ?? 0) + delta;
        },
        timer: (name, ms) => {
          const t = (state.metrics.timers[name] ??= { count: 0, sum: 0, last: 0, min: Infinity, max: -Infinity });
          t.count++;
          t.sum += ms;
          t.last = ms;
          if (ms < t.min) t.min = ms;
          if (ms > t.max) t.max = ms;
        },
      },
      log: (level, msg) => {
        self.emitEvent({ type: 'node_error', nodeId: vn.id, code: `log_${level}`, message: msg });
      },
      isCancelled(port, seq): boolean {
        return self.cancelledSeqs.get(vn.id)?.get(port)?.has(seq) ?? false;
      },
      getTools(port: string): ToolProvider[] {
        const dp = vn.def.inputs.find((p) => p.name === port);
        if (!dp || dp.type !== 'tool') return [];
        const providers: ToolProvider[] = [];
        for (const e of self.flow.edges) {
          if (e.toNode !== vn.id || e.toPort !== port || e.portType !== 'tool') continue;
          const srcState = self.nodeStates.get(e.fromNode);
          if (srcState?.runtime?.toolProvider) {
            providers.push(srcState.runtime.toolProvider);
          }
        }
        return providers;
      },
      getProvider<T = unknown>(port: string): T | null {
        const dp = vn.def.inputs.find((p) => p.name === port);
        if (!dp || (dp.type !== 'decider' && dp.type !== 'gate' && dp.type !== 'validator')) {
          return null;
        }
        const edge = self.flow.edges.find(
          (e) => e.toNode === vn.id && e.toPort === port && e.portType === dp.type,
        );
        if (!edge) return null;
        const srcState = self.nodeStates.get(edge.fromNode);
        if (!srcState?.runtime) return null;

        const recordProviderCall = async <R>(kind: string, fn: () => Promise<R>): Promise<R> => {
          srcState.metrics.in++;
          const t0 = self.clock.now();
          try {
            const res = await fn();
            srcState.metrics.out++;
            return res;
          } catch (err) {
            srcState.metrics.errors++;
            throw err;
          } finally {
            const dt = self.clock.now() - t0;
            const arr = srcState.metrics.proc;
            arr.push(dt);
            if (arr.length > self.procWindow) arr.shift();
            srcState.ctx.metrics.timer(`provider.${kind}.ms`, dt);
          }
        };

        if (dp.type === 'decider') {
          const raw = srcState.runtime.deciderProvider;
          if (!raw) return null;
          const wrapped: DeciderProvider = {
            decide: (text, opts) => recordProviderCall('decider', () => raw.decide(text, opts)),
          };
          return wrapped as T;
        }

        if (dp.type === 'gate') {
          const raw = srcState.runtime.gateProvider;
          if (!raw) return null;
          const wrapped: GateProvider = {
            request: (text, meta) => recordProviderCall('gate', () => raw.request(text, meta)),
            ...(raw.cancel ? { cancel: (reason?: string) => raw.cancel?.(reason) } : {}),
          };
          return wrapped as T;
        }

        if (dp.type === 'validator') {
          const raw = srcState.runtime.validatorProvider;
          if (!raw) return null;
          const wrapped: ValidatorProvider = {
            ...(raw.confidenceThreshold !== undefined ? { confidenceThreshold: raw.confidenceThreshold } : {}),
            validate: (input) => recordProviderCall('validator', () => raw.validate(input)),
          };
          return wrapped as T;
        }

        return null;
      },
      async emit(port, payload, emitOpts) {
        const vnode = self.flow.nodes.get(vn.id)!;
        const dyn = vnode.def.outputsFor?.(vnode.params) ?? [];
        if (!vnode.def.outputs.some((p) => p.name === port) && !dyn.some((p) => p.name === port)) {
          throw new GraphError('UNKNOWN_PORT', `${vn.id}.emit(${port})`, `porta de saída "${port}" não declarada`);
        }
        if (self.phase === 'done') throw new GraphError('RUN_STOPPED', `${vn.id}.emit(${port})`, 'run já parado');
        // phase 'draining': emit é permitido (nó em processamento termina de reemitir);
        // edges já fechadas são engolidas no catch abaixo (Spec v1.1 §4/§5)
        const key = `${vn.id}.${port}`;
        const seq = (self.seqByPort.get(key) ?? 0) + 1;
        self.seqByPort.set(key, seq);
        const env: Envelope = {
          seq,
          ts: self.clock.now(),
          ttl: emitOpts?.ttl,
          meta: emitOpts?.meta,
          payload,
        };
        state.metrics.out++;
        const outgoing = [...self.edges.values()].filter(
          (x) => x.e.fromNode === vn.id && x.e.fromPort === port,
        );
        await Promise.all(
          outgoing.map(async ({ q }) => {
            try {
              await q.push(env);
            } catch (err) {
              if (err instanceof EdgeClosedError) return; // destino isolado/fechado: mensagem some silenciosamente
              throw err;
            }
          }),
        );
        return { seq };
      },
      emitControl(port, c) {
        const msg: ControlMsg = { ...c, sourceNode: vn.id };
        if (c.kind === 'interrupt') {
          const visited = new Set<string>();
          const queue: string[] = [];
          const affectedNodes: string[] = [];

          const isTextPort = (pt: ValidatedEdge['portType']): boolean =>
            pt === 'tokens_parcial' || pt === 'phrase';

          for (const { e, q } of self.edges.values()) {
            if (e.fromNode !== vn.id || e.fromPort !== port) continue;
            if (isTextPort(e.portType)) {
              while (q.takeNow() !== null) {
                /* descarta pendentes de texto na fila intermediária */
              }
            }
            if (!visited.has(e.toNode)) {
              visited.add(e.toNode);
              queue.push(e.toNode);
            }
          }

          while (queue.length > 0) {
            const nodeId = queue.shift()!;
            affectedNodes.push(nodeId);
            const target = self.nodeStates.get(nodeId);
            if (target) {
              self.invokeOnControl(target, msg);
            }
            for (const { e, q } of self.edges.values()) {
              if (e.fromNode !== nodeId) continue;
              if (isTextPort(e.portType)) {
                while (q.takeNow() !== null) {
                  /* descarta pendentes de texto na fila intermediária */
                }
              }
              if (!visited.has(e.toNode)) {
                visited.add(e.toNode);
                queue.push(e.toNode);
              }
            }
          }

          self.emitEvent({
            type: 'interrupted',
            by: vn.id,
            reason: c.reason,
            affectedNodes,
          });
          return;
        }

        // c.kind === 'cancel':
        // cancela imediatamente o que está nas filas desta porta + registra para isCancelled do PRÓPRIO nó
        const own = self.cancelledSeqs.get(vn.id)!;
        const set = own.get(port) ?? new Set<number>();
        const addUpto = (upto: number) => {
          for (let s = 1; s <= upto; s++) set.add(s);
        };
        if (c.uptoSeq !== undefined) addUpto(c.uptoSeq);
        if (c.uptoSeqByPort?.[port] !== undefined) addUpto(c.uptoSeqByPort[port]);
        own.set(port, set);
        const notified = new Set<string>();
        for (const { e, q } of self.edges.values()) {
          if (e.fromNode === vn.id && e.fromPort === port) {
            q.markCancelled({ kind: 'cancel', uptoSeq: c.uptoSeq, uptoSeqByPort: c.uptoSeqByPort });
            if (!notified.has(e.toNode)) {
              notified.add(e.toNode);
              const target = self.nodeStates.get(e.toNode);
              if (target) self.invokeOnControl(target, msg);
            }
          }
        }
        self.emitEvent({ type: 'cancelled', scope: c.scope, by: vn.id });
      },
    };
  }

  // ---- ciclo ---------------------------------------------------------------

  async start(): Promise<void> {
    this.emitEvent({ type: 'run_started', runId: this.runId });
    // cria estados + ctx + runtime (ordem topológica)
    for (const id of this.flow.topoOrder) {
      const vn = this.flow.nodes.get(id)!;
      const st: NodeState = {
        id,
        runtime: null as unknown as NodeRuntime,
        ctx: null as unknown as NodeCtx,
        metrics: { in: 0, out: 0, errors: 0, proc: [], counters: {}, timers: {} },
        errored: false,
        started: false,
        startPromise: null,
        stopCalled: false,
      };
      st.ctx = this.buildCtx(vn, st);
      st.runtime = vn.def.create(st.ctx);
      this.nodeStates.set(id, st);
    }
    // edges
    for (const e of this.flow.edges) {
      const q = new BoundedEdge(
        `${e.from}->${e.to}`,
        { capacity: e.capacity, overflow: e.overflow, ttlMs: e.ttlMs, blockTimeoutMs: e.blockTimeoutMs },
        this.clock,
        (ev) => {
          if (ev.kind === 'overflow') {
            this.emitEvent({ type: 'edge_overflow', edge: `${e.from}->${e.to}`, dropped: ev.dropped, policy: e.overflow });
          } else {
            this.emitEvent({ type: 'edge_expired', edge: `${e.from}->${e.to}`, count: ev.dropped });
          }
        },
      );
      this.edges.set(`${e.from}->${e.to}`, { e, q });
    }
    // pumps ANTES de start: nós que emitem no start já têm consumidor
    for (const { e, q } of this.edges.values()) this._pumps.push(this.pump(e, q));
    // start em ordem topológica (SPEC §68: ordem de INVOCAÇÃO; a conclusão não
    // bloqueia os próximos — §88 prevê start() pendente durante o run, ex. fonte
    // que alimenta a partir de start()). Erro em start() → node_error + política.
    // maybeNaturalStop exige TODOS os start() assentados (allStarted).
    const startPromises: Promise<void>[] = [];
    for (const id of this.flow.topoOrder) {
      if (this.stopped) break;
      const st = this.nodeStates.get(id)!;
      const p = (async () => {
        await st.runtime.start();
      })();
      st.startPromise = p;
      startPromises.push(
        p.then(
          () => {
            st.started = true;
          },
          (err) => {
            st.started = true; // start() resolveu com erro: stop() já pode ser chamado (§88)
            this.handleNodeError(st, err);
            if (this.policyOf(st) === 'stop_run') {
              void this.stop(`erro no start de ${id}`);
            }
          },
        ),
      );
    }
    // NÃO aguardar a CONCLUSÃO dos start(): uma fonte contínua (captura, tone com
    // intervalo) manteria runGraph pendurado e o host nunca veria eventos nem
    // conseguiria parar o run. Invocação é em ordem; conclusão é assíncrona.
    void Promise.all(startPromises).then(() => {
      this.allStarted = true;
      void this.maybeNaturalStop();
    });
  }

  private allStarted = false;
  private naturalStopScheduled = false;
  /** entregas em curso por nó (onInput aguardando). maybeNaturalStop só termina quando 0. */
  private inFlight = new Map<string, number>();

  /** stopWhenSourcesDone: fontes esgotadas + filas vazias + nenhum onInput em voo ⇒ run termina (Spec v1.1). */
  private async maybeNaturalStop(): Promise<void> {
    if (!this.opts.stopWhenSourcesDone || !this.allStarted || this.stopped || this.naturalStopScheduled) return;
    const empty = [...this.edges.values()].every(({ q }) => q.depth === 0);
    if (!empty) return;
    // onInput em voo (ex.: LLM aguardando fetch de rede): NÃO é "nada pendente" — espera.
    const busy = [...this.inFlight.values()].some((n) => n > 0);
    if (busy) return;
    this.naturalStopScheduled = true;
    // duas voltas de event loop: garante que nenhuma entrega em curso reabasteceu
    await new Promise<void>((r) => {
      const t = setTimeout(r, 0);
      void t;
    });
    await new Promise<void>((r) => {
      const t = setTimeout(r, 0);
      void t;
    });
    this.naturalStopScheduled = false;
    if (this.stopped) return;
    const stillEmpty = [...this.edges.values()].every(({ q }) => q.depth === 0);
    if (stillEmpty) await this.stop('fontes esgotadas');
  }

  private async pump(e: ValidatedEdge, q: BoundedEdge): Promise<void> {
    const target = this.nodeStates.get(e.toNode);
    if (!target) return;
    while (true) {
      const env = await q.take();
      if (env === null) return; // fechada e drenada
      try {
        this.inFlight.set(target.id, (this.inFlight.get(target.id) ?? 0) + 1);
        try {
          await this.deliver(e, target, env);
        } finally {
          this.inFlight.set(target.id, (this.inFlight.get(target.id) ?? 1) - 1);
          void this.maybeNaturalStop();
        }
      } catch (err) {
        this.handleNodeError(target, err);
        if (this.policyOf(target) === 'stop_run') {
          void this.stop(`erro no nó ${target.id}`);
          return;
        }
      }
    }
  }

  private async deliver(e: ValidatedEdge, target: NodeState, env: Envelope): Promise<void> {
    if (env.control) {
      const c = env.payload as ControlMsg;
      // control não conta como input de dados (Spec §3)
      target.runtime.onControl?.(c);
      return;
    }
    target.metrics.in++;
    const t0 = this.clock.now();
    await target.runtime.onInput(e.toPort, env);
    const dt = this.clock.now() - t0;
    const arr = target.metrics.proc;
    arr.push(dt);
    if (arr.length > this.procWindow) arr.shift();
    void this.maybeNaturalStop();
  }

  private invokeOnControl(target: NodeState, c: ControlMsg): void {
    try {
      target.runtime.onControl?.(c);
    } catch (err) {
      this.handleNodeError(target, err);
      if (this.policyOf(target) === 'stop_run') {
        void this.stop(`erro no onControl de ${target.id}`);
      }
    }
  }

  private policyOf(st: NodeState): 'isolate' | 'stop_run' {
    return this.flow.nodes.get(st.id)!.def.onError ?? 'isolate';
  }

  private handleNodeError(st: NodeState, err: unknown): void {
    st.errored = true;
    st.metrics.errors++;
    const code = err instanceof GraphError ? err.code : (err as Error | undefined)?.name ?? 'RUNTIME_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    this.emitEvent({ type: 'node_error', nodeId: st.id, code, message });
    if (this.policyOf(st) === 'isolate') {
      for (const { e, q } of this.edges.values()) {
        if (e.toNode === st.id) q.close(`destino ${st.id} isolado`, true);
        if (e.fromNode === st.id) q.close(`origem ${st.id} isolada`, false);
      }
    }
  }

  // ---- API do host ----------------------------------------------------------

  /** Cancela seqs de um nó em todas as edges dele (Spec v1.1 §3). */
  cancelByNode(nodeId: string, uptoSeqByPort: Record<string, number>, reason = 'host'): void {
    for (const [port, upto] of Object.entries(uptoSeqByPort)) {
      const own = this.cancelledSeqs.get(nodeId);
      if (own) {
        const set = own.get(port) ?? new Set<number>();
        for (let s = 1; s <= upto; s++) set.add(s);
        own.set(port, set);
      }
    }
    for (const { e, q } of this.edges.values()) {
      if (e.fromNode !== nodeId) continue;
      const upto = uptoSeqByPort[e.fromPort];
      if (upto === undefined) continue;
      q.markCancelled({ kind: 'cancel', scope: 'port', uptoSeq: upto, reason });
    }
    this.emitEvent({ type: 'cancelled', scope: 'node', by: reason });
  }

  snapshot(): Snapshot {
    const nodes: Record<string, NodeMetrics> = {};
    for (const [id, st] of this.nodeStates) {
      const sorted = [...st.metrics.proc].sort((a, b) => a - b);
      nodes[id] = {
        started: st.started,
        errored: st.errored,
        in: st.metrics.in,
        out: st.metrics.out,
        dropped: 0,
        expired: 0,
        errors: st.metrics.errors,
        procMsP50: percentile(sorted, 50),
        procMsP95: percentile(sorted, 95),
        counters: { ...st.metrics.counters },
        timers: Object.fromEntries(
          Object.entries(st.metrics.timers).map(([k, t]) => [
            k,
            { count: t.count, lastMs: t.last, avgMs: t.sum / t.count, minMs: t.min, maxMs: t.max },
          ]),
        ),
      };
    }
    for (const { e, q } of this.edges.values()) {
      const nm = nodes[e.fromNode];
      if (nm) {
        nm.dropped += q.stats.dropped;
        nm.expired += q.stats.expired;
      }
    }
    const eMetrics: Snapshot['edges'] = {};
    for (const [name, { q }] of this.edges) {
      eMetrics[name] = { depth: q.depth, dropped: q.stats.dropped, expired: q.stats.expired };
    }
    return { runId: this.runId, stopped: this.stopped, nodes, edges: eMetrics };
  }

  stop(reason = 'host'): Promise<void> {
    if (this.stopPromise) return this.stopPromise; // idempotente: mesma promise (rev-api)
    this.stopPromise = this.doStop(reason);
    return this.stopPromise;
  }

  private async doStop(reason: string): Promise<void> {
    this.stopped = true;
    this.phase = 'draining';
    this.abort.abort();
    // start() pendente: aguarda assentar (não chamamos stop antes de o start terminar — rev-api B2)
    for (const st of this.nodeStates.values()) {
      if (st.startPromise) {
        await Promise.race([
          st.startPromise.catch(() => {}),
          new Promise<void>((r) => {
            const t = setTimeout(r, 1000);
            void t;
          }),
        ]);
      }
    }
    // stop() em ordem reversa topológica, uma única vez por runtime
    for (const id of [...this.flow.topoOrder].reverse()) {
      const st = this.nodeStates.get(id)!;
      if (!st.stopCalled) {
        st.stopCalled = true;
        try {
          await st.runtime.stop(reason);
        } catch (err) {
          this.emitEvent({ type: 'node_error', nodeId: id, code: 'STOP_ERROR', message: String(err) });
        }
        this.emitEvent({ type: 'node_stopped', nodeId: id, reason });
      }
    }
    // fecha e drena filas dentro de drainTimeoutMs (Spec §4)
    for (const { q } of this.edges.values()) q.close(reason, false);
    const deadline = this.clock.now() + (this.opts.drainTimeoutMs ?? 2000);
    await Promise.race([
      Promise.allSettled(this.livePumps()),
      new Promise<void>((r) => {
        const t = setTimeout(r, Math.max(0, deadline - this.clock.now()));
        void t;
      }),
    ]);
    for (const { q } of this.edges.values()) q.close('drain_timeout', true);
    await Promise.allSettled(this.livePumps());
    this.emitEvent({ type: 'run_stopped', runId: this.runId, reason });
    this.eventDone = true;
    this.phase = 'done';
    for (const w of this.eventWaiters.splice(0)) w();
    if (this.onNaturalDone) this.onNaturalDone();
  }

  private livePumps(): Promise<unknown>[] {
    return this._pumps;
  }

  private _pumps: Promise<void>[] = [];

  /** Promise que resolve quando o run termina (por stop() ou fonte natural futura). */
  get done(): Promise<void> {
    return new Promise((res) => {
      if (this.eventDone) res();
      else this.onNaturalDone = res;
    });
  }
}

export async function runGraph(flow: FlowSpec, registry: Registry, opts: RunOpts = {}): Promise<RunningGraph> {
  const validated = validateFlow(flow, registryToMap(registry));
  const merged: RunOpts = {
    ...opts,
    stopWhenSourcesDone: opts.stopWhenSourcesDone ?? flow.stopWhenSourcesDone === true,
  };
  const rg = new RunningGraph(validated, merged);
  await rg.start();
  return rg;
}
