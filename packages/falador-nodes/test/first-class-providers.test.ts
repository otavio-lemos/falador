// falador-nodes — testes P3: nós provedores de 1ª classe (decision.llm + human.approve + goal.validator)
// conectados explicitamente ao agent.tools, Guided Q&A ask_user e logs de falha do decisor.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  createRegistry,
  runGraph,
  type Envelope,
  type FlowSpec,
  type NodeTypeDef,
  type ToolCallResult,
  type ToolProvider,
} from '../../falador-graph/src/index.ts';
import { agentTools, type AgentGateMeta } from '../src/agent-tools.ts';
import { decisionLlm } from '../src/decision-llm.ts';
import { humanApprove } from '../src/human-approve.ts';
import { goalValidator } from '../src/goal-validator.ts';
import type { AuditEvent } from '../src/audit.ts';

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

let callSeq = 0;
function toolCallResp(name: string, args: Record<string, unknown>) {
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `fc_${++callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}
function finalResp(text: string) {
  return { choices: [{ message: { role: 'assistant', content: text } }] };
}

function makeSource(text: string): NodeTypeDef {
  return {
    type: 'src.one',
    sourceOnly: true,
    inputs: [],
    outputs: [{ name: 'out', type: 'phrase', required: false }],
    create: (ctx) => ({
      async start() { await ctx.emit('out', { text }); },
      async onInput() {},
      async stop() {},
    }),
  };
}

function makeSink(received: Envelope[]): NodeTypeDef {
  return {
    type: 'sink.one',
    sink: true,
    inputs: [{ name: 'in', type: 'tokens_parcial' }],
    outputs: [],
    create: () => ({
      async start() {},
      async onInput(_p, msg) { received.push(msg); },
      async stop() {},
    }),
  };
}

function makeMockTool(toolName: string, result: Partial<ToolCallResult>): NodeTypeDef {
  return {
    type: 'tool.mock',
    inputs: [],
    outputs: [{ name: 'tool', type: 'tool', required: false }],
    create: (ctx) => {
      const toolProvider: ToolProvider = {
        listTools: () => [{
          name: toolName,
          description: `mock ${toolName}`,
          readonly: false,
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
          sourceNodeId: ctx.id,
        }],
        invoke: async () => ({
          ok: result.ok ?? true,
          output: result.output ?? 'ok',
          exitCode: result.exitCode ?? 0,
          durationMs: 2,
          meta: result.meta,
        }),
      };
      return { toolProvider, async start() {}, async onInput() {}, async stop() {} };
    },
  };
}

test('P3-N1: agent.tools usa decision.llm + human.approve + goal.validator explícitos, preserva confidence/probabilities no audit e atualiza métricas', async () => {
  const execQ = [
    toolCallResp('update_plan', {
      items: [{ id: '1', description: 'Checar uptime', verification: 'uptime', status: 'pending' }],
    }),
    toolCallResp('exec_mock', { command: 'uptime' }),
    toolCallResp('update_plan', {
      items: [{ id: '1', description: 'Checar uptime', verification: 'uptime', status: 'verified', evidence: 'up 10 days' }],
    }),
    finalResp('Concluído com sucesso.'),
  ];
  const srv = await httpServer((req, body, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.includes('/v1/systemone')) {
      res.end(JSON.stringify({
        answers: {
          route: {
            choice: 'sensivel',
            confidence: 0.91,
            probabilities: { seguro: 0.09, sensivel: 0.91 },
          },
        },
      }));
      return;
    }
    const parsed = JSON.parse(body) as { model?: string };
    if (parsed.model === 'val-node-model') {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '{"achieved":true,"confidence":0.95,"gaps":[],"nextActions":[]}' } }],
      }));
      return;
    }
    res.end(JSON.stringify(execQ.shift() ?? finalResp('fim')));
  });

  const received: Envelope[] = [];
  const audits: AuditEvent[] = [];
  const gateCalls: Array<{ text: string; meta?: AgentGateMeta }> = [];

  const reg = createRegistry()
    .register(makeSource('Checar uptime do servidor'))
    .register(makeSink(received))
    .register(makeMockTool('exec_mock', { ok: true, output: 'up 10 days', exitCode: 0 }))
    .register(decisionLlm)
    .register(humanApprove)
    .register(goalValidator)
    .register(agentTools);

  const flow: FlowSpec = {
    version: 1,
    stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'src.one' },
      { id: 't1', type: 'tool.mock' },
      {
        id: 'decisor_d1',
        type: 'decision.llm',
        params: {
          baseUrl: srv.url,
          model: 'd1-2B-MLX-4bit',
          mode: 'systemone',
          options: ['seguro', 'sensivel'],
          defaultOption: 'sensivel',
        },
      },
      { id: 'gate_humano', type: 'human.approve', params: { mode: 'manual' } },
      {
        id: 'validador_objetivo',
        type: 'goal.validator',
        params: { baseUrl: srv.url, model: 'val-node-model', confidenceThreshold: 0.8 },
      },
      {
        id: 'agente',
        type: 'agent.tools',
        // Sem d1Model, sem validatorModel, sem __gate direto no agente — tudo vem dos nós conectados!
        params: { baseUrl: srv.url, model: 'exec-model', approvalPolicy: 'non_readonly', maxSteps: 6 },
      },
      { id: 'out', type: 'sink.one' },
    ],
    edges: [
      { from: 'src.out', to: 'agente.in' },
      { from: 't1.tool', to: 'agente.tools' },
      { from: 'decisor_d1.decider', to: 'agente.decider' },
      { from: 'gate_humano.gate', to: 'agente.gate' },
      { from: 'validador_objetivo.validator', to: 'agente.validator' },
      { from: 'agente.out', to: 'out.in' },
    ],
    bindings: {
      gate_humano: {
        __gate: {
          request: async (text: string, meta?: AgentGateMeta) => {
            gateCalls.push({ text, meta });
            return ''; // aprova sem edição
          },
        },
      },
      agente: {
        __onAudit: (ev: AuditEvent) => audits.push(ev),
      },
    },
  };

  try {
    const rg = await runGraph(flow, reg);
    await rg.done;

    assert.equal(received.length, 1);
    assert.equal((received[0].meta as Record<string, unknown>)?.goalAchieved, true);
    assert.equal(gateCalls.length, 2, 'gate_humano deve aprovar exec_mock e goal.confirm');
    assert.equal(gateCalls[0].meta?.tool, 'exec_mock');
    assert.equal(gateCalls[1].meta?.tool, 'goal.confirm');

    const tcAudit = audits.find((a) => a.op === 'tool_call' && a.tool === 'exec_mock');
    assert.ok(tcAudit, 'deve auditar tool_call');
    assert.equal(tcAudit.risk, 'sensivel');
    assert.equal(tcAudit.confidence, 0.91);
    assert.deepEqual(tcAudit.probabilities, { seguro: 0.09, sensivel: 0.91 });

    const snap = rg.snapshot();
    assert.equal(snap.nodes.decisor_d1.in, 1);
    assert.equal(snap.nodes.decisor_d1.out, 1);
    assert.equal(snap.nodes.gate_humano.in, 2);
    assert.equal(snap.nodes.gate_humano.out, 2);
    assert.equal(snap.nodes.validador_objetivo.in, 1);
    assert.equal(snap.nodes.validador_objetivo.out, 1);
  } finally {
    await srv.close();
  }
});

test('P3-N2: ask_user (Guided Q&A) usa gate kind=respond e devolve resposta do humano ao LLM', async () => {
  const llmBodies: Array<Record<string, unknown>> = [];
  const execQ = [
    toolCallResp('ask_user', {
      question: 'Qual o IP do servidor e o bastion?',
      context: 'Preciso do destino antes de conectar via SSH.',
    }),
    finalResp('Recebido: servidor 10.0.1.20 via bastion-prod.'),
  ];
  const srv = await httpServer((_req, body, res) => {
    llmBodies.push(JSON.parse(body) as Record<string, unknown>);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(execQ.shift() ?? finalResp('fim')));
  });

  const received: Envelope[] = [];
  const audits: AuditEvent[] = [];
  const gateCalls: Array<{ text: string; meta?: AgentGateMeta }> = [];

  const reg = createRegistry()
    .register(makeSource('Fazer deploy do nginx'))
    .register(makeSink(received))
    .register(humanApprove)
    .register(agentTools);

  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'src.one' },
        { id: 'gate_humano', type: 'human.approve', params: { mode: 'manual' } },
        { id: 'agente', type: 'agent.tools', params: { baseUrl: srv.url, model: 'exec-model', maxSteps: 4 } },
        { id: 'out', type: 'sink.one' },
      ],
      edges: [
        { from: 'src.out', to: 'agente.in' },
        { from: 'gate_humano.gate', to: 'agente.gate' },
        { from: 'agente.out', to: 'out.in' },
      ],
      bindings: {
        gate_humano: {
          __gate: {
            request: async (text: string, meta?: AgentGateMeta) => {
              gateCalls.push({ text, meta });
              return 'Host 10.0.1.20, bastion bastion-prod';
            },
          },
        },
        agente: {
          __onAudit: (ev: AuditEvent) => audits.push(ev),
        },
      },
    },
    reg,
  );

  try {
    await rg.done;
    assert.equal(gateCalls.length, 1);
    assert.equal(gateCalls[0].meta?.tool, 'ask_user');
    assert.equal(gateCalls[0].meta?.kind, 'respond');
    assert.match(gateCalls[0].text, /Qual o IP do servidor/);

    // 2ª chamada ao LLM recebeu a resposta do humano no role: 'tool'
    assert.equal(llmBodies.length, 2);
    const msgs = llmBodies[1].messages as Array<{ role: string; content?: string }>;
    const toolMsg = msgs.find((m) => m.role === 'tool');
    assert.ok(toolMsg?.content?.includes('Host 10.0.1.20, bastion bastion-prod'));

    const askAudit = audits.find((a) => a.op === 'tool_call' && a.tool === 'ask_user');
    assert.ok(askAudit);
    assert.equal(askAudit.ok, true);
    assert.equal(askAudit.gate, 'approved');
    assert.match(askAudit.outputPreview ?? '', /10\.0\.1\.20/);
  } finally {
    await srv.close();
  }
});

test('P3-N3: falha do decisor é logada como warn e aplica fail-safe (sensivel)', async () => {
  const execQ = [
    toolCallResp('exec_mock', { command: 'ls' }),
    finalResp('feito'),
  ];
  const srv = await httpServer((req, _body, res) => {
    if (req.url?.includes('/v1/systemone')) {
      res.statusCode = 500;
      res.end('internal error');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(execQ.shift() ?? finalResp('fim')));
  });

  const received: Envelope[] = [];
  const audits: AuditEvent[] = [];
  const reg = createRegistry()
    .register(makeSource('listar arquivos'))
    .register(makeSink(received))
    .register(makeMockTool('exec_mock', { ok: true, output: 'a.txt' }))
    .register(decisionLlm)
    .register(humanApprove)
    .register(agentTools);

  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: true,
      nodes: [
        { id: 'src', type: 'src.one' },
        { id: 't1', type: 'tool.mock' },
        {
          id: 'decisor_d1',
          type: 'decision.llm',
          params: { baseUrl: srv.url, model: 'd1', mode: 'systemone', options: ['seguro', 'sensivel'] },
        },
        { id: 'gate_humano', type: 'human.approve', params: { mode: 'auto' } },
        {
          id: 'agente',
          type: 'agent.tools',
          params: { baseUrl: srv.url, model: 'exec-model', approvalPolicy: 'non_readonly', maxSteps: 3 },
        },
        { id: 'out', type: 'sink.one' },
      ],
      edges: [
        { from: 'src.out', to: 'agente.in' },
        { from: 't1.tool', to: 'agente.tools' },
        { from: 'decisor_d1.decider', to: 'agente.decider' },
        { from: 'gate_humano.gate', to: 'agente.gate' },
        { from: 'agente.out', to: 'out.in' },
      ],
      bindings: {
        gate_humano: { __gate: { request: async () => '' } },
        agente: { __onAudit: (ev: AuditEvent) => audits.push(ev) },
      },
    },
    reg,
  );

  try {
    await rg.done;
    const events = rg.eventsSnapshot();
    assert.ok(
      events.some((e) => e.type === 'node_error' && e.nodeId === 'agente' && e.code === 'log_warn' && /deciderProvider falhou/i.test(e.message)),
      'falha do decisor deve ser logada via ctx.log(warn)',
    );
    const tcAudit = audits.find((a) => a.op === 'tool_call' && a.tool === 'exec_mock');
    assert.equal(tcAudit?.risk, 'sensivel', 'fail-safe deve classificar como sensivel');
  } finally {
    await srv.close();
  }
});
