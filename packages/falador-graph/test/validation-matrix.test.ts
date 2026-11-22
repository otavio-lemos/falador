// falador-graph — matriz de validação V0..V7 (Spec v1.1 §3)
// Cada código de GraphError tem um caso positivo e negativo; o formato do erro
// (code/path/message) é contrato para o host (web-server) e para a UI.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRegistry,
  registryToMap,
  validateFlow,
  GraphError,
  sourceTone,
  pipeDelay,
  pipeParcs,
  sinkCollect,
  type FlowSpec,
  type NodeTypeDef,
} from '../src/index.ts';

const reqOut: NodeTypeDef = {
  type: 'test.reqout',
  paramNames: [],
  inputs: [{ name: 'in', type: 'phrase' }],
  outputs: [{ name: 'out', type: 'phrase' }], // required default = true
  create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
};

const badSink: NodeTypeDef = {
  type: 'test.badsink',
  sink: true,
  paramNames: [],
  inputs: [{ name: 'in', type: 'phrase' }],
  outputs: [{ name: 'out', type: 'phrase', required: false }], // sink não pode ter saídas
  create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
};

const toolSrc: NodeTypeDef = {
  type: 'test.toolsrc',
  sourceOnly: true,
  paramNames: [],
  inputs: [],
  outputs: [{ name: 'out', type: 'tool', required: false }],
  create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
};

const toolSink: NodeTypeDef = {
  type: 'test.toolsink',
  sink: true,
  paramNames: [],
  inputs: [{ name: 'tool', type: 'tool' }],
  outputs: [],
  create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
};

const map = () => registryToMap(reg());

function reg() {
  return createRegistry()
    .register(sourceTone)
    .register(pipeDelay)
    .register(pipeParcs)
    .register(sinkCollect)
    .register(reqOut)
    .register(badSink)
    .register(toolSrc)
    .register(toolSink);
}

const collect = () => ({ received: [] as Array<{ payload: unknown }> });

/** flow mínimo válido: src -> p -> snk */
function okFlow(over: Partial<FlowSpec> = {}): FlowSpec {
  return {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 1 } },
      { id: 'p', type: 'pipe.delay' },
      { id: 'snk', type: 'sink.collect' },
    ],
    edges: [
      { from: 'src.out', to: 'p.in' },
      { from: 'p.out', to: 'snk.phrase' },
    ],
    bindings: { snk: { __collect: collect() } },
    ...over,
  };
}

function codeOf(raw: FlowSpec): { code: string; path: string; message: string } {
  try {
    validateFlow(raw, map());
  } catch (e) {
    assert.ok(e instanceof GraphError, `esperava GraphError, veio ${String(e)}`);
    return { code: e.code, path: e.path, message: e.message };
  }
  assert.fail('validateFlow aceitou fluxo inválido');
}

test('V0/V1 — cabeçalho: versão e arrays', () => {
  assert.equal(codeOf({ ...okFlow(), version: 2 }).code, 'SPEC_VERSION_UNSUPPORTED');
  assert.equal(
    codeOf({ ...okFlow(), nodes: 'x' as unknown as FlowSpec['nodes'] }).code,
    'SPEC_MALFORMED',
  );
  assert.equal(
    codeOf({ ...okFlow(), edges: null as unknown as FlowSpec['edges'] }).code,
    'SPEC_MALFORMED',
  );
});

test('V0 — id de nó: duplicado e charset', () => {
  const dup = okFlow();
  dup.nodes.push({ id: 'src', type: 'source.tone' });
  assert.equal(codeOf(dup).code, 'DUPLICATE_NODE_ID');

  for (const id of ['a.b', 'a b', 'a/b', 'a:b', '', 'ç']) {
    const f = okFlow();
    f.nodes.push({ id, type: 'source.tone' });
    const err = codeOf(f);
    assert.equal(err.code, 'INVALID_NODE_ID', `id ${JSON.stringify(id)} deveria ser inválido`);
  }
  // charset aceito: letras, dígitos, _ e -
  const f = okFlow();
  f.nodes.push({ id: 'A_9-z', type: 'source.tone', params: { count: 1 } });
  assert.doesNotThrow(() => validateFlow(f, map()));
});

test('V0 — tipo desconhecido e params estritos', () => {
  const f = okFlow();
  f.nodes.push({ id: 'u', type: 'nao.existe' });
  assert.equal(codeOf(f).code, 'UNKNOWN_NODE_TYPE');

  const unk = okFlow();
  unk.nodes[0].params = { count: 1, bogus: true };
  const e = codeOf(unk);
  assert.equal(e.code, 'UNKNOWN_PARAM');
  assert.match(e.path, /nodes\[src\]\.params\.bogus/);
});

test('V5 — validateParams do nó propaga code/path/message', () => {
  const f = okFlow();
  f.nodes[0].params = { count: 1.5 };
  const e = codeOf(f);
  assert.equal(e.code, 'INVALID_PARAM');
  assert.match(e.path, /^nodes\[src\]\.params\.count/);
  assert.match(e.message, /inteiro/);

  const neg = okFlow();
  neg.nodes[0].params = { count: -3 };
  assert.equal(codeOf(neg).code, 'INVALID_PARAM');
});

test('V7 — bindings: desconhecido e obrigatório ausente', () => {
  const unk = okFlow({ bindings: { snk: { __collect: collect(), extra: 1 } } });
  assert.equal(codeOf(unk).code, 'UNKNOWN_BINDING');

  const missing = okFlow({ bindings: {} });
  const e = codeOf(missing);
  assert.equal(e.code, 'MISSING_BINDING');
  assert.match(e.path, /bindings\.snk\.__collect/);
});

test('edges — referência malformada, nós e portas inexistentes, tipo incompatível', () => {
  const noDot = okFlow();
  noDot.edges[0] = { from: 'src', to: 'p.in' };
  assert.equal(codeOf(noDot).code, 'INVALID_EDGE_REF');

  const ghostFrom = okFlow();
  ghostFrom.edges[0] = { from: 'ghost.out', to: 'p.in' };
  assert.equal(codeOf(ghostFrom).code, 'UNKNOWN_NODE');

  const ghostTo = okFlow();
  ghostTo.edges[1] = { from: 'p.out', to: 'ghost.in' };
  assert.equal(codeOf(ghostTo).code, 'UNKNOWN_NODE');

  // from/to não-string precisa virar GraphError, não TypeError (bug corrigido 2026-11-21)
  for (const bad of [null, undefined, 42, {}, true]) {
    const f = okFlow();
    f.edges[0] = { from: bad as unknown as string, to: 'p.in' };
    const err = codeOf(f);
    assert.equal(err.code, 'INVALID_EDGE_REF', `from ${String(bad)} deveria ser INVALID_EDGE_REF`);

    const g = okFlow();
    g.edges[1] = { from: 'p.out', to: bad as unknown as string };
    assert.equal(codeOf(g).code, 'INVALID_EDGE_REF', `to ${String(bad)} deveria ser INVALID_EDGE_REF`);
  }

  const badOut = okFlow();
  badOut.edges[0] = { from: 'src.nope', to: 'p.in' };
  const e1 = codeOf(badOut);
  assert.equal(e1.code, 'UNKNOWN_PORT');
  assert.match(e1.message, /SAÍDA/);

  const badIn = okFlow();
  badIn.edges[0] = { from: 'src.out', to: 'p.nope' };
  const e2 = codeOf(badIn);
  assert.equal(e2.code, 'UNKNOWN_PORT');
  assert.match(e2.message, /ENTRADA/);

  const mismatch = okFlow();
  mismatch.edges[1] = { from: 'p.out', to: 'snk.pcm' };
  const e3 = codeOf(mismatch);
  assert.equal(e3.code, 'PORT_TYPE_MISMATCH');
  assert.match(e3.message, /phrase → pcm16k/);
});

test('edges — capacity/overflow/ttl/blockTimeout fora de faixa', () => {
  for (const capacity of [0, -1, 1.5, 4097, Number.NaN]) {
    const f = okFlow();
    f.edges[0] = { from: 'src.out', to: 'p.in', capacity };
    assert.equal(codeOf(f).code, 'INVALID_CAPACITY', `capacity ${String(capacity)}`);
  }
  const pol = okFlow();
  pol.edges[0] = { from: 'src.out', to: 'p.in', overflow: 'drop_all' as never };
  assert.equal(codeOf(pol).code, 'INVALID_POLICY');

  // NaN/±Infinity não são TTL válido: com NaN as comparações de expiração seriam
  // sempre falsas e a mensagem nunca expiraria (bug corrigido em 2026-11-21).
  for (const ttlMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const f = okFlow();
    f.edges[0] = { from: 'src.out', to: 'p.in', ttlMs };
    assert.equal(codeOf(f).code, 'INVALID_TTL', `ttlMs ${String(ttlMs)} deveria ser inválido`);
  }
  for (const blockTimeoutMs of [0, -5, Number.POSITIVE_INFINITY]) {
    const f = okFlow();
    f.edges[0] = { from: 'src.out', to: 'p.in', blockTimeoutMs };
    assert.equal(codeOf(f).code, 'INVALID_BLOCK_TIMEOUT', `bt ${String(blockTimeoutMs)}`);
  }
});

test('edges — defaults declarados (capacity 64, drop_oldest, block 30s)', () => {
  const v = validateFlow(okFlow(), map());
  for (const e of v.edges) {
    assert.equal(e.capacity, 64);
    assert.equal(e.overflow, 'drop_oldest');
    assert.equal(e.blockTimeoutMs, 30_000);
    assert.equal(e.ttlMs, undefined);
  }
});

test('V2 — in-degree 1 por porta, com exceção de porta tool', () => {
  const twoIn = okFlow();
  twoIn.nodes.push({ id: 'src2', type: 'source.tone', params: { count: 1 } });
  twoIn.edges.push({ from: 'src2.out', to: 'p.in' });
  const e = codeOf(twoIn);
  assert.equal(e.code, 'IN_DEGREE_EXCEEDED');
  assert.match(e.path, /p\.in/);

  // porta tool aceita múltiplos provedores (ADR-008) — sem ciclo no DAG
  const toolFlow: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'a', type: 'test.toolsrc' },
      { id: 'b', type: 'test.toolsrc' },
      { id: 'sink', type: 'test.toolsink' },
    ],
    edges: [
      { from: 'a.out', to: 'sink.tool' },
      { from: 'b.out', to: 'sink.tool' },
    ],
  };
  assert.doesNotThrow(() => validateFlow(toolFlow, map()));
});

test('V6 — nó desconectado, porta required morta, sink com saída', () => {
  const loose = okFlow();
  loose.nodes.push({ id: 'orphan', type: 'pipe.delay' });
  const e1 = codeOf(loose);
  assert.equal(e1.code, 'DISCONNECTED_NODE');

  const dead: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 1 } },
      { id: 'r', type: 'test.reqout' },
    ],
    edges: [{ from: 'src.out', to: 'r.in' }],
  };
  const e2 = codeOf(dead);
  assert.equal(e2.code, 'DEAD_OUTPUT_PORT');
  assert.match(e2.path, /nodes\[r\]\.out/);

  const badSinkFlow: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 1 } },
      { id: 'bs', type: 'test.badsink' },
    ],
    edges: [{ from: 'src.out', to: 'bs.in' }],
  };
  assert.equal(codeOf(badSinkFlow).code, 'SINK_WITH_OUTPUTS');
});

test('V3 — ciclo relatado com os nós envolvidos', () => {
  // ciclo puro a <-> b: cada um com exatamente 1 entrada (não é IN_DEGREE);
  // componente separado do caminho src -> snk.
  const cyc: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 1 } },
      { id: 'a', type: 'pipe.delay' },
      { id: 'b', type: 'pipe.delay' },
      { id: 'snk', type: 'sink.collect' },
    ],
    edges: [
      { from: 'src.out', to: 'snk.phrase' },
      { from: 'a.out', to: 'b.in' },
      { from: 'b.out', to: 'a.in' },
    ],
    bindings: { snk: { __collect: collect() } },
  };
  const e = codeOf(cyc);
  assert.equal(e.code, 'CYCLE');
  assert.match(e.message, /a/);
  assert.match(e.message, /b/);
});

test('enabled:false remove o nó E as edges dele; edges órfãs desaparecem', () => {
  const f = okFlow();
  f.nodes.push({ id: 'off', type: 'pipe.delay', enabled: false });
  f.edges.push({ from: 'p.out', to: 'off.in' });
  // p.out continua usado pela edge p->snk; off.in some sem gerar UNKNOWN_NODE
  const v = validateFlow(f, map());
  assert.deepEqual([...v.nodes.keys()].sort(), ['p', 'snk', 'src']);
  assert.equal(v.edges.length, 2);
  assert.equal(v.topoOrder.length, 3);
});

test('outputsFor: portas dinâmicas entram na validação e no in-degree', () => {
  const dyn: NodeTypeDef = {
    type: 'test.dyn',
    paramNames: ['options'],
    inputs: [{ name: 'in', type: 'phrase' }],
    outputs: [],
    outputsFor: (p) =>
      ((p.options as string[] | undefined) ?? []).map((o) => ({
        name: o,
        type: 'phrase' as const,
        required: false,
      })),
    create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
  };
  const registry = reg().register(dyn);
  const f: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'source.tone', params: { count: 1 } },
      { id: 'd', type: 'test.dyn', params: { options: ['auto', 'humano'] } },
      { id: 'a', type: 'sink.collect' },
      { id: 'h', type: 'sink.collect' },
    ],
    edges: [
      { from: 'src.out', to: 'd.in' },
      { from: 'd.auto', to: 'a.phrase' },
      { from: 'd.humano', to: 'h.phrase' },
    ],
    bindings: { a: { __collect: collect() }, h: { __collect: collect() } },
  };
  const v = validateFlow(f, registryToMap(registry));
  assert.equal(v.edges.length, 3);
  // porta dinâmica inexistente é UNKNOWN_PORT
  const bad = structuredClone(f);
  bad.edges[1] = { from: 'd.manual', to: 'a.phrase' };
  assert.throws(
    () => validateFlow(bad, registryToMap(registry)),
    (err: unknown) => err instanceof GraphError && err.code === 'UNKNOWN_PORT',
  );
});

test('mensagem do GraphError é autoexplicativa (código + caminho + motivo)', () => {
  const f = okFlow();
  f.nodes[0].params = { count: 1.5 };
  try {
    validateFlow(f, map());
  } catch (e) {
    assert.ok(e instanceof GraphError);
    assert.match(e.message, /^INVALID_PARAM @ nodes\[src\]\.params\.count: /);
    assert.equal(e.name, 'GraphError');
  }
});
