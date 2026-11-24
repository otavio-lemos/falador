// falador-graph — testes de portas tipadas de capability ('decider' | 'gate' | 'validator') e getProvider
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GraphError,
  createRegistry,
  registryToMap,
  runGraph,
  validateFlow,
  type DeciderProvider,
  type FlowSpec,
  type GateProvider,
  type NodeTypeDef,
  type ValidatorProvider,
} from '../src/index.ts';

function makePhraseSource(items: string[]): NodeTypeDef {
  return {
    type: 'src.phrase',
    sourceOnly: true,
    inputs: [],
    outputs: [{ name: 'out', type: 'phrase', required: false }],
    create: (ctx) => ({
      async start() {
        for (const text of items) await ctx.emit('out', { text });
      },
      async onInput() {},
      async stop() {},
    }),
  };
}

function makeDeciderNode(chosen: string, fail = false): NodeTypeDef {
  return {
    type: 'prov.decider',
    inputs: [{ name: 'in', type: 'tokens_parcial' }],
    outputs: [
      { name: 'out', type: 'tokens_parcial', required: true },
      { name: 'decider', type: 'decider', required: false },
    ],
    create: () => {
      const deciderProvider: DeciderProvider = {
        async decide() {
          if (fail) throw new Error('decider boom');
          return { chosen, confidence: 0.93, probabilities: { seguro: 0.07, sensivel: 0.93 } };
        },
      };
      return {
        deciderProvider,
        async start() {},
        async onInput() {},
        async stop() {},
      };
    },
  };
}

function makeGateNode(reply: string | null): NodeTypeDef {
  return {
    type: 'prov.gate',
    inputs: [{ name: 'in', type: 'tokens_parcial' }],
    outputs: [
      { name: 'out', type: 'phrase', required: true },
      { name: 'gate', type: 'gate', required: false },
    ],
    create: () => {
      const gateProvider: GateProvider = {
        async request() {
          return reply;
        },
      };
      return {
        gateProvider,
        async start() {},
        async onInput() {},
        async stop() {},
      };
    },
  };
}

function makeValidatorNode(achieved: boolean): NodeTypeDef {
  return {
    type: 'prov.validator',
    inputs: [{ name: 'in', type: 'phrase' }],
    outputs: [
      { name: 'out', type: 'phrase', required: true },
      { name: 'validator', type: 'validator', required: false },
    ],
    create: () => {
      const validatorProvider: ValidatorProvider = {
        confidenceThreshold: 0.85,
        async validate() {
          return { achieved, confidence: achieved ? 0.95 : 0.2, gaps: achieved ? [] : ['falta prova'], nextActions: [] };
        },
      };
      return {
        validatorProvider,
        async start() {},
        async onInput() {},
        async stop() {},
      };
    },
  };
}

function makeConsumerNode(
  onCall: (res: { decider: unknown; gate: unknown; validator: unknown; threshold?: number }) => void,
): NodeTypeDef {
  return {
    type: 'agent.mock',
    sink: true,
    inputs: [
      { name: 'in', type: 'phrase' },
      { name: 'decider', type: 'decider', required: false },
      { name: 'gate', type: 'gate', required: false },
      { name: 'validator', type: 'validator', required: false },
    ],
    outputs: [],
    create: (ctx) => ({
      async start() {},
      async onInput() {
        const dp = ctx.getProvider<DeciderProvider>('decider');
        const gp = ctx.getProvider<GateProvider>('gate');
        const vp = ctx.getProvider<ValidatorProvider>('validator');
        const decider = dp ? await dp.decide('cmd') : null;
        const gate = gp ? await gp.request('aprovar?') : null;
        const validator = vp
          ? await vp.validate({ goal: 'g', evidence: ['ok'], signal: ctx.signal })
          : null;
        onCall({ decider, gate, validator, threshold: vp?.confidenceThreshold });
      },
      async stop() {},
    }),
  };
}

test('P3-G1: portas decider/gate/validator passam V6 sem DISCONNECTED_NODE nem DEAD_OUTPUT_PORT e Kahn ordena provedores antes do consumidor', () => {
  const reg = createRegistry()
    .register(makePhraseSource(['ping']))
    .register(makeDeciderNode('sensivel'))
    .register(makeGateNode('ok'))
    .register(makeValidatorNode(true))
    .register(makeConsumerNode(() => {}));

  const flow: FlowSpec = {
    version: 1,
    nodes: [
      { id: 'src', type: 'src.phrase' },
      { id: 'dec', type: 'prov.decider' },
      { id: 'gt', type: 'prov.gate' },
      { id: 'val', type: 'prov.validator' },
      { id: 'ag', type: 'agent.mock' },
    ],
    edges: [
      { from: 'src.out', to: 'ag.in' },
      { from: 'dec.decider', to: 'ag.decider' },
      { from: 'gt.gate', to: 'ag.gate' },
      { from: 'val.validator', to: 'ag.validator' },
    ],
  };

  const validated = validateFlow(flow, registryToMap(reg));
  assert.ok(validated.topoOrder.indexOf('dec') < validated.topoOrder.indexOf('ag'));
  assert.ok(validated.topoOrder.indexOf('gt') < validated.topoOrder.indexOf('ag'));
  assert.ok(validated.topoOrder.indexOf('val') < validated.topoOrder.indexOf('ag'));
});

test('P3-G2: V2 mantém in-degree <= 1 para decider, gate e validator', () => {
  const reg = createRegistry()
    .register(makePhraseSource(['x']))
    .register(makeDeciderNode('seguro'))
    .register(makeGateNode('ok'))
    .register(makeValidatorNode(true))
    .register(makeConsumerNode(() => {}));

  for (const [type, port] of [
    ['prov.decider', 'decider'],
    ['prov.gate', 'gate'],
    ['prov.validator', 'validator'],
  ] as const) {
    assert.throws(
      () =>
        validateFlow(
          {
            version: 1,
            nodes: [
              { id: 'src', type: 'src.phrase' },
              { id: 'p1', type },
              { id: 'p2', type },
              { id: 'ag', type: 'agent.mock' },
            ],
            edges: [
              { from: 'src.out', to: 'ag.in' },
              { from: `p1.${port}`, to: `ag.${port}` },
              { from: `p2.${port}`, to: `ag.${port}` },
            ],
          },
          registryToMap(reg),
        ),
      (err: unknown) => err instanceof GraphError && err.code === 'IN_DEGREE_EXCEEDED',
      `deveria rejeitar in-degree=2 em porta ${port}`,
    );
  }
});

test('P3-G3: V4 rejeita PORT_TYPE_MISMATCH entre decider/gate/validator/phrase', () => {
  const reg = createRegistry()
    .register(makePhraseSource(['x']))
    .register(makeDeciderNode('seguro'))
    .register(makeGateNode('ok'))
    .register(makeConsumerNode(() => {}));

  assert.throws(
    () =>
      validateFlow(
        {
          version: 1,
          nodes: [
            { id: 'src', type: 'src.phrase' },
            { id: 'dec', type: 'prov.decider' },
            { id: 'ag', type: 'agent.mock' },
          ],
          edges: [
            { from: 'src.out', to: 'ag.in' },
            { from: 'dec.decider', to: 'ag.gate' },
          ],
        },
        registryToMap(reg),
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'PORT_TYPE_MISMATCH',
  );
});

test('P3-G4: ctx.getProvider invoca provedores e atualiza metrics.in/out + timers nos nós provedores', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const reg = createRegistry()
    .register(makePhraseSource(['msg1']))
    .register(makeDeciderNode('sensivel'))
    .register(makeGateNode('aprovado'))
    .register(makeValidatorNode(true))
    .register(makeConsumerNode((r) => observed.push(r)));

  const flow: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'src.phrase' },
      { id: 'dec', type: 'prov.decider' },
      { id: 'gt', type: 'prov.gate' },
      { id: 'val', type: 'prov.validator' },
      { id: 'ag', type: 'agent.mock' },
    ],
    edges: [
      { from: 'src.out', to: 'ag.in' },
      { from: 'dec.decider', to: 'ag.decider' },
      { from: 'gt.gate', to: 'ag.gate' },
      { from: 'val.validator', to: 'ag.validator' },
    ],
  };

  const rg = await runGraph(flow, reg);
  await rg.done;

  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].decider, {
    chosen: 'sensivel',
    confidence: 0.93,
    probabilities: { seguro: 0.07, sensivel: 0.93 },
  });
  assert.equal(observed[0].gate, 'aprovado');
  assert.equal((observed[0].validator as { achieved: boolean }).achieved, true);
  assert.equal(observed[0].threshold, 0.85);

  const snap = rg.snapshot();
  assert.equal(snap.nodes.dec.in, 1);
  assert.equal(snap.nodes.dec.out, 1);
  assert.ok(snap.nodes.dec.timers['provider.decider.ms']?.count === 1);
  assert.equal(snap.nodes.gt.in, 1);
  assert.equal(snap.nodes.gt.out, 1);
  assert.ok(snap.nodes.gt.timers['provider.gate.ms']?.count === 1);
  assert.equal(snap.nodes.val.in, 1);
  assert.equal(snap.nodes.val.out, 1);
  assert.ok(snap.nodes.val.timers['provider.validator.ms']?.count === 1);
});

test('P3-G5: provedor com enabled:false retorna null em ctx.getProvider', async () => {
  const observed: Array<Record<string, unknown>> = [];
  const reg = createRegistry()
    .register(makePhraseSource(['msg1']))
    .register(makeDeciderNode('seguro'))
    .register(makeConsumerNode((r) => observed.push(r)));

  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'src.phrase' },
        { id: 'dec', type: 'prov.decider', enabled: false },
        { id: 'ag', type: 'agent.mock' },
      ],
      edges: [
        { from: 'src.out', to: 'ag.in' },
        { from: 'dec.decider', to: 'ag.decider' },
      ],
    },
    reg,
  );
  await rg.done;

  assert.equal(observed.length, 1);
  assert.equal(observed[0].decider, null);
  assert.equal(observed[0].gate, null);
  assert.equal(observed[0].validator, null);
});
