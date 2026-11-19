// falador-graph — fila limitada com políticas de overflow (Spec §5)
import type { Clock, Envelope, OverflowPolicy } from './types.ts';

export interface EdgeOpts {
  capacity: number;
  overflow: OverflowPolicy;
  ttlMs?: number;
  blockTimeoutMs?: number; // default 30000
}

export class EdgeClosedError extends Error {
  edge: string;
  reason: string;
  constructor(edge: string, reason: string) {
    super(`edge ${edge} closed: ${reason}`);
    this.name = 'EdgeClosedError';
    this.edge = edge;
    this.reason = reason;
  }
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class BoundedEdge {
  private q: Envelope[] = [];
  private spaceWaiters: Waiter[] = [];
  private dataWaiters: Waiter[] = [];
  private closed = false;
  /** linhas bloqueadas por política block aguardando espaço. */
  private blockedEmits = 0;
  stats = { dropped: 0, expired: 0, delivered: 0 };

  readonly name: string;
  private readonly opts: EdgeOpts;
  private readonly clock: Clock;
  private readonly onEvent: (e: { kind: 'overflow' | 'expired'; dropped: number }) => void;

  constructor(
    name: string,
    opts: EdgeOpts,
    clock: Clock,
    onEvent: (e: { kind: 'overflow' | 'expired'; dropped: number }) => void,
  ) {
    this.name = name;
    this.opts = opts;
    this.clock = clock;
    this.onEvent = onEvent;
  }

  get depth(): number {
    return this.q.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private expiredNow(): number {
    if (this.opts.ttlMs === undefined) return 0;
    const now = this.clock.now();
    let n = 0;
    while (this.q.length > 0) {
      const head = this.q[0];
      if (head.ttl !== undefined && now - head.ts > head.ttl) {
        this.q.shift();
        n++;
      } else break;
    }
    if (n > 0) {
      this.stats.expired += n;
      this.notifySpace();
      this.onEvent({ kind: 'expired', dropped: n });
    }
    return n;
  }

  private notifySpace(): void {
    while (this.spaceWaiters.length > 0 && this.q.length < this.opts.capacity) {
      const w = this.spaceWaiters.shift()!;
      w.resolve();
    }
  }

  /**
   * Enfileira respeitando a política. Resolve quando a mensagem está na fila
   * (ou foi descartada por política/TTL). Rejeita EdgeClosedError se edge fechou.
   */
  async push(env: Envelope): Promise<void> {
    if (this.closed) throw new EdgeClosedError(this.name, 'push after close');
    this.expiredNow();

    if (this.q.length >= this.opts.capacity) {
      switch (this.opts.overflow) {
        case 'drop_newest': {
          this.stats.dropped++;
          this.onEvent({ kind: 'overflow', dropped: 1 });
          return;
        }
        case 'drop_oldest': {
          this.q.shift();
          this.stats.dropped++;
          this.onEvent({ kind: 'overflow', dropped: 1 });
          break;
        }
        case 'block': {
          const deadline =
            this.clock.now() + (this.opts.blockTimeoutMs ?? 30_000);
          this.blockedEmits++;
          try {
            while (this.q.length >= this.opts.capacity && !this.closed) {
              const ms = deadline - this.clock.now();
              if (ms <= 0) {
                // anti-deadlock (Spec v1.1 §5): descarta e sinaliza
                this.stats.dropped++;
                this.onEvent({ kind: 'overflow', dropped: 1 });
                return;
              }
              await this.waitForSpace(ms);
            }
          } finally {
            this.blockedEmits--;
          }
          if (this.closed) throw new EdgeClosedError(this.name, 'closed while blocked');
          // espaço obtido: reavalia TTL antes de entrar
          if (env.ttl !== undefined && this.clock.now() - env.ts > env.ttl) {
            this.stats.expired++;
            this.onEvent({ kind: 'expired', dropped: 1 });
            return;
          }
          break;
        }
      }
    }
    this.q.push(env);
    this.notifyData();
  }

  private waitForSpace(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const w: Waiter = { resolve, reject };
      this.spaceWaiters.push(w);
      // deadline: wake via dataWaiters loop tick; implementado pelo pump do runtime via check periódico
      const t = setTimeout(() => {
        const i = this.spaceWaiters.indexOf(w);
        if (i >= 0) {
          this.spaceWaiters.splice(i, 1);
          resolve(); // volta ao loop do push, que reavalia (deadline vencido -> descarta)
        }
      }, ms);
      void t;
    });
  }

  private notifyData(): void {
    while (this.dataWaiters.length > 0 && this.q.length > 0) {
      const w = this.dataWaiters.shift()!;
      w.resolve();
    }
  }

  private waitForData(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.dataWaiters.push({ resolve, reject });
    });
  }

  /** Entrega próxima mensagem válida (espera se vazia). Resolve null em close+drenada. */
  async take(): Promise<Envelope | null> {
    while (true) {
      this.expiredNow();
      const env = this.q.shift();
      if (env !== undefined) {
        this.stats.delivered++;
        this.notifySpace();
        return env;
      }
      if (this.closed) return null;
      // desperta em push (notifyData) ou close (close resolve dataWaiters)
      await this.waitForData();
    }
  }

  private closeWaiters: ((err: Error) => void)[] = [];

  /** Marca mensagens já enfileiradas como canceladas (Spec v1.1 §3 — imediato, não espera a frente). */
  markCancelled(c: { kind: 'cancel'; uptoSeq?: number; uptoSeqByPort?: Record<string, number> }): void {
    const upto = c.uptoSeq;
    for (const env of this.q) {
      if (env.control) continue;
      if (upto !== undefined && env.seq <= upto) env.cancelled = true;
    }
  }

  /** Tira a próxima sem esperar (drain de emergência). */
  takeNow(): Envelope | null {
    this.expiredNow();
    const env = this.q.shift() ?? null;
    if (env !== null) {
      this.stats.delivered++;
      this.notifySpace();
    }
    return env;
  }

  /**
   * Fecha a edge: rejeita emissores bloqueados e desperta consumidores.
   * Mensagens em fila permanecem disponíveis para drain via take().
   */
  close(reason: string, hardDrop = false): void {
    if (this.closed) {
      // upgrade: já fechada antes, agora pede hardDrop — descarta o resto agora
      if (hardDrop && this.q.length > 0) {
        this.stats.dropped += this.q.length;
        this.q = [];
      }
      return;
    }
    this.closed = true;
    if (hardDrop) {
      this.stats.dropped += this.q.length;
      this.q = [];
    }
    const err = new EdgeClosedError(this.name, reason);
    for (const w of this.spaceWaiters.splice(0)) w.reject(err);
    for (const w of this.closeWaiters.splice(0)) w(err);
    for (const w of this.dataWaiters.splice(0)) w.resolve(); // pump drena o que sobrou
  }
}
