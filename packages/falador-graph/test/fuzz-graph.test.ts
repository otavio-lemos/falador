// falador-graph — fuzz determinístico da validação e do run.
// Objetivo: a validação NUNCA pode explodir com erro não-GraphError (TypeError,
// RangeError…) nem pendurar; e fluxos aceitos por ela devem rodar até o fim.
// PRNG com semente fixa: falha é reproduzível.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRegistry,
  registryToMap,
  runGraph,
  validateFlow,
  GraphError,
  sourceTone,
  pipeDelay,
  pipeParcs,
  sinkCollect,
  type FlowSpec,
} from '../src/index.ts';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const reg = () =>
  createRegistry().register(sourceTone).register(pipeDelay).register(pipeParcs).register(sinkCollect);

function baseFlow(): FlowSpec {
  return {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 3 } },
      { id: 'p', type: 'pipe.delay' },
      { id: 'snk', type: 'sink.collect' },
    ],
    edges: [
      { from: 'src.out', to: 'p.in' },
      { from: 'p.out', to: 'snk.phrase' },
    ],
    bindings: { snk: { __collect: { received: [] } } },
  };
}

const JUNK: unknown[] = [
  null,
  undefined,
  NaN,
  Infinity,
  -Infinity,
  0,
  -1,
  1.5,
  4097,
  '',
  ' ',
  'src.out',
  'a.b.c',
  [],
  {},
  { evil: true },
  true,
  10n,
];

const PATHS = [
  ['version'],
  ['nodes'],
  ['edges'],
  ['bindings'],
  ['nodes', 0, 'id'],
  ['nodes', 0, 'type'],
  ['nodes', 0, 'params'],
  ['nodes', 0, 'enabled'],
  ['nodes', 1, 'id'],
  ['edges', 0, 'from'],
  ['edges', 0, 'to'],
  ['edges', 0, 'capacity'],
  ['edges', 0, 'overflow'],
  ['edges', 0, 'ttlMs'],
  ['edges', 0, 'blockTimeoutMs'],
  ['bindings', 'snk', '__collect'],
] as const;

function mutate(rnd: () => number, base: unknown): unknown {
  const clone = structuredClone(base) as Record<string, unknown>;
  const rounds = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < rounds; i++) {
    const path = PATHS[Math.floor(rnd() * PATHS.length)];
    let cur: any = clone;
    for (let d = 0; d < path.length - 1; d++) {
      cur = cur?.[path[d] as never];
      if (cur === null || typeof cur !== 'object') break;
    }
    const key = path[path.length - 1];
    if (cur === null || typeof cur !== 'object') continue;
    const mode = rnd();
    if (mode < 0.6) cur[key as never] = structuredClone(JUNK[Math.floor(rnd() * JUNK.length)]) as never;
    else if (mode < 0.8 && Array.isArray(cur)) cur.splice(Number(key) as never, 1, structuredClone(JUNK[Math.floor(rnd() * JUNK.length)]));
    else delete cur[key as never];
  }
  return clone;
}

test('fuzz: validação só lança GraphError e é rápida em 400 specs mutados', () => {
  const rnd = mulberry32(0xfa1ad0);
  const map = registryToMap(reg());
  const codes = new Map<string, number>();
  const knownGaps: string[] = [];
  const t0 = performance.now();
  for (let i = 0; i < 400; i++) {
    const raw = mutate(rnd, baseFlow()) as FlowSpec;
    try {
      const v = validateFlow(raw, map);
      // invariantes de qualquer fluxo aceito
      assert.equal(v.topoOrder.length, v.nodes.size, `topo incompleto no caso ${i}`);
      assert.equal(new Set(v.topoOrder).size, v.topoOrder.length, `topo duplicado no caso ${i}`);
      for (const e of v.edges) {
        assert.ok(v.nodes.has(e.fromNode) && v.nodes.has(e.toNode));
        assert.ok(e.capacity >= 1 && e.capacity <= 4096);
        assert.ok(['drop_oldest', 'drop_newest', 'block'].includes(e.overflow));
        assert.ok(e.blockTimeoutMs > 0 && Number.isFinite(e.blockTimeoutMs));
      }
      // validar de novo é idempotente (o host revalida antes de rodar)
      const again = validateFlow(raw, map);
      assert.equal(again.edges.length, v.edges.length, `validação não-idempotente no caso ${i}`);
    } catch (e) {
      if (!(e instanceof GraphError)) {
        knownGaps.push(`caso ${i}: ${String(e)}`);
        continue;
      }
      assert.ok(e.code.length > 0 && e.path.length > 0 && e.message.length > 0);
      codes.set(e.code, (codes.get(e.code) ?? 0) + 1);
    }
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 5_000, `validação lenta: ${ms.toFixed(0)} ms para 400 specs`);
  // o fuzz precisa de fato exercitar vários códigos, senão não vale nada
  assert.ok(codes.size >= 5, `fuzz cobriu só ${codes.size} códigos: ${[...codes.keys()].join(',')}`);
  // nenhum erro não-GraphError é aceitável: qualquer TypeError aqui é regressão.
  assert.deepEqual(knownGaps, [], `erros não-GraphError: ${knownGaps.slice(0, 3).join(' | ')}`);
});

test('edge.from/to não-string vira INVALID_EDGE_REF (não TypeError)', () => {
  const map = registryToMap(reg());
  for (const bad of [null, undefined, 42, {}, []]) {
    const raw = {
      ...baseFlow(),
      edges: [{ from: bad as unknown as string, to: 'p.in' }, ...baseFlow().edges],
    };
    assert.throws(
      () => validateFlow(raw, map),
      (e: unknown) => e instanceof GraphError && e.code === 'INVALID_EDGE_REF',
      `from=${String(bad)} deveria ser INVALID_EDGE_REF`,
    );
  }
});

test('fuzz: specs extremos não quebram a validação', () => {
  const map = registryToMap(reg());
  const cases: Array<[string, unknown]> = [
    ['nodes vazio', { version: 1, nodes: [], edges: [] }],
    ['edges sem nós', { version: 1, nodes: [], edges: [{ from: 'a.out', to: 'b.in' }] }],
    ['self-edge', { ...baseFlow(), edges: [{ from: 'p.out', to: 'p.in' }] }],
    ['from/to invertidos', { ...baseFlow(), edges: [{ from: 'p.in', to: 'snk.phrase' }] }],
    ['capacity string', { ...baseFlow(), edges: [{ from: 'src.out', to: 'p.in', capacity: '64' }] }],
    ['overflow null', { ...baseFlow(), edges: [{ from: 'src.out', to: 'p.in', overflow: null }] }],
    ['ttl string', { ...baseFlow(), edges: [{ from: 'src.out', to: 'p.in', ttlMs: '10' }] }],
    ['params array', { ...baseFlow(), nodes: [{ id: 'src', type: 'source.tone', params: [] }] }],
    ['bindings array', { ...baseFlow(), bindings: [] }],
    ['id numérico', { ...baseFlow(), nodes: [{ id: 42, type: 'source.tone' }] }],
  ];
  for (const [name, raw] of cases) {
    try {
      validateFlow(raw as FlowSpec, map);
    } catch (e) {
      assert.ok(e instanceof GraphError, `${name}: ${String(e)}`);
    }
  }
});

test('fuzz: 12 pipelines aleatórios (src->N pipes->sink) entregam tudo em ordem', async () => {
  const rnd = mulberry32(20261121);
  for (let iter = 0; iter < 12; iter++) {
    const count = 1 + Math.floor(rnd() * 20);
    const pipes = 1 + Math.floor(rnd() * 3);
    const overflow = rnd() < 0.5 ? 'block' : 'drop_newest';
    const nodes: FlowSpec['nodes'] = [
      { id: 'src', type: 'source.tone', params: { count } },
      ...Array.from({ length: pipes }, (_, i) => ({
        id: `p${i}`,
        type: 'pipe.delay',
        params: { delayMs: Math.floor(rnd() * 3) },
      })),
      { id: 'snk', type: 'sink.collect' },
    ];
    const edges: FlowSpec['edges'] = [
      { from: 'src.out', to: 'p0.in', capacity: 4096, overflow: 'block' },
      ...Array.from({ length: pipes - 1 }, (_, i) => ({
        from: `p${i}.out`,
        to: `p${i + 1}.in`,
        capacity: 4096,
        overflow: 'block' as const,
      })),
      { from: `p${pipes - 1}.out`, to: 'snk.phrase', capacity: 4096, overflow: 'block' },
    ];
    const collected = { received: [] as Array<{ seq: number; payload: unknown }> };
    const flow: FlowSpec = {
      version: 1,
      stopWhenSourcesDone: true,
      nodes,
      edges,
      bindings: { snk: { __collect: collected } },
    };
    const rg = await runGraph(flow, reg() as never);
    await rg.done;
    assert.equal(collected.received.length, count, `iter ${iter}: perderam-se mensagens (overflow ${overflow})`);
    assert.deepEqual(
      collected.received.map((m) => m.payload),
      Array.from({ length: count }, (_, i) => `tone-${i + 1}`),
      `iter ${iter}: ordem/conteúdo divergiu`,
    );
    assert.deepEqual(collected.received.map((m) => m.seq), [...collected.received.map((m) => m.seq)].sort((a, b) => a - b));
    const snap = rg.snapshot();
    assert.equal(snap.nodes.snk.errored, false);
    assert.equal(snap.nodes.src.errored, false);
  }
});
