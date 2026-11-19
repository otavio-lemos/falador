// falador-graph — suíte de aceite (Spec v1.1 §10, critérios 1-9)
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
  makeStreamingSource,
  type FlowSpec,
} from '../src/index.ts';

function baseRegistry(): ReturnType<typeof createRegistry> {
  return createRegistry().register(sourceTone).register(pipeDelay).register(pipeParcs).register(sinkCollect);
}

const drain = (ms: number) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  void t;
});

test('C1: pipeline sintético entrega seqs em ordem', async () => {
  const collected = { received: [] as Array<{ seq: number; payload: unknown }> };
  const flow: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 5 } },
      { id: 'p', type: 'pipe.delay', params: { delayMs: 1 } },
      { id: 'snk', type: 'sink.collect' },
    ],
    edges: [
      { from: 'src.out', to: 'p.in', capacity: 64, overflow: 'block' },
      { from: 'p.out', to: 'snk.phrase', capacity: 64, overflow: 'block' },
    ],
    bindings: { snk: { __collect: collected } },
  };
  const rg = await runGraph(flow, baseRegistry());
  await rg.done;
  assert.equal(collected.received.length, 5, 'todas entregues');
  assert.deepEqual(collected.received.map((m) => m.payload), ['tone-1', 'tone-2', 'tone-3', 'tone-4', 'tone-5']);
  assert.deepEqual(collected.received.map((m) => m.seq), [1, 2, 3, 4, 5], 'ordem de seq preservada');
  assert.equal(rg.snapshot().nodes.snk.errored, false);
});

test('C2: drop_oldest descarta com contagem; block nunca perde e aplica backpressure', async () => {
  // (a) drop_oldest — consumidor lento + capacity 2
  const rgDrop = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 50 } },
        { id: 'p', type: 'pipe.delay', params: { delayMs: 5 } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'p.in', capacity: 2, overflow: 'drop_oldest' },
        { from: 'p.out', to: 'snk.phrase', capacity: 64, overflow: 'block' },
      ],
      bindings: { snk: { __collect: { received: [] } } },
    },
    baseRegistry(),
  );
  await rgDrop.done;
  const s = rgDrop.snapshot();
  assert.ok(s.edges['src.out->p.in'].dropped > 0, 'houve drops por política');
  const evs = rgDrop.eventsSnapshot();
  assert.ok(evs.some((e) => e.type === 'edge_overflow'), 'edge_overflow emitido');
  assert.ok(evs.some((e) => e.type === 'run_stopped'), 'run termina');

  // (b) block — produtor retido na fila cheia, nada se perde
  const collected = { received: [] as Array<{ seq: number }> };
  const rgBlock = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 10 } },
        { id: 'p', type: 'pipe.delay', params: { delayMs: 20 } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'p.in', capacity: 2, overflow: 'block', blockTimeoutMs: 10_000 },
        { from: 'p.out', to: 'snk.phrase', capacity: 64, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    },
    baseRegistry(),
  );
  await rgBlock.done;
  const sb = rgBlock.snapshot();
  assert.equal(sb.edges['src.out->p.in'].dropped, 0, 'block nunca descarta');
  assert.equal(collected.received.length, 10, 'entrega completa com backpressure em cascata');
});

test('C3: TTL vencido não é entregue; edge_expired emitido', async () => {
  const collected = { received: [] as Array<{ seq: number }> };
  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 3, intervalMs: 50 } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [{ from: 'src.out', to: 'snk.phrase', capacity: 8, overflow: 'drop_newest', ttlMs: 20 }],
      bindings: { snk: { __collect: collected } },
    },
    baseRegistry(),
  );
  await rg.done;
  const s = rg.snapshot();
  const evs = rg.eventsSnapshot();
  const ttlTotal = s.edges['src.out->snk.phrase'].expired;
  assert.ok(collected.received.length + ttlTotal === 3, 'cada msg: entregue OU expirada (nunca ambas nem desaparecem)');
  if (ttlTotal > 0) assert.ok(evs.some((e) => e.type === 'edge_expired'), 'edge_expired emitido quando expira');
});

test('C4: cancel por seq — na fila vira flag; in-flight é cooperativo', async () => {
  const { def: srcDef, handle } = makeStreamingSource();
  const observe: Array<{ seq: number; cancelled: boolean; payload: unknown }> = [];
  const rg = await runGraph(
    {
      version: 1,
      nodes: [
        { id: 'src', type: srcDef.type, params: {} },
        // "sink lento" sem saída (out opcional): processa 1 msg a 60ms; fila segura as outras
        { id: 'slow', type: 'pipe.delay', params: { delayMs: 60 } },
      ],
      edges: [{ from: 'src.out', to: 'slow.in', capacity: 64, overflow: 'block' }],
      bindings: { slow: { __observe: observe } },
    },
    baseRegistry().register(srcDef),
  );
  for (let i = 1; i <= 5; i++) await handle.emit(`m${i}`);
  handle.cancel(3); // m1 em processamento (in-flight, cooperativo); m2..m3 na fila -> flag
  await drain(200);
  await rg.stop('fim');
  assert.equal(observe.length, 5, 'nenhuma mensagem sumiu');
  // m1 já estava em processamento quando cancel chegou (in-flight, não marcada)
  assert.equal(observe[0].cancelled, false);
  // m2..m3 estavam na fila: marcadas como canceladas
  assert.equal(observe[1].cancelled, true);
  assert.equal(observe[2].cancelled, true);
  assert.equal(observe[3].cancelled, false);
  assert.equal(observe[4].cancelled, false);
  assert.ok(rg.eventsSnapshot().some((e) => e.type === 'cancelled'));
});

test('C5: CYCLE / PORT_TYPE_MISMATCH / DUPLICATE_NODE_ID / UNKNOWN_PORT rejeitados na montagem', async () => {
  const reg = baseRegistry();
  await assert.rejects(
    () =>
      runGraph(
        {
          version: 1,
          nodes: [
            { id: 'a', type: 'pipe.delay', params: {} },
            { id: 'b', type: 'pipe.delay', params: {} },
          ],
          edges: [
            { from: 'a.out', to: 'b.in' },
            { from: 'b.out', to: 'a.in' },
          ],
        },
        reg,
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'CYCLE',
  );
  await assert.rejects(
    () =>
      runGraph(
        {
          version: 1,
          nodes: [
            { id: 's', type: 'source.tone', params: { count: 1 } },
            { id: 'p', type: 'pipe.parcs', params: {} },
            { id: 'snk', type: 'sink.collect' },
          ],
          edges: [
            { from: 's.out', to: 'p.in' },
            { from: 'p.out', to: 'snk.phrase' }, // tokens_parcial != phrase
          ],
          bindings: { snk: { __collect: { received: [] } } },
        },
        reg,
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'PORT_TYPE_MISMATCH',
  );
  await assert.rejects(
    () => runGraph({ version: 1, nodes: [{ id: 's', type: 'source.tone', params: { count: 1 } }, { id: 's', type: 'source.tone', params: { count: 1 } }], edges: [] }, reg),
    (err: unknown) => err instanceof GraphError && err.code === 'DUPLICATE_NODE_ID',
  );
  await assert.rejects(
    () =>
      runGraph(
        {
          version: 1,
          nodes: [
            { id: 's', type: 'source.tone', params: { count: 1 } },
            { id: 'snk', type: 'sink.collect' },
          ],
          edges: [{ from: 's.outt', to: 'snk.phrase' }],
          bindings: { snk: { __collect: { received: [] } } },
        },
        reg,
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'UNKNOWN_PORT',
  );
  // UNKNOWN_NODE em edge (typo de id) — rev-validação B2
  await assert.rejects(
    () =>
      runGraph(
        {
          version: 1,
          nodes: [{ id: 'src', type: 'source.tone', params: { count: 1 } }, { id: 'snk', type: 'sink.collect' }],
          edges: [{ from: 'mik.out', to: 'snk.phrase' }],
          bindings: { snk: { __collect: { received: [] } } },
        },
        reg,
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'UNKNOWN_NODE',
  );
});

test('C6: stop() drena em ordem reversa topológica e é idempotente (mesma promise)', async () => {
  const collected = { received: [] as Array<{ seq: number }> };
  const rg = await runGraph(
    {
      version: 1,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 3 } },
        { id: 'p', type: 'pipe.delay', params: { delayMs: 1 } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'p.in', capacity: 64, overflow: 'block' },
        { from: 'p.out', to: 'snk.phrase', capacity: 64, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    },
    baseRegistry(),
  );
  await drain(20);
  const p1 = rg.stop('host');
  const p2 = rg.stop('host2');
  assert.equal(p1, p2, 'segunda stop devolve a MESMA promise');
  await p1;
  const evs = rg.eventsSnapshot();
  const stops = evs.filter((e) => e.type === 'node_stopped').map((e) => (e as { nodeId: string }).nodeId);
  assert.deepEqual(stops, ['snk', 'p', 'src'], 'ordem reversa: sink primeiro, fonte por último');
  assert.equal(evs.at(-1)?.type, 'run_stopped', 'run_stopped é o último evento');
  assert.ok(evs[0] && evs[0].type === 'run_started', 'run_started registrado no log (replay)');
});

test('C7: métricas p50/p95 + contadores num run determinístico', async () => {
  const collected = { received: [] as Array<{ seq: number }> };
  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'source.tone', params: { count: 4 } },
        { id: 'p', type: 'pipe.delay', params: { delayMs: 10 } },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [
        { from: 'src.out', to: 'p.in', capacity: 64, overflow: 'block' },
        { from: 'p.out', to: 'snk.phrase', capacity: 64, overflow: 'block' },
      ],
      bindings: { snk: { __collect: collected } },
    },
    baseRegistry(),
  );
  await rg.done;
  const s = rg.snapshot();
  assert.equal(s.nodes.p.out, 4);
  assert.equal(s.nodes.snk.in, 4);
  assert.ok(s.nodes.p.procMsP50 !== null && s.nodes.p.procMsP50 >= 10, `p50 >= delay ms (${s.nodes.p.procMsP50})`);
  assert.ok(s.nodes.p.procMsP95 !== null && s.nodes.p.procMsP95! >= s.nodes.p.procMsP50!, 'p95 >= p50');
  assert.ok(rg.runId.startsWith('run-'));
});

test('C8: V7 binding ausente = MISSING_BINDING; erro em start() vira node_error', async () => {
  const reg = baseRegistry();
  await assert.rejects(
    () =>
      runGraph(
        {
          version: 1,
          nodes: [{ id: 'snk', type: 'sink.collect' }, { id: 'src', type: 'source.tone', params: { count: 1 } }],
          edges: [{ from: 'src.out', to: 'snk.phrase' }],
        },
        reg,
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'MISSING_BINDING',
  );

  // nó cujo start falha: isolate (default) → edges fechadas, run segue
  const broken = createRegistry()
    .register({
      type: 'broken.start',
      sourceOnly: true,
      inputs: [],
      outputs: [{ name: 'out', type: 'phrase', required: false }],
      create: (ctx) => ({
        async start() {
          throw new Error('device indisponível');
        },
        async onInput() {},
        async stop() {},
      }),
    })
    .register(sinkCollect);
  const collected = { received: [] as Array<{ seq: number }> };
  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'bad', type: 'broken.start', params: {} },
        { id: 'snk', type: 'sink.collect' },
      ],
      edges: [{ from: 'bad.out', to: 'snk.phrase' }],
      bindings: { snk: { __collect: collected } },
    },
    broken,
  );
  await rg.done;
  const evs = rg.eventsSnapshot();
  const ne = evs.find((e) => e.type === 'node_error') as { nodeId?: string } | undefined;
  assert.ok(ne, 'node_error emitido');
  assert.equal(ne.nodeId, 'bad');
  assert.equal(rg.snapshot().nodes.bad.errored, true, 'nó marcado como erroedo/isolado');
});
