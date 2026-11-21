// falador-graph — testes da porta bidirecional 'tool' e ToolProvider (ADR-008 Fase 1)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GraphError,
  createRegistry,
  registryToMap,
  runGraph,
  validateFlow,
  type FlowSpec,
  type NodeTypeDef,
  type ToolCallResult,
  type ToolDef,
  type ToolProvider,
} from '../src/index.ts';

function makeToolProviderNode(
  type: string,
  toolName: string,
  handler: (args: Record<string, unknown>, opts: { signal: AbortSignal; runId: string; callerNodeId: string }) => Promise<ToolCallResult> | ToolCallResult,
): NodeTypeDef {
  return {
    type,
    inputs: [],
    outputs: [{ name: 'tool', type: 'tool', required: false }],
    create: (ctx) => {
      const toolDef: ToolDef = {
        name: toolName,
        description: `Tool ${toolName} do nó ${ctx.id}`,
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        readonly: true,
        sourceNodeId: ctx.id,
      };
      const toolProvider: ToolProvider = {
        listTools: () => [toolDef],
        invoke: async (name, args, opts) => {
          if (name !== toolName) {
            return { ok: false, output: `tool desconhecida: ${name}`, durationMs: 0 };
          }
          return await handler(args, opts);
        },
      };
      return {
        toolProvider,
        async start() {},
        async onInput() {},
        async stop() {},
      };
    },
  };
}

function makePhraseSource(type: string, items: string[]): NodeTypeDef {
  return {
    type,
    sourceOnly: true,
    inputs: [],
    outputs: [{ name: 'out', type: 'phrase', required: false }],
    create: (ctx) => ({
      async start() {
        for (const text of items) {
          await ctx.emit('out', { text });
        }
      },
      async onInput() {},
      async stop() {},
    }),
  };
}

test('T1: 2 provedores conectados à mesma porta tools (in-degree=2); consumidor lista e invoca ambas na ordem', async () => {
  const listedTools: ToolDef[] = [];
  const invokedResults: ToolCallResult[] = [];
  const callerIds: string[] = [];

  const reg = createRegistry();
  reg.register(makePhraseSource('src.phrase', ['diagnosticar servidor']));
  reg.register(
    makeToolProviderNode('prov.a', 'tool_a', (args, opts) => {
      callerIds.push(opts.callerNodeId);
      return { ok: true, output: `A:${String(args.q)}`, exitCode: 0, dryRun: false, durationMs: 3 };
    }),
  );
  reg.register(
    makeToolProviderNode('prov.b', 'tool_b', (args, opts) => {
      callerIds.push(opts.callerNodeId);
      return { ok: true, output: `B:${String(args.q)}`, exitCode: 0, dryRun: true, durationMs: 5 };
    }),
  );
  reg.register({
    type: 'agent.mock',
    sink: true,
    inputs: [
      { name: 'in', type: 'phrase' },
      { name: 'tools', type: 'tool', required: false },
    ],
    outputs: [],
    create: (ctx) => ({
      async start() {},
      async onInput(port, msg) {
        if (port !== 'in') return;
        const providers = ctx.getTools?.('tools') ?? [];
        assert.equal(providers.length, 2);
        const q = (msg.payload as { text: string }).text;
        for (const provider of providers) {
          const defs = await provider.listTools();
          for (const d of defs) {
            listedTools.push(d);
            const res = await provider.invoke(d.name, { q }, {
              signal: ctx.signal,
              runId: 'test-run-1',
              callerNodeId: ctx.id,
            });
            invokedResults.push(res);
          }
        }
      },
      async stop() {},
    }),
  });

  const flow: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'src.phrase' },
      { id: 'p1', type: 'prov.a' },
      { id: 'p2', type: 'prov.b' },
      { id: 'agente', type: 'agent.mock' },
    ],
    edges: [
      { from: 'src.out', to: 'agente.in' },
      { from: 'p1.tool', to: 'agente.tools' },
      { from: 'p2.tool', to: 'agente.tools' },
    ],
  };

  const rg = await runGraph(flow, reg);
  await rg.done;

  assert.deepEqual(
    listedTools.map((t) => `${t.sourceNodeId}:${t.name}`),
    ['p1:tool_a', 'p2:tool_b'],
  );
  assert.deepEqual(
    invokedResults.map((r) => ({ ok: r.ok, output: r.output, dryRun: r.dryRun })),
    [
      { ok: true, output: 'A:diagnosticar servidor', dryRun: false },
      { ok: true, output: 'B:diagnosticar servidor', dryRun: true },
    ],
  );
  assert.deepEqual(callerIds, ['agente', 'agente']);
});

test('T2: provedor com enabled: false é ignorado em ctx.getTools(tools)', async () => {
  const seenNames: string[] = [];

  const reg = createRegistry();
  reg.register(makePhraseSource('src.phrase', ['ping']));
  reg.register(makeToolProviderNode('prov.a', 'tool_a', () => ({ ok: true, output: 'A', durationMs: 1 })));
  reg.register(makeToolProviderNode('prov.b', 'tool_b', () => ({ ok: true, output: 'B', durationMs: 1 })));
  reg.register({
    type: 'agent.mock',
    sink: true,
    inputs: [
      { name: 'in', type: 'phrase' },
      { name: 'tools', type: 'tool', required: false },
    ],
    outputs: [],
    create: (ctx) => ({
      async start() {},
      async onInput() {
        const providers = ctx.getTools?.('tools') ?? [];
        for (const p of providers) {
          for (const d of await p.listTools()) seenNames.push(d.name);
        }
      },
      async stop() {},
    }),
  });

  const flow: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'src.phrase' },
      { id: 'p1', type: 'prov.a', enabled: false },
      { id: 'p2', type: 'prov.b' },
      { id: 'agente', type: 'agent.mock' },
    ],
    edges: [
      { from: 'src.out', to: 'agente.in' },
      { from: 'p1.tool', to: 'agente.tools' },
      { from: 'p2.tool', to: 'agente.tools' },
    ],
  };

  const rg = await runGraph(flow, reg);
  await rg.done;

  assert.deepEqual(seenNames, ['tool_b']);
});

test('T3: conectar phrase em tool (ou tool em phrase) é rejeitado com PORT_TYPE_MISMATCH', () => {
  const reg = createRegistry();
  reg.register(makePhraseSource('src.phrase', ['x']));
  reg.register(makeToolProviderNode('prov.a', 'tool_a', () => ({ ok: true, output: 'ok', durationMs: 0 })));
  reg.register({
    type: 'agent.mock',
    sink: true,
    inputs: [
      { name: 'in', type: 'phrase' },
      { name: 'tools', type: 'tool', required: false },
    ],
    outputs: [],
    create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
  });

  // phrase -> tool
  assert.throws(
    () =>
      validateFlow(
        {
          version: 1,
          nodes: [
            { id: 'src', type: 'src.phrase' },
            { id: 'agente', type: 'agent.mock' },
          ],
          edges: [{ from: 'src.out', to: 'agente.tools' }],
        },
        registryToMap(reg),
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'PORT_TYPE_MISMATCH',
  );

  // tool -> phrase
  assert.throws(
    () =>
      validateFlow(
        {
          version: 1,
          nodes: [
            { id: 'p1', type: 'prov.a' },
            { id: 'agente', type: 'agent.mock' },
          ],
          edges: [{ from: 'p1.tool', to: 'agente.in' }],
        },
        registryToMap(reg),
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'PORT_TYPE_MISMATCH',
  );
});

test('T4: portas não-tool (phrase, tokens_parcial) continuam rejeitando in-degree > 1 (Spec V2)', () => {
  const reg = createRegistry();
  reg.register(makePhraseSource('src.phrase', ['a']));
  reg.register({
    type: 'src.tokens',
    sourceOnly: true,
    inputs: [],
    outputs: [{ name: 'out', type: 'tokens_parcial', required: false }],
    create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
  });
  reg.register({
    type: 'sink.phrase',
    sink: true,
    inputs: [{ name: 'in', type: 'phrase' }],
    outputs: [],
    create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
  });
  reg.register({
    type: 'sink.tokens',
    sink: true,
    inputs: [{ name: 'in', type: 'tokens_parcial' }],
    outputs: [],
    create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
  });

  // phrase in-degree = 2
  assert.throws(
    () =>
      validateFlow(
        {
          version: 1,
          nodes: [
            { id: 's1', type: 'src.phrase' },
            { id: 's2', type: 'src.phrase' },
            { id: 'k', type: 'sink.phrase' },
          ],
          edges: [
            { from: 's1.out', to: 'k.in' },
            { from: 's2.out', to: 'k.in' },
          ],
        },
        registryToMap(reg),
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'IN_DEGREE_EXCEEDED',
  );

  // tokens_parcial in-degree = 2
  assert.throws(
    () =>
      validateFlow(
        {
          version: 1,
          nodes: [
            { id: 't1', type: 'src.tokens' },
            { id: 't2', type: 'src.tokens' },
            { id: 'k', type: 'sink.tokens' },
          ],
          edges: [
            { from: 't1.out', to: 'k.in' },
            { from: 't2.out', to: 'k.in' },
          ],
        },
        registryToMap(reg),
      ),
    (err: unknown) => err instanceof GraphError && err.code === 'IN_DEGREE_EXCEEDED',
  );
});

test('T5: grafo com stopWhenSourcesDone: true + nó provedor tool (sem entrada) termina naturalmente quando a fonte principal termina', async () => {
  let providerStarted = false;
  let providerStopped = false;
  const outputs: string[] = [];

  const reg = createRegistry();
  reg.register(makePhraseSource('src.phrase', ['msg-1', 'msg-2']));
  reg.register({
    type: 'prov.tool',
    // propositalmente sem sourceOnly e sem entradas (como rag.search / tool.mcp)
    inputs: [],
    outputs: [{ name: 'tool', type: 'tool', required: false }],
    create: (ctx) => ({
      toolProvider: {
        listTools: () => [
          {
            name: 'ping',
            description: 'ping tool',
            parameters: { type: 'object' },
            sourceNodeId: ctx.id,
          },
        ],
        invoke: async (_name, args) => ({ ok: true, output: `pong:${String(args.text)}`, durationMs: 1 }),
      },
      async start() {
        providerStarted = true;
      },
      async onInput() {},
      async stop() {
        providerStopped = true;
      },
    }),
  });
  reg.register({
    type: 'agent.mock',
    sink: true,
    inputs: [
      { name: 'in', type: 'phrase' },
      { name: 'tools', type: 'tool', required: false },
    ],
    outputs: [],
    create: (ctx) => ({
      async start() {},
      async onInput(_port, msg) {
        const [p] = ctx.getTools?.('tools') ?? [];
        assert.ok(p);
        const res = await p.invoke('ping', msg.payload as Record<string, unknown>, {
          signal: ctx.signal,
          runId: 'run-t5',
          callerNodeId: ctx.id,
        });
        outputs.push(res.output);
      },
      async stop() {},
    }),
  });

  const flow: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'src.phrase' },
      { id: 'prov', type: 'prov.tool' },
      { id: 'agente', type: 'agent.mock' },
    ],
    edges: [
      { from: 'src.out', to: 'agente.in' },
      { from: 'prov.tool', to: 'agente.tools' },
    ],
  };

  const rg = await runGraph(flow, reg);
  await Promise.race([
    rg.done,
    new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error('timeout aguardando parada natural (stopWhenSourcesDone)')), 2000);
      t.unref();
    }),
  ]);

  assert.equal(providerStarted, true);
  assert.equal(providerStopped, true);
  assert.deepEqual(outputs, ['pong:msg-1', 'pong:msg-2']);
  const events = rg.eventsSnapshot();
  assert.ok(events.some((e) => e.type === 'run_stopped' && e.reason === 'fontes esgotadas'));
});
