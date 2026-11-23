// falador-nodes — testes do avaliador independente de objetivo (validateGoal + nó goal.validator)
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRegistry, runGraph, type FlowSpec, type NodeTypeDef } from '../../falador-graph/src/index.ts';
import { validateGoal, goalValidator } from '../src/goal-validator.ts';

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
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

function chatResponse(content: string) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });
}

const VALID = '{"achieved":true,"confidence":0.9,"gaps":[],"nextActions":["nada"]}';

test('validateGoal: JSON válido retorna o resultado parseado', async () => {
  const srv = await httpServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(chatResponse(VALID));
  });
  try {
    const r = await validateGoal({
      baseUrl: srv.url, model: 'm', goal: 'subir o serviço',
      evidence: ['systemctl: active'], signal: AbortSignal.timeout(5000),
    });
    assert.equal(r.achieved, true);
    assert.equal(r.confidence, 0.9);
    assert.deepEqual(r.gaps, []);
  } finally { await srv.close(); }
});

test('validateGoal: resposta lixo é fail-closed (achieved:false, confidence:0)', async () => {
  const srv = await httpServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(chatResponse('acho que deu tudo certo sim'));
  });
  try {
    const r = await validateGoal({
      baseUrl: srv.url, model: 'm', goal: 'g', evidence: [], signal: AbortSignal.timeout(5000),
    });
    assert.equal(r.achieved, false);
    assert.equal(r.confidence, 0);
    assert.ok(r.gaps.length > 0);
  } finally { await srv.close(); }
});

test('validateGoal: HTTP 500 é fail-closed', async () => {
  const srv = await httpServer((_req, _body, res) => { res.statusCode = 500; res.end('boom'); });
  try {
    const r = await validateGoal({
      baseUrl: srv.url, model: 'm', goal: 'g', evidence: ['e'], signal: AbortSignal.timeout(5000),
    });
    assert.equal(r.achieved, false);
    assert.equal(r.confidence, 0);
  } finally { await srv.close(); }
});

test('validateGoal: JSON em code-fence é parseado', async () => {
  const srv = await httpServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(chatResponse('```json\n' + VALID + '\n```'));
  });
  try {
    const r = await validateGoal({
      baseUrl: srv.url, model: 'm', goal: 'g', evidence: [], signal: AbortSignal.timeout(5000),
    });
    assert.equal(r.achieved, true);
  } finally { await srv.close(); }
});

test('validateGoal: envia auth header, enable_thinking:false e o modelo pedido', async () => {
  process.env.FALADOR_OMLX_API_KEY = 'test-key-123';
  let seenAuth: string | undefined;
  let seenBody: Record<string, unknown> = {};
  const srv = await httpServer((req, body, res) => {
    seenAuth = req.headers.authorization;
    seenBody = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    res.end(chatResponse(VALID));
  });
  try {
    await validateGoal({
      baseUrl: srv.url, model: 'validator-model', goal: 'g', evidence: [], signal: AbortSignal.timeout(5000),
    });
    assert.equal(seenAuth, 'Bearer test-key-123');
    assert.equal(seenBody.model, 'validator-model');
    assert.deepEqual(seenBody.chat_template_kwargs, { enable_thinking: false });
    assert.equal(seenBody.stream, false);
  } finally {
    delete process.env.FALADOR_OMLX_API_KEY;
    await srv.close();
  }
});

test('validateGoal: evidência gigante é cortada pelo budget mantendo a MAIS RECENTE', async () => {
  let userContent = '';
  const srv = await httpServer((_req, body, res) => {
    const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    userContent = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
    res.setHeader('content-type', 'application/json');
    res.end(chatResponse(VALID));
  });
  try {
    const evidence = ['EVIDENCIA-ANTIGA '.repeat(3000), 'EVIDENCIA-RECENTE-MARCADOR'];
    await validateGoal({
      baseUrl: srv.url, model: 'm', goal: 'g', evidence,
      evidenceCharBudget: 4000, signal: AbortSignal.timeout(5000),
    });
    assert.ok(userContent.includes('EVIDENCIA-RECENTE-MARCADOR'), 'deve manter a evidência mais recente');
    assert.ok(userContent.length < 6000, `user content ${userContent.length} chars (budget 4000 + overhead)`);
  } finally { await srv.close(); }
});

test('validateGoal: plano entra no prompt do usuário', async () => {
  let userContent = '';
  const srv = await httpServer((_req, body, res) => {
    const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    userContent = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
    res.setHeader('content-type', 'application/json');
    res.end(chatResponse(VALID));
  });
  try {
    await validateGoal({
      baseUrl: srv.url, model: 'm', goal: 'g', evidence: [],
      plan: [{ id: '1', description: 'checar disco', verification: 'df -h', status: 'verified', evidence: '45%' }],
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(userContent.includes('checar disco'));
    assert.ok(userContent.includes('df -h'));
    assert.ok(userContent.includes('verified'));
  } finally { await srv.close(); }
});

test('nó goal.validator: flow source -> goal.validator -> collect emite o JSON do avaliador', async () => {
  const srv = await httpServer((_req, _body, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(chatResponse(VALID));
  });
  const received: unknown[] = [];
  const source: NodeTypeDef = {
    type: 'test.src', sourceOnly: true, inputs: [],
    outputs: [{ name: 'out', type: 'phrase', required: false }],
    create: (ctx) => ({
      async start() { await ctx.emit('out', JSON.stringify({ goal: 'subir serviço', evidence: ['active'] })); },
      async onInput() {}, async stop() {},
    }),
  };
  const collect: NodeTypeDef = {
    type: 'test.collect', sink: true,
    inputs: [{ name: 'in', type: 'phrase' }], outputs: [],
    create: () => ({
      async start() {},
      async onInput(_p, msg) { if (!msg.control) received.push(msg.payload); },
      async stop() {},
    }),
  };
  const reg = createRegistry().register(source).register(goalValidator).register(collect);
  const flow: FlowSpec = {
    version: 1, stopWhenSourcesDone: true,
    nodes: [
      { id: 'src', type: 'test.src' },
      { id: 'gv', type: 'goal.validator', params: { baseUrl: srv.url, model: 'm' } },
      { id: 'snk', type: 'test.collect' },
    ],
    edges: [
      { from: 'src.out', to: 'gv.in' },
      { from: 'gv.out', to: 'snk.in' },
    ],
  };
  try {
    const rg = await runGraph(flow, reg);
    await rg.done;
    assert.equal(received.length, 1);
    const out = JSON.parse(String(received[0]));
    assert.equal(out.achieved, true);
    assert.equal(out.confidence, 0.9);
  } finally { await srv.close(); }
});