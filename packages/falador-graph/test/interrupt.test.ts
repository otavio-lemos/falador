// falador-graph — testes de propagação de barge-in / interrupt (ADR-006 Fase 2)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRegistry,
  runGraph,
  type ControlMsg,
  type FlowSpec,
  type NodeCtx,
  type NodeTypeDef,
  type PortType,
} from '../src/index.ts';

function makeManualSource(
  type: string,
  portType: PortType = 'tokens_parcial',
): {
  def: NodeTypeDef;
  emit: (payload: unknown) => Promise<void>;
  emitControl: (c: ControlMsg) => void;
} {
  let ctxRef: NodeCtx | null = null;
  const def: NodeTypeDef = {
    type,
    sourceOnly: true,
    inputs: [],
    outputs: [{ name: 'out', type: portType, required: false }],
    create: (ctx) => {
      ctxRef = ctx;
      return {
        async start() {},
        async onInput() {},
        async stop() {},
      };
    },
  };
  return {
    def,
    emit: async (payload) => {
      if (!ctxRef) throw new Error('source não iniciada');
      await ctxRef.emit('out', payload);
    },
    emitControl: (c) => {
      if (!ctxRef) throw new Error('source não iniciada');
      ctxRef.emitControl('out', c);
    },
  };
}

function makePassNode(
  type: string,
  opts: {
    portType?: PortType;
    inputs?: string[];
    hasOutput?: boolean;
    delayMs?: number;
    onControlLog?: ControlMsg[];
    throwOnControl?: boolean;
    receivedLog?: unknown[];
  } = {},
): NodeTypeDef {
  const portType = opts.portType ?? 'tokens_parcial';
  const inputs = (opts.inputs ?? ['in']).map((name) => ({ name, type: portType }));
  const outputs = opts.hasOutput === false ? [] : [{ name: 'out', type: portType, required: false }];
  return {
    type,
    inputs,
    outputs,
    sink: opts.hasOutput === false ? true : undefined,
    create: (ctx) => ({
      async start() {},
      async onInput(_port, msg) {
        opts.receivedLog?.push(msg.payload);
        if (opts.delayMs) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, opts.delayMs);
            void t;
          });
        }
        if (opts.hasOutput !== false) {
          await ctx.emit('out', msg.payload);
        }
      },
      async stop() {},
      onControl(c) {
        opts.onControlLog?.push(c);
        if (opts.throwOnControl) {
          throw new Error('falha simulada em onControl');
        }
      },
    }),
  };
}

test('I1: propagação linear A -> B -> C chama onControl 1x em B e 1x em C com sourceNode A', async () => {
  const src = makeManualSource('test.src');
  const bControls: ControlMsg[] = [];
  const cControls: ControlMsg[] = [];

  const reg = createRegistry()
    .register(src.def)
    .register(makePassNode('test.b', { onControlLog: bControls }))
    .register(makePassNode('test.c', { hasOutput: false, onControlLog: cControls }));

  const flow: FlowSpec = {
    version: 1,
    nodes: [
      { id: 'A', type: 'test.src' },
      { id: 'B', type: 'test.b' },
      { id: 'C', type: 'test.c' },
    ],
    edges: [
      { from: 'A.out', to: 'B.in', capacity: 16, overflow: 'block' },
      { from: 'B.out', to: 'C.in', capacity: 16, overflow: 'block' },
    ],
  };

  const rg = await runGraph(flow, reg);
  src.emitControl({ kind: 'interrupt', scope: 'port', turnId: 't1', reason: 'speech_started' });
  await rg.stop('fim');

  assert.equal(bControls.length, 1, 'B.onControl chamado 1x');
  assert.equal(cControls.length, 1, 'C.onControl chamado 1x');
  assert.equal(bControls[0].kind, 'interrupt');
  assert.equal(bControls[0].sourceNode, 'A');
  assert.equal(bControls[0].turnId, 't1');
  assert.equal(bControls[0].reason, 'speech_started');
  assert.equal(cControls[0].kind, 'interrupt');
  assert.equal(cControls[0].sourceNode, 'A');

  const ev = rg.eventsSnapshot().find((e) => e.type === 'interrupted');
  assert.ok(ev && ev.type === 'interrupted', 'evento interrupted emitido');
  assert.equal(ev.by, 'A');
  assert.equal(ev.reason, 'speech_started');
  assert.deepEqual(ev.affectedNodes, ['B', 'C']);
});

test('I2: propagação em diamante A -> B, A -> C, B -> D, C -> D chama D.onControl exatamente 1 vez', async () => {
  const src = makeManualSource('test.src');
  const bControls: ControlMsg[] = [];
  const cControls: ControlMsg[] = [];
  const dControls: ControlMsg[] = [];

  const reg = createRegistry()
    .register(src.def)
    .register(makePassNode('test.b', { onControlLog: bControls }))
    .register(makePassNode('test.c', { onControlLog: cControls }))
    .register(makePassNode('test.d', { inputs: ['in1', 'in2'], hasOutput: false, onControlLog: dControls }));

  const flow: FlowSpec = {
    version: 1,
    nodes: [
      { id: 'A', type: 'test.src' },
      { id: 'B', type: 'test.b' },
      { id: 'C', type: 'test.c' },
      { id: 'D', type: 'test.d' },
    ],
    edges: [
      { from: 'A.out', to: 'B.in', capacity: 16, overflow: 'block' },
      { from: 'A.out', to: 'C.in', capacity: 16, overflow: 'block' },
      { from: 'B.out', to: 'D.in1', capacity: 16, overflow: 'block' },
      { from: 'C.out', to: 'D.in2', capacity: 16, overflow: 'block' },
    ],
  };

  const rg = await runGraph(flow, reg);
  src.emitControl({ kind: 'interrupt', scope: 'port', reason: 'barge_in' });
  await rg.stop('fim');

  assert.equal(bControls.length, 1, 'B chamado 1x');
  assert.equal(cControls.length, 1, 'C chamado 1x');
  assert.equal(dControls.length, 1, 'D chamado exatamente 1x sem duplicação');
  assert.equal(dControls[0].sourceNode, 'A');
  assert.equal(dControls[0].kind, 'interrupt');

  const ev = rg.eventsSnapshot().find((e) => e.type === 'interrupted');
  assert.ok(ev && ev.type === 'interrupted', 'evento interrupted presente em eventsSnapshot()');
  assert.equal(ev.by, 'A');
  assert.equal(ev.reason, 'barge_in');
  assert.deepEqual([...ev.affectedNodes].sort(), ['B', 'C', 'D']);
  assert.equal(ev.affectedNodes.length, 3);
});

test('I3: isolamento de erro — exceção em B.onControl gera node_error mas ainda notifica C sem crashar', async () => {
  const src = makeManualSource('test.src');
  const bControls: ControlMsg[] = [];
  const cControls: ControlMsg[] = [];

  const reg = createRegistry()
    .register(src.def)
    .register(makePassNode('test.b', { onControlLog: bControls, throwOnControl: true }))
    .register(makePassNode('test.c', { hasOutput: false, onControlLog: cControls }));

  const flow: FlowSpec = {
    version: 1,
    nodes: [
      { id: 'A', type: 'test.src' },
      { id: 'B', type: 'test.b' },
      { id: 'C', type: 'test.c' },
    ],
    edges: [
      { from: 'A.out', to: 'B.in', capacity: 16, overflow: 'block' },
      { from: 'B.out', to: 'C.in', capacity: 16, overflow: 'block' },
    ],
  };

  const rg = await runGraph(flow, reg);
  // emitControl não deve lançar exceção mesmo com B.onControl falhando
  assert.doesNotThrow(() => {
    src.emitControl({ kind: 'interrupt', scope: 'port', reason: 'err_test' });
  });
  await rg.stop('fim');

  assert.equal(bControls.length, 1, 'B.onControl foi chamado');
  assert.equal(cControls.length, 1, 'C.onControl ainda foi chamado após erro em B');
  assert.equal(cControls[0].sourceNode, 'A');

  const evs = rg.eventsSnapshot();
  const errEv = evs.find((e) => e.type === 'node_error' && e.nodeId === 'B');
  assert.ok(errEv && errEv.type === 'node_error', 'node_error gerado para B');
  assert.match(errEv.message, /falha simulada em onControl/);
  assert.equal(rg.snapshot().nodes.B.errored, true);
  assert.equal(rg.snapshot().nodes.C.errored, false);

  const intEv = evs.find((e) => e.type === 'interrupted');
  assert.ok(intEv && intEv.type === 'interrupted', 'interrupted ainda emitido');
  assert.deepEqual(intEv.affectedNodes, ['B', 'C']);
});

test('I4: interrupt descarta mensagens pendentes em filas de texto (tokens_parcial/phrase) sem bloquear', async () => {
  const src = makeManualSource('test.src', 'phrase');
  const received: unknown[] = [];
  const bControls: ControlMsg[] = [];

  const reg = createRegistry()
    .register(src.def)
    .register(makePassNode('test.slow', {
      portType: 'phrase',
      hasOutput: false,
      delayMs: 80,
      onControlLog: bControls,
      receivedLog: received,
    }));

  const flow: FlowSpec = {
    version: 1,
    nodes: [
      { id: 'A', type: 'test.src' },
      { id: 'B', type: 'test.slow' },
    ],
    edges: [{ from: 'A.out', to: 'B.in', capacity: 4, overflow: 'block' }],
  };

  const rg = await runGraph(flow, reg);
  // m1 entra em processamento em B (delay 80ms); m2..m4 ficam pendentes na fila
  await src.emit('m1');
  await src.emit('m2');
  await src.emit('m3');
  await src.emit('m4');
  // interrupt síncrono deve descartar pendentes na fila sem bloquear
  src.emitControl({ kind: 'interrupt', scope: 'port', reason: 'flush' });

  await new Promise<void>((r) => {
    const t = setTimeout(r, 120);
    void t;
  });
  await rg.stop('fim');

  assert.equal(bControls.length, 1);
  assert.deepEqual(received, ['m1'], 'mensagens pendentes m2..m4 descartadas da fila de texto');
});

test('I5: cancel mantém marcação e notifica onControl do destino com sourceNode', async () => {
  const src = makeManualSource('test.src', 'phrase');
  const bControls: ControlMsg[] = [];

  const reg = createRegistry()
    .register(src.def)
    .register(makePassNode('test.b', { portType: 'phrase', hasOutput: false, onControlLog: bControls }));

  const flow: FlowSpec = {
    version: 1,
    nodes: [
      { id: 'A', type: 'test.src' },
      { id: 'B', type: 'test.b' },
    ],
    edges: [{ from: 'A.out', to: 'B.in', capacity: 8, overflow: 'block' }],
  };

  const rg = await runGraph(flow, reg);
  src.emitControl({ kind: 'cancel', scope: 'port', uptoSeq: 2, reason: 'superseded' });
  await rg.stop('fim');

  assert.equal(bControls.length, 1);
  assert.equal(bControls[0].kind, 'cancel');
  assert.equal(bControls[0].sourceNode, 'A');
  assert.equal(bControls[0].uptoSeq, 2);
  assert.ok(rg.eventsSnapshot().some((e) => e.type === 'cancelled' && e.by === 'A'));
});
