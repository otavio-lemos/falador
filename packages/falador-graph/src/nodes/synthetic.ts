// falador-graph — nós sintéticos p/ testes e botão de teste (W7)
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../types.ts';

/** source.tone: emite `count` mensagens em `out` e encerra o seu trabalho. */
export const sourceTone: NodeTypeDef = {
  type: 'source.tone',
  sourceOnly: true,
  paramNames: ['count', 'intervalMs', 'prefix'],
  inputs: [],
  outputs: [{ name: 'out', type: 'phrase', required: false }],
  validateParams: (p) =>
    typeof p.count !== 'number' || !Number.isInteger(p.count) || p.count < 0
      ? [{ path: 'params.count', code: 'INVALID_PARAM', message: 'count deve ser inteiro >= 0' }]
      : [],
  create: (ctx: NodeCtx): NodeRuntime => {
    const count = ctx.params.count as number;
    const intervalMs = (ctx.params.intervalMs as number | undefined) ?? 0;
    const prefix = (ctx.params.prefix as string | undefined) ?? 'tone';
    let aborted = false;
    ctx.signal.addEventListener('abort', () => {
      aborted = true;
    });
    return {
      async start() {
        for (let i = 1; i <= count; i++) {
          if (aborted || ctx.signal.aborted) return;
          await ctx.emit('out', `${prefix}-${i}`);
          if (intervalMs > 0) {
            await new Promise<void>((r) => {
              const t = setTimeout(r, intervalMs);
              void t;
            });
          }
        }
      },
      async onInput() {},
      async stop() {},
    };
  },
};

/**
 * pipe.delay: repassa phrase de `in` p/ `out` com atraso (backpressure sintética).
 * Emite control na porta `out` quando recebe control cancelando msg.cancelled (passagem).
 */
export const pipeDelay: NodeTypeDef = {
  type: 'pipe.delay',
  paramNames: ['delayMs'],
  bindingNames: ['__observe'],
  inputs: [{ name: 'in', type: 'phrase' }],
  outputs: [{ name: 'out', type: 'phrase', required: false }],
  create: (ctx: NodeCtx): NodeRuntime => {
    const delayMs = (ctx.params.delayMs as number | undefined) ?? 0;
    const observe = ctx.bindings.__observe as
      | Array<{ seq: number; cancelled: boolean; payload: unknown }>
      | undefined;
    return {
      async start() {},
      async onInput(_port, msg) {
        observe?.push({ seq: msg.seq, cancelled: msg.cancelled === true, payload: msg.payload });
        if (delayMs > 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, delayMs);
            void t;
          });
        }
        await ctx.emit('out', msg.payload, { meta: { srcSeq: msg.seq } });
      },
      async stop() {},
    };
  },
};

/**
 * pipe.parcs: converte phrase em tokens_parcial cumulativos (pinga 2 snapshots).
 * Serve p/ testar ttl/overflow de parciais.
 */
export const pipeParcs: NodeTypeDef = {
  type: 'pipe.parcs',
  paramNames: [],
  inputs: [{ name: 'in', type: 'phrase' }],
  outputs: [{ name: 'out', type: 'tokens_parcial' }],
  create: (ctx: NodeCtx): NodeRuntime => ({
    async start() {},
    async onInput(_port, msg) {
      const text = String(msg.payload);
      await ctx.emit('out', { text: text.slice(0, Math.ceil(text.length / 2)), final: false });
      await ctx.emit('out', { text, final: true });
    },
    async stop() {},
  }),
};

/**
 * sink.collect: coleta tudo (teste). Compartilha array via binding "__collect".
 */
export const sinkCollect: NodeTypeDef = {
  type: 'sink.collect',
  sink: true,
  paramNames: [],
  bindingNames: ['__collect'],
  requiredBindings: ['__collect'],
  inputs: [
    { name: 'phrase', type: 'phrase' },
    { name: 'parcs', type: 'tokens_parcial' },
    { name: 'chunk', type: 'audio_chunk' },
    { name: 'pcm', type: 'pcm16k' },
  ],
  outputs: [],
  create: (ctx: NodeCtx): NodeRuntime => {
    const collected = ctx.bindings.__collect as {
      received: Array<{ port: string; seq: number; cancelled: boolean; payload: unknown }>;
    };
    return {
      async start() {},
      async onInput(port, msg) {
        collected.received.push({ port, seq: msg.seq, cancelled: msg.cancelled === true, payload: msg.payload });
      },
      async stop() {},
    };
  },
};

/**
 * source.streaming: fonte controlável externamente (testes de cancel/backpressure).
 * get expose p/ o host decidir quando emitir/cancelar.
 */
export interface StreamingSourceHandle {
  emit(payload: unknown, ttl?: number): Promise<number>;
  cancel(uptoSeq: number): void;
}

export function makeStreamingSource(): { def: NodeTypeDef; handle: StreamingSourceHandle } {
  let ctxRef: NodeCtx | null = null;
  const def: NodeTypeDef = {
    type: 'source.streaming',
    sourceOnly: true,
    paramNames: [],
    inputs: [],
    outputs: [{ name: 'out', type: 'phrase', required: false }],
    create: (ctx: NodeCtx): NodeRuntime => {
      ctxRef = ctx;
      return {
        async start() {},
        async onInput() {},
        async stop() {},
      };
    },
  };
  const handle: StreamingSourceHandle = {
    async emit(payload, ttl) {
      if (!ctxRef) throw new Error('fonte ainda não instanciada');
      const { seq } = await ctxRef.emit('out', payload, ttl !== undefined ? { ttl } : undefined);
      return seq;
    },
    cancel(uptoSeq) {
      if (!ctxRef) throw new Error('fonte ainda não instanciada');
      ctxRef.emitControl('out', { kind: 'cancel', scope: 'port', uptoSeq });
    },
  };
  return { def, handle };
}
