// falador-graph — r3: enabled?: boolean por nó (TUI/canvas toggle)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRegistry,
  runGraph,
  GraphError,
  sourceTone,
  pipeDelay,
  pipeParcs,
  sinkCollect,
  type FlowSpec,
} from '../src/index.ts';

function baseRegistry(): ReturnType<typeof createRegistry> {
  return createRegistry().register(sourceTone).register(pipeDelay).register(pipeParcs).register(sinkCollect);
}

const collected = () => ({ received: [] as Array<{ port: string; payload: unknown }> });

test('E1: enabled:false remove o nó e as suas edges — rota pela ponte direto (bypass)', async () => {
  // grafo: src → ponte → snk  (parcs desabilitado)
  const c1 = collected();
  const flow: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 2 } },
      { id: 'parcs', type: 'pipe.parcs', enabled: false }, // toggle da TUI
      { id: 'snk', type: 'sink.collect' },
    ],
    edges: [
      { from: 'src.out', to: 'parcs.in', capacity: 8, overflow: 'block' }, // deve ser ignorada
      { from: 'src.out', to: 'snk.phrase', capacity: 8, overflow: 'block' }, // ponte direta
      { from: 'parcs.out', to: 'snk.parcs', capacity: 8, overflow: 'block' }, // deve ser ignorada
    ],
    bindings: { snk: { __collect: c1 } },
  };
  const rg = await runGraph(flow, baseRegistry());
  await rg.done;
  const ports = c1.received.map((r) => r.port);
  assert.deepEqual(ports, ['phrase', 'phrase'], '2 frases pela ponte, nenhum parcial do nó desligado');
  assert.ok(!('parcs' in rg.snapshot().nodes), 'nó desabilitado não consta no snapshot');
});

test('E2: enabled default true; enabled:false em FONTE remove fonte e run termina naturalmente vazio', async () => {
  const c = collected();
  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 3 }, enabled: false },
        { id: 'srcAlt', type: 'source.tone', params: { count: 1, prefix: 'alt' } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'snk.phrase', capacity: 4, overflow: 'block' },
        { from: 'srcAlt.out', to: 'snk.phrase', capacity: 4, overflow: 'block' },
      ],
      bindings: { snk: { __collect: c } },
    },
    baseRegistry(),
  );
  await rg.done;
  assert.deepEqual(c.received.map((r) => r.payload), ['alt-1']);
});

test('E3: TODAS as fontes desabilitadas ⇒ no-op: run termina imediatamente, sem erro', async () => {
  const c = collected();
  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 3 }, enabled: false },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [{ from: 'src.out', to: 'snk.phrase', capacity: 4, overflow: 'block' }],
      bindings: { snk: { __collect: c } },
    },
    baseRegistry(),
  );
  await rg.done;
  assert.equal(c.received.length, 0);
  assert.equal(rg.snapshot().stopped, true);
});

test('E4: edge de nó desabilitado é descartada JUNTO (silencioso, Spec) — mas UNKNOWN_NODE de nó nunca existido é erro', async () => {
  const c = collected();
  // (a) parcs desabilitado: a edge que saía dele some com ele; sink fica sem nada e roda normal
  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'parcs', type: 'pipe.parcs', enabled: false },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [{ from: 'parcs.out', to: 'snk.parcs', capacity: 4, overflow: 'block' }],
      bindings: { snk: { __collect: c } },
    },
    baseRegistry(),
  );
  await rg.done;
  assert.equal(c.received.length, 0, 'edge removida junto com o nó desabilitado');
  // (b) ref a nó que NUNCA existiu na spec: erro de qualquer forma
  await assert.rejects(
    () =>
      runGraph(
        {
          version: 1,
          nodes: [{ id: 'snk', type: 'sink.collect' }],
          edges: [{ from: 'fantasma.out', to: 'snk.phrase', capacity: 4, overflow: 'block' }],
          bindings: { snk: { __collect: collected() } },
        },
        baseRegistry(),
      ),
    (e: unknown) => e instanceof GraphError && (e as GraphError).code === 'UNKNOWN_NODE',
  );
});
