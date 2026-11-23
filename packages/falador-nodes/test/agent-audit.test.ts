// falador-nodes — testes do agent.tools auditado (ADR-012): update_plan, trilha de auditoria,
// conclusão via avaliador independente + gate humano final. Zero deps, mocks HTTP reais.
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createRegistry,
  runGraph,
  type ControlMsg,
  type Envelope,
  type FlowSpec,
  type NodeTypeDef,
  type ToolCallResult,
  type ToolProvider,
} from '../../falador-graph/src/index.ts';
import { agentTools, type AgentGateMeta } from '../src/agent-tools.ts';
import type { AuditEvent } from '../src/audit.ts';

// ---- helpers ---------------------------------------------------------------

function httpServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const VALID_VALIDATION = '{"achieved":true,"confidence":0.9,"gaps":[],"nextActions":[]}';

interface LlmMock {
  url: string;
  bodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Mock do omlx: executor (model 'exec-model') e validador (model 'val-model' ou default LFM3) por fila. */
async function mockLlm(opts: {
  executor: Array<Record<string, unknown>>;
  validator?: Array<string>;
  d1?: 'seguro' | 'sensivel';
}): Promise<LlmMock> {
  const bodies: Array<Record<string, unknown>> = [];
  const execQ = [...opts.executor];
  const valQ = [...(opts.validator ?? [VALID_VALIDATION])];
  const srv = await httpServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('/v1/systemone')) {
      res.end(JSON.stringify({ answers: { risk: { choice: opts.d1 ?? 'sensivel' } } }));
      return;
    }
    const parsed = JSON.parse(body) as Record<string, unknown>;
    bodies.push(parsed);
    const model = String(parsed.model ?? '');
    if (model !== 'exec-model') {
      const content = valQ.shift() ?? 'sem resposta do validador';
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      return;
    }
    const next = execQ.shift() ?? { choices: [{ message: { role: 'assistant', content: '(fila esgotada)' } }] };
    res.end(JSON.stringify(next));
  });
  return { url: srv.url, bodies, close: srv.close };
}

let callSeq = 0;
function toolCallResp(name: string, args: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: `c${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}
function finalResp(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }] };
}

const PLAN_ITEM = { id: '1', description: 'Verificar disco', verification: 'df -h < 90%', status: 'pending' };
const PLAN_VERIFIED = { ...PLAN_ITEM, status: 'verified', evidence: 'df -h: 45%' };

interface GateMock {
  requests: Array<{ text: string; meta?: AgentGateMeta }>;
  holder: { request(text: string, meta?: AgentGateMeta): Promise<string | null>; cancel(reason?: string): void };
}
function makeGate(responses: Array<string | null>, opts: { hang?: boolean } = {}): GateMock {
  const requests: GateMock['requests'] = [];
  const queue = [...responses];
  let pendingResolve: ((v: string | null) => void) | null = null;
  return {
    requests,
    holder: {
      request(text, meta) {
        requests.push({ text, meta });
        if (opts.hang) return new Promise<string | null>((r) => { pendingResolve = r; });
        return Promise.resolve(queue.length > 0 ? queue.shift()! : null);
      },
      cancel() { pendingResolve?.(null); pendingResolve = null; },
    },
  };
}

function mockToolNode(type: string, toolName: string, result: Partial<ToolCallResult> & { meta?: Record<string, unknown> }, spy?: { calls: number }): NodeTypeDef {
  const provider: ToolProvider = {
    listTools: () => [{
      name: toolName, description: `mock ${toolName}`, readonly: false,
      parameters: { type: 'object', properties: { command: { type: 'string' }, query: { type: 'string' } } },
      sourceNodeId: type,
    }],
    async invoke(): Promise<ToolCallResult> {
      if (spy) spy.calls++;
      return { ok: true, output: 'mock output', durationMs: 5, ...result };
    },
  };
  return {
    type, sourceOnly: true, inputs: [],
    outputs: [{ name: 'tool', type: 'tool', required: false }],
    create: () => ({ toolProvider: provider, async start() {}, async onInput() {}, async stop() {} }),
  };
}

function manualSource(): { def: NodeTypeDef; emit: (text: string) => Promise<void>; interrupt: () => void } {
  let emitFn: ((port: string, payload: unknown) => Promise<void>) | null = null;
  let ctrlFn: ((port: string, c: ControlMsg) => void) | null = null;
  const def: NodeTypeDef = {
    type: 'test.source', sourceOnly: true, inputs: [],
    outputs: [{ name: 'phrase', type: 'phrase', required: false }],
    create: (ctx) => {
      emitFn = (port, payload) => ctx.emit(port, payload);
      ctrlFn = (port, c) => ctx.emitControl(port, c);
      return { async start() {}, async onInput() {}, async stop() {} };
    },
  };
  return {
    def,
    emit: async (text) => { if (!emitFn) throw new Error('source não iniciado'); await emitFn('phrase', text); },
    interrupt: () => ctrlFn?.('phrase', { kind: 'interrupt', sourceNode: 'test.source', reason: 'teste' }),
  };
}

function collectSink(received: Envelope[]): NodeTypeDef {
  return {
    type: 'test.collect', sink: true,
    inputs: [{ name: 'in', type: 'tokens_parcial' }], outputs: [],
    create: () => ({
      async start() {},
      async onInput(_p, msg) { if (!msg.control) received.push(msg); },
      async stop() {},
    }),
  };
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 15));
  }
}

interface Harness {
  audits: AuditEvent[];
  received: Envelope[];
  src: ReturnType<typeof manualSource>;
  rg: Awaited<ReturnType<typeof runGraph>>;
  stop(): Promise<void>;
}

async function harness(o: {
  llm: LlmMock;
  agentParams?: Record<string, unknown>;
  gate?: GateMock;
  tools?: NodeTypeDef[];
}): Promise<Harness> {
  const audits: AuditEvent[] = [];
  const received: Envelope[] = [];
  const src = manualSource();
  const reg = createRegistry().register(src.def).register(agentTools).register(collectSink(received));
  for (const t of o.tools ?? []) reg.register(t);
  const nodes: FlowSpec['nodes'] = [
    { id: 'src', type: 'test.source' },
    {
      id: 'agente', type: 'agent.tools',
      params: { baseUrl: o.llm.url, model: 'exec-model', maxSteps: 5, approvalPolicy: 'always', ...(o.agentParams ?? {}) },
    },
    { id: 'snk', type: 'test.collect' },
  ];
  const edges: FlowSpec['edges'] = [
    { from: 'src.phrase', to: 'agente.in' },
    { from: 'agente.out', to: 'snk.in' },
  ];
  for (const t of o.tools ?? []) {
    const toolNodeId = t.type.replace(/\./g, '-');
    nodes.push({ id: toolNodeId, type: t.type });
    edges.push({ from: `${toolNodeId}.tool`, to: 'agente.tools' });
  }
  const bindings: Record<string, Record<string, unknown>> = {
    agente: { __onAudit: (ev: AuditEvent) => audits.push(ev) },
  };
  if (o.gate) bindings.agente.__gate = o.gate.holder;
  const flow: FlowSpec = { version: 1, stopWhenSourcesDone: false, nodes, edges, bindings };
  const rg = await runGraph(flow, reg);
  return { audits, received, src, rg, stop: () => rg.stop('fim do teste') };
}

// ---- testes ----------------------------------------------------------------

test('update_plan está nas tools enviadas ao LLM, grava plano, emite audit plan e NÃO abre gate', async () => {
  const llm = await mockLlm({
    executor: [toolCallResp('update_plan', { items: [PLAN_VERIFIED] }), finalResp('concluído')],
    validator: [VALID_VALIDATION],
  });
  const gate = makeGate(['aprovo']);
  const h = await harness({ llm, gate, agentParams: { validatorModel: 'val-model' } });
  try {
    await h.src.emit('objetivo: verificar disco');
    await waitFor(() => h.received.length > 0);
    const firstTools = (llm.bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    assert.ok(firstTools.includes('update_plan'), 'update_plan deve estar nas tools');
    const planAudits = h.audits.filter((a) => a.op === 'plan');
    assert.equal(planAudits.length, 1);
    assert.equal(planAudits[0].plan?.[0].status, 'verified');
    // gate chamado SÓ para a confirmação final, nunca para update_plan
    assert.equal(gate.requests.length, 1);
    assert.equal(gate.requests[0].meta?.tool, 'goal.confirm');
  } finally { await h.stop(); await llm.close(); }
});

test('update_plan com itens malformados devolve erro e mantém plano anterior intacto', async () => {
  const llm = await mockLlm({
    executor: [
      toolCallResp('update_plan', { items: [PLAN_VERIFIED] }),
      toolCallResp('update_plan', { items: [{ ...PLAN_ITEM, status: 'done' }] }),
      finalResp('concluído'),
    ],
    validator: [VALID_VALIDATION],
  });
  const gate = makeGate(['aprovo']);
  const h = await harness({ llm, gate, agentParams: { validatorModel: 'val-model' } });
  try {
    await h.src.emit('objetivo: x');
    await waitFor(() => h.received.length > 0);
    const planAudits = h.audits.filter((a) => a.op === 'plan');
    assert.equal(planAudits.length, 1, 'plano inválido não gera audit nem sobrescreve');
    assert.equal(planAudits[0].plan?.[0].id, '1');
    const toolMsgs = (llm.bodies[2].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool');
    assert.ok(toolMsgs.some((m) => m.content.includes('ok="false"') && /status/i.test(m.content)), 'erro devolvido ao LLM');
  } finally { await h.stop(); await llm.close(); }
});

test('exec aprovado: audit tool_call com gate approved, ok, exitCode, risk d1 e preview', async () => {
  const spy = { calls: 0 };
  const llm = await mockLlm({
    executor: [toolCallResp('exec_local', { command: 'uptime' }), finalResp('feito')],
    d1: 'seguro',
  });
  const gate = makeGate(['']); // string vazia = aprova sem editar (semântica do applyGateEdit)
  const h = await harness({
    llm, gate,
    agentParams: { d1Model: 'd1-test', approvalPolicy: 'always' },
    tools: [mockToolNode('test.exec', 'exec_local', { ok: true, output: 'up 3 days', exitCode: 0, dryRun: false, meta: { host: 'srv1', transport: 'ssh' } }, spy)],
  });
  try {
    await h.src.emit('objetivo: checar servidor');
    await waitFor(() => h.received.length > 0);
    assert.equal(spy.calls, 1);
    const tc = h.audits.find((a) => a.op === 'tool_call' && a.tool === 'exec_local');
    assert.ok(tc, 'audit tool_call existe');
    assert.equal(tc?.gate, 'approved');
    assert.equal(tc?.ok, true);
    assert.equal(tc?.exitCode, 0);
    assert.equal(tc?.risk, 'seguro');
    assert.equal(tc?.host, 'srv1');
    assert.equal(tc?.transport, 'ssh');
    assert.ok(tc?.outputPreview?.includes('up 3 days'));
  } finally { await h.stop(); await llm.close(); }
});

test('exec rejeitado: audit gate rejected e ferramenta NÃO executa', async () => {
  const spy = { calls: 0 };
  const llm = await mockLlm({ executor: [toolCallResp('exec_local', { command: 'rm -rf /' }), finalResp('ok, parei')] });
  const gate = makeGate([null]);
  const h = await harness({
    llm, gate,
    tools: [mockToolNode('test.exec', 'exec_local', { ok: true }, spy)],
  });
  try {
    await h.src.emit('objetivo: x');
    await waitFor(() => h.received.length > 0);
    assert.equal(spy.calls, 0, 'rejeitado não executa');
    const tc = h.audits.find((a) => a.op === 'tool_call' && a.tool === 'exec_local');
    assert.equal(tc?.gate, 'rejected');
    assert.notEqual(tc?.ok, true);
  } finally { await h.stop(); await llm.close(); }
});

test('exec com comando editado no gate: audit gate edited e args finais refletem a edição', async () => {
  const llm = await mockLlm({ executor: [toolCallResp('exec_local', { command: 'uptime' }), finalResp('feito')] });
  const gate = makeGate(['uptime -p']); // texto simples em exec_* = edição do comando
  const h = await harness({
    llm, gate,
    tools: [mockToolNode('test.exec', 'exec_local', { ok: true, output: 'up 3 days', exitCode: 0 })],
  });
  try {
    await h.src.emit('objetivo: x');
    await waitFor(() => h.received.length > 0);
    const tc = h.audits.find((a) => a.op === 'tool_call' && a.tool === 'exec_local');
    assert.equal(tc?.gate, 'edited');
    assert.equal((tc?.args as { command?: string })?.command, 'uptime -p');
  } finally { await h.stop(); await llm.close(); }
});

test('RAG: audit tool_call carrega query/hits REAIS do meta do provider', async () => {
  const llm = await mockLlm({ executor: [toolCallResp('search_docs', { query: 'deploy nginx' }), finalResp('achei')] });
  const h = await harness({
    llm,
    agentParams: { approvalPolicy: 'never' },
    tools: [mockToolNode('test.rag', 'search_docs', { ok: true, output: 'trecho…', meta: { query: 'deploy nginx', hits: 2, chunkIds: ['a', 'b'] } })],
  });
  try {
    await h.src.emit('objetivo: consultar docs');
    await waitFor(() => h.received.length > 0);
    const tc = h.audits.find((a) => a.op === 'tool_call' && a.tool === 'search_docs');
    assert.deepEqual(tc?.rag, { query: 'deploy nginx', hits: 2, chunkIds: ['a', 'b'] });
  } finally { await h.stop(); await llm.close(); }
});

test('final com plano pendente: pendências realimentam o LLM e não conclui', async () => {
  const llm = await mockLlm({
    executor: [
      toolCallResp('update_plan', { items: [PLAN_ITEM] }),
      finalResp('já terminei'),
      finalResp('terminei de novo'),
    ],
  });
  const h = await harness({ llm, agentParams: { maxSteps: 3 } });
  try {
    await h.src.emit('objetivo: verificar disco');
    await waitFor(() => h.received.length > 0);
    const feedback = (llm.bodies[2].messages as Array<{ role: string; content: string }>)
      .some((m) => m.role === 'user' && m.content.includes('Verificar disco') && /pendente/i.test(m.content));
    assert.ok(feedback, 'LLM recebe a lista de pendências');
    const out = h.received[h.received.length - 1];
    assert.notEqual(out.meta?.goalAchieved, true);
    assert.equal(out.meta?.maxStepsReached, true);
    assert.equal(h.audits.filter((a) => a.op === 'goal_validation').length, 0, 'plano pendente nem chega ao validador');
    const fin = h.audits.find((a) => a.op === 'agent_final');
    assert.equal(fin?.maxStepsReached, true);
    assert.equal(fin?.goalAchieved, false);
  } finally { await h.stop(); await llm.close(); }
});

test('conclusão validada: avaliador achieved + gate final aprovado ⇒ goalAchieved + audits', async () => {
  const llm = await mockLlm({
    executor: [toolCallResp('update_plan', { items: [PLAN_VERIFIED] }), finalResp('OBJETIVO CONCLUÍDO')],
    validator: [VALID_VALIDATION],
  });
  const gate = makeGate(['aprovo']);
  const h = await harness({ llm, gate, agentParams: { validatorModel: 'val-model' } });
  try {
    await h.src.emit('objetivo: verificar disco');
    await waitFor(() => h.received.length > 0);
    const out = h.received[h.received.length - 1];
    assert.equal(out.meta?.goalAchieved, true);
    const gv = h.audits.find((a) => a.op === 'goal_validation');
    assert.equal(gv?.validation?.achieved, true);
    assert.equal(gv?.validation?.confidence, 0.9);
    const fin = h.audits.find((a) => a.op === 'agent_final');
    assert.equal(fin?.goalAchieved, true);
    assert.equal(gate.requests.length, 1);
    assert.equal(gate.requests[0].meta?.tool, 'goal.confirm');
    // o validador recebeu o plano e a evidência
    const valBody = llm.bodies.find((b) => b.model === 'val-model');
    assert.ok(valBody, 'chamada ao validador aconteceu');
    const valUser = (valBody?.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'user')?.content ?? '';
    assert.ok(valUser.includes('Verificar disco'));
  } finally { await h.stop(); await llm.close(); }
});

test('gate final rejeitado: não conclui e a rejeição realimenta o loop', async () => {
  const llm = await mockLlm({
    executor: [toolCallResp('update_plan', { items: [PLAN_VERIFIED] }), finalResp('concluído')],
    validator: [VALID_VALIDATION],
  });
  const gate = makeGate([null]);
  const h = await harness({ llm, gate, agentParams: { validatorModel: 'val-model', maxSteps: 2 } });
  try {
    await h.src.emit('objetivo: x');
    await waitFor(() => h.received.length > 0);
    const out = h.received[h.received.length - 1];
    assert.notEqual(out.meta?.goalAchieved, true);
    const synth = llm.bodies[llm.bodies.length - 1];
    const msgs = synth.messages as Array<{ role: string; content: string }>;
    assert.ok(msgs.some((m) => m.role === 'user' && /rejeitou/i.test(m.content)), 'rejeição realimentada');
  } finally { await h.stop(); await llm.close(); }
});

test('validador retorna lixo: fail-closed, não conclui sozinho', async () => {
  const llm = await mockLlm({
    executor: [finalResp('está tudo pronto')],
    validator: ['confia em mim, deu certo'],
  });
  const h = await harness({ llm, agentParams: { validatorModel: 'val-model', maxSteps: 1 } });
  try {
    await h.src.emit('objetivo: x');
    await waitFor(() => h.received.length > 0);
    const gv = h.audits.find((a) => a.op === 'goal_validation');
    assert.equal(gv?.validation?.achieved, false);
    assert.equal(gv?.validation?.confidence, 0);
    const out = h.received[h.received.length - 1];
    assert.notEqual(out.meta?.goalAchieved, true);
  } finally { await h.stop(); await llm.close(); }
});

test('sem validatorModel e sem plano: caminho legado inalterado (1 chamada, sem goal_validation)', async () => {
  const llm = await mockLlm({ executor: [finalResp('resposta simples')] });
  const h = await harness({ llm });
  try {
    await h.src.emit('pergunta simples');
    await waitFor(() => h.received.length > 0);
    assert.equal(llm.bodies.length, 1);
    assert.equal(h.audits.filter((a) => a.op === 'goal_validation').length, 0);
    const fin = h.audits.find((a) => a.op === 'agent_final');
    assert.ok(fin, 'agent_final auditado mesmo no legado');
    assert.notEqual(fin?.goalAchieved, true);
    const payload = h.received[0].payload as { text: string; final: boolean };
    assert.equal(payload.text, 'resposta simples');
    assert.equal(payload.final, true);
  } finally { await h.stop(); await llm.close(); }
});

test('interrupt durante o gate final não pendura o run', async () => {
  const llm = await mockLlm({ executor: [finalResp('concluído')], validator: [VALID_VALIDATION] });
  const gate = makeGate([], { hang: true });
  const h = await harness({ llm, gate, agentParams: { validatorModel: 'val-model' } });
  try {
    await h.src.emit('objetivo: x');
    await waitFor(() => gate.requests.length > 0);
    h.src.interrupt();
    await h.stop(); // deve resolver sem timeout
    assert.equal(h.received.filter((m) => m.meta?.goalAchieved === true).length, 0);
  } finally { await llm.close(); }
});
test('multi-turn: segundo turno após conclusão não contamina goal/plano/evidência do primeiro', async () => {
  const llm = await mockLlm({
    executor: [
      toolCallResp('update_plan', { items: [PLAN_VERIFIED] }), finalResp('CONCLUÍDO 1'),
      toolCallResp('update_plan', { items: [{ ...PLAN_VERIFIED, id: '2', description: 'Checar memória', verification: 'free -h' }] }), finalResp('CONCLUÍDO 2'),
    ],
    validator: [VALID_VALIDATION, VALID_VALIDATION],
  });
  const gate = makeGate(['', '']);
  const h = await harness({ llm, gate, agentParams: { validatorModel: 'val-model' } });
  try {
    await h.src.emit('objetivo A: verificar disco');
    await waitFor(() => h.audits.some((a) => a.op === 'agent_final' && a.goalAchieved === true));
    const firstGv = h.audits.find((a) => a.op === 'goal_validation');
    assert.ok(firstGv?.goal?.includes('objetivo A'), `goal do 1º turno deve ser A, veio: ${firstGv?.goal}`);

    const auditsBefore = h.audits.length;
    await h.src.emit('objetivo B: checar memória');
    await waitFor(() => h.audits.length > auditsBefore && h.audits.some((a, i) => i >= auditsBefore && a.op === 'goal_validation'));
    const secondGv = h.audits.slice(auditsBefore).find((a) => a.op === 'goal_validation');
    assert.ok(secondGv, 'segundo turno gerou goal_validation');
    assert.ok(secondGv?.goal?.includes('objetivo B'), `goal do 2º turno deve ser B, veio: ${secondGv?.goal}`);
    const secondValBody = llm.bodies.find((b, i) => i > 0 && b.model === 'val-model' && (b.messages as Array<{ role: string; content: string }>).some((m) => m.role === 'user' && m.content.includes('objetivo B')));
    assert.ok(secondValBody, 'chamada de validação do segundo turno existe');
    const uc = (secondValBody?.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'user')?.content ?? '';
    assert.ok(!uc.includes('Checar disco'), 'evidência do turno A não vaza para o turno B');
  } finally { await h.stop(); await llm.close(); }
});
