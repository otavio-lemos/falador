import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRegistry, runGraph, type NodeCtx } from '../../falador-graph/src/index.ts';
import {
  registerFaladorNodes,
  resolveSafeFlowPath,
  sanitizeFlowName,
  toolWebSearch,
  toolWorkflow,
  validateExternalUrl,
  type AgentGateMeta,
  type AgentStepEvent,
  type ChatSendFn,
  type FetcherFn,
} from '../src/index.ts';

function makeTempWorkspace(): {
  dir: string;
  flowsDir: string;
  agentsMdPath: string;
  auditLogPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'falador-wf-test-'));
  const flowsDir = join(dir, 'flows');
  const agentsMdPath = join(dir, 'AGENTS.md');
  const auditLogPath = join(dir, 'logs', 'exec-audit.jsonl');
  return {
    dir,
    flowsDir,
    agentsMdPath,
    auditLogPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeDirectCtx(
  id: string,
  params: Record<string, unknown>,
  bindings: Record<string, unknown> = {},
): NodeCtx {
  const ac = new AbortController();
  return {
    id,
    params,
    bindings,
    signal: ac.signal,
    metrics: { counter: () => {}, timer: () => {} },
    log: () => {},
    isCancelled: () => false,
    getTools: () => [],
    emit: async () => {},
    emitControl: () => {},
  };
}

function makeValidFlow(description = 'Fluxo de teste'): Record<string, unknown> {
  return {
    version: 1,
    stopWhenSourcesDone: false,
    description,
    nodes: [
      { id: 'chat', type: 'input.chat', params: { placeholder: 'Digite…' } },
      { id: 'cap', type: 'sink.captions', params: { mode: 'callback', showParcials: true } },
    ],
    edges: [
      { from: 'chat.out', to: 'cap.phrase', capacity: 8, overflow: 'block' },
    ],
  };
}

describe('tool.workflow — gestão segura de workflows e AGENTS.md', () => {
  test('WF1: workflow_list, workflow_get e workflow_catalog sobre flowsDir temporário', async () => {
    const ws = makeTempWorkspace();
    try {
      const reg = registerFaladorNodes(createRegistry());
      assert.ok(reg.get('tool.workflow'), 'tool.workflow deve estar registrado');
      assert.ok(reg.get('tool.web_search'), 'tool.web_search deve estar registrado');

      const rt = toolWorkflow.create(
        makeDirectCtx('wf', {
          flowsDir: ws.flowsDir,
          agentsMdPath: ws.agentsMdPath,
          auditLogPath: ws.auditLogPath,
        }),
      );
      const tp = rt.toolProvider!;
      const ac = new AbortController();
      const opts = { signal: ac.signal, runId: 'run-wf1', callerNodeId: 'test' };

      // Sem diretório ainda -> lista vazia
      const emptyList = await tp.invoke('workflow_list', {}, opts);
      assert.equal(emptyList.ok, true);
      assert.deepEqual(JSON.parse(emptyList.output), []);

      // Cria 2 flows válidos + 1 oculto (.hidden.json deve ser ignorado)
      const save1 = await tp.invoke('workflow_save', { name: 'alpha-flow', flow: makeValidFlow('Alpha') }, opts);
      assert.equal(save1.ok, true, save1.output);
      writeFileSync(join(ws.flowsDir, '.hidden.json'), JSON.stringify(makeValidFlow('Hidden')), 'utf8');

      const listRes = await tp.invoke('workflow_list', {}, opts);
      assert.equal(listRes.ok, true);
      const listed = JSON.parse(listRes.output) as Array<{
        name: string;
        description: string;
        nodesCount: number;
        edgesCount: number;
      }>;
      assert.equal(listed.length, 1);
      assert.equal(listed[0].name, 'alpha-flow');
      assert.equal(listed[0].description, 'Alpha');
      assert.equal(listed[0].nodesCount, 2);
      assert.equal(listed[0].edgesCount, 1);

      const getRes = await tp.invoke('workflow_get', { name: 'alpha-flow' }, opts);
      assert.equal(getRes.ok, true);
      const parsedFlow = JSON.parse(getRes.output) as { description: string; nodes: unknown[] };
      assert.equal(parsedFlow.description, 'Alpha');
      assert.equal(parsedFlow.nodes.length, 2);

      const catRes = await tp.invoke('workflow_catalog', {}, opts);
      assert.equal(catRes.ok, true);
      const catalog = JSON.parse(catRes.output) as Array<{ type: string; inputs: unknown[]; outputs: unknown[] }>;
      const types = new Set(catalog.map((c) => c.type));
      assert.ok(types.has('input.chat'), 'catálogo deve incluir input.chat');
      assert.ok(types.has('agent.tools'), 'catálogo deve incluir agent.tools');
      assert.ok(types.has('tool.workflow'), 'catálogo deve incluir tool.workflow');
      assert.ok(types.has('tool.web_search'), 'catálogo deve incluir tool.web_search');
      assert.ok(types.has('sink.collect'), 'catálogo deve incluir nós sintéticos');
    } finally {
      ws.cleanup();
    }
  });

  test('WF2 (Adversarial): rejeita path traversal e nomes proibidos em get/save/delete', async () => {
    const ws = makeTempWorkspace();
    try {
      const badNames = ['../secret', '../../etc/passwd', 'a/b', 'a\\b', '.hidden', '..', '', '   ', 'com espaco', 'foo.json'];
      for (const bad of badNames) {
        assert.equal(sanitizeFlowName(bad).ok, false, `sanitizeFlowName deveria rejeitar "${bad}"`);
        assert.equal(resolveSafeFlowPath(ws.flowsDir, bad).ok, false, `resolveSafeFlowPath deveria rejeitar "${bad}"`);
      }

      const rt = toolWorkflow.create(
        makeDirectCtx('wf', {
          flowsDir: ws.flowsDir,
          agentsMdPath: ws.agentsMdPath,
          auditLogPath: ws.auditLogPath,
          allowDelete: true,
        }),
      );
      const tp = rt.toolProvider!;
      const ac = new AbortController();
      const opts = { signal: ac.signal, runId: 'run-wf2', callerNodeId: 'test' };

      for (const bad of ['../secret', 'a/b', '.hidden']) {
        const rGet = await tp.invoke('workflow_get', { name: bad }, opts);
        assert.equal(rGet.ok, false);
        assert.match(rGet.output, /INVALID_FLOW_NAME/);

        const rSave = await tp.invoke('workflow_save', { name: bad, flow: makeValidFlow() }, opts);
        assert.equal(rSave.ok, false);
        assert.match(rSave.output, /INVALID_FLOW_NAME/);

        const rDel = await tp.invoke('workflow_delete', { name: bad }, opts);
        assert.equal(rDel.ok, false);
        assert.match(rDel.output, /INVALID_FLOW_NAME/);
      }

      assert.equal(existsSync(join(ws.dir, 'secret.json')), false, 'não pode escapar de flowsDir');
    } finally {
      ws.cleanup();
    }
  });

  test('WF3: workflow_save rejeita workflow inválido (porta errada / ciclo) sem gravar em disco', async () => {
    const ws = makeTempWorkspace();
    try {
      const rt = toolWorkflow.create(
        makeDirectCtx('wf', {
          flowsDir: ws.flowsDir,
          agentsMdPath: ws.agentsMdPath,
          auditLogPath: ws.auditLogPath,
        }),
      );
      const tp = rt.toolProvider!;
      const ac = new AbortController();
      const opts = { signal: ac.signal, runId: 'run-wf3', callerNodeId: 'test' };

      // 1) Porta incompatível / inexistente
      const badPortFlow = {
        version: 1,
        nodes: [
          { id: 'chat', type: 'input.chat', params: {} },
          { id: 'cap', type: 'sink.captions', params: { mode: 'callback' } },
        ],
        edges: [{ from: 'chat.out', to: 'cap.in' }], // phrase -> tokens_parcial (PORT_TYPE_MISMATCH)
      };
      const resPort = await tp.invoke('workflow_save', { name: 'invalido-porta', flow: badPortFlow }, opts);
      assert.equal(resPort.ok, false);
      assert.match(resPort.output, /VALIDATION_ERROR/);
      assert.equal(existsSync(join(ws.flowsDir, 'invalido-porta.json')), false);

      // 2) Ciclo no DAG
      const cyclicFlow = {
        version: 1,
        nodes: [
          { id: 'a', type: 'llm.omlx', params: {} },
          { id: 'b', type: 'llm.omlx', params: {} },
        ],
        edges: [
          { from: 'a.out', to: 'b.parcs' },
          { from: 'b.out', to: 'a.parcs' },
        ],
      };
      const resCycle = await tp.invoke('workflow_save', { name: 'invalido-ciclo', flow: cyclicFlow }, opts);
      assert.equal(resCycle.ok, false);
      assert.match(resCycle.output, /VALIDATION_ERROR/);
      assert.equal(existsSync(join(ws.flowsDir, 'invalido-ciclo.json')), false);
      assert.equal(existsSync(ws.agentsMdPath), false, 'AGENTS.md não deve ser alterado quando validação falha');
    } finally {
      ws.cleanup();
    }
  });

  test('WF4: workflow_save grava JSON, registra audit log, atualiza AGENTS.md e knowledge_read lê de volta', async () => {
    const ws = makeTempWorkspace();
    try {
      writeFileSync(ws.agentsMdPath, '# AGENTS.md (teste)\n\nConteúdo inicial.\n', 'utf8');

      // Primeiro valida dryRun=true: não grava nada
      const rtDry = toolWorkflow.create(
        makeDirectCtx('wf_dry', {
          flowsDir: ws.flowsDir,
          agentsMdPath: ws.agentsMdPath,
          auditLogPath: ws.auditLogPath,
          dryRun: true,
        }),
      );
      const ac = new AbortController();
      const opts = { signal: ac.signal, runId: 'run-wf4', callerNodeId: 'test' };
      const dryRes = await rtDry.toolProvider!.invoke(
        'workflow_save',
        { name: 'novo-fluxo', flow: makeValidFlow('Fluxo dryRun'), changeSummary: 'Teste dryRun' },
        opts,
      );
      assert.equal(dryRes.ok, true);
      assert.match(dryRes.output, /\[dryRun\]/);
      assert.equal(existsSync(join(ws.flowsDir, 'novo-fluxo.json')), false);

      // Agora dryRun=false: grava arquivo, audit log e atualiza AGENTS.md
      const rt = toolWorkflow.create(
        makeDirectCtx('wf', {
          flowsDir: ws.flowsDir,
          agentsMdPath: ws.agentsMdPath,
          auditLogPath: ws.auditLogPath,
          dryRun: false,
        }),
      );
      const tp = rt.toolProvider!;
      const saveRes = await tp.invoke(
        'workflow_save',
        {
          name: 'novo-fluxo',
          flow: makeValidFlow('Fluxo de chat simples'),
          changeSummary: 'Criado fluxo chat -> legendas',
        },
        opts,
      );
      assert.equal(saveRes.ok, true, saveRes.output);
      assert.equal(existsSync(join(ws.flowsDir, 'novo-fluxo.json')), true);

      const savedJson = JSON.parse(readFileSync(join(ws.flowsDir, 'novo-fluxo.json'), 'utf8')) as {
        description: string;
      };
      assert.equal(savedJson.description, 'Fluxo de chat simples');

      // Audit log gravado
      const auditLines = readFileSync(ws.auditLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.ok(auditLines.some((e: { tool: string; decision: string }) => e.tool === 'workflow_save' && e.decision === 'allowed'));

      // knowledge_read lê o AGENTS.md atualizado
      const kbRead = await tp.invoke('knowledge_read', { maxChars: 4000 }, opts);
      assert.equal(kbRead.ok, true);
      assert.match(kbRead.output, /## Conhecimento de Workflows \(auto-atualizado\)/);
      assert.match(kbRead.output, /novo-fluxo/);
      assert.match(kbRead.output, /Criado fluxo chat -> legendas/);
    } finally {
      ws.cleanup();
    }
  });

  test('WF6 (Adversarial): recusa workflows que sejam symlinks (get/save/delete) sem tocar no alvo', async () => {
    const ws = makeTempWorkspace();
    try {
      const outside = join(ws.dir, 'outside-secret.txt');
      writeFileSync(outside, 'SEGREDO', 'utf8');
      mkdirSync(ws.flowsDir, { recursive: true });
      symlinkSync(outside, join(ws.flowsDir, 'linked.json'));

      const rt = toolWorkflow.create(
        makeDirectCtx('wf', {
          flowsDir: ws.flowsDir,
          agentsMdPath: ws.agentsMdPath,
          auditLogPath: ws.auditLogPath,
          allowDelete: true,
        }),
      );
      const tp = rt.toolProvider!;
      const ac = new AbortController();
      const opts = { signal: ac.signal, runId: 'run-wf6', callerNodeId: 'test' };

      const getRes = await tp.invoke('workflow_get', { name: 'linked' }, opts);
      assert.equal(getRes.ok, false);
      assert.match(getRes.output, /SYMLINK_BLOCKED/);

      const saveRes = await tp.invoke('workflow_save', { name: 'linked', flow: makeValidFlow() }, opts);
      assert.equal(saveRes.ok, false);
      assert.match(saveRes.output, /SYMLINK_BLOCKED/);
      assert.equal(readFileSync(outside, 'utf8'), 'SEGREDO', 'alvo do symlink não pode ser sobrescrito');

      const delRes = await tp.invoke('workflow_delete', { name: 'linked' }, opts);
      assert.equal(delRes.ok, false);
      assert.match(delRes.output, /SYMLINK_BLOCKED/);
      assert.equal(existsSync(outside), true);
    } finally {
      ws.cleanup();
    }
  });

  test('WF5: workflow_delete bloqueia com allowDelete=false e SEMPRE protege agente-workflows', async () => {
    const ws = makeTempWorkspace();
    try {
      const ac = new AbortController();
      const opts = { signal: ac.signal, runId: 'run-wf5', callerNodeId: 'test' };

      // Cria dois workflows: agente-workflows e descartavel
      const rtLocked = toolWorkflow.create(
        makeDirectCtx('wf_locked', {
          flowsDir: ws.flowsDir,
          agentsMdPath: ws.agentsMdPath,
          auditLogPath: ws.auditLogPath,
          allowDelete: false,
        }),
      );
      await rtLocked.toolProvider!.invoke('workflow_save', { name: 'agente-workflows', flow: makeValidFlow('Meta') }, opts);
      await rtLocked.toolProvider!.invoke('workflow_save', { name: 'descartavel', flow: makeValidFlow('Temp') }, opts);

      // allowDelete=false bloqueia tudo
      const delDenied = await rtLocked.toolProvider!.invoke('workflow_delete', { name: 'descartavel' }, opts);
      assert.equal(delDenied.ok, false);
      assert.match(delDenied.output, /DELETE_DENIED/);
      assert.equal(existsSync(join(ws.flowsDir, 'descartavel.json')), true);

      // allowDelete=true ainda protege agente-workflows
      const rtUnlocked = toolWorkflow.create(
        makeDirectCtx('wf_unlocked', {
          flowsDir: ws.flowsDir,
          agentsMdPath: ws.agentsMdPath,
          auditLogPath: ws.auditLogPath,
          allowDelete: true,
        }),
      );
      const delProtected = await rtUnlocked.toolProvider!.invoke('workflow_delete', { name: 'agente-workflows' }, opts);
      assert.equal(delProtected.ok, false);
      assert.match(delProtected.output, /DELETE_PROTECTED/);
      assert.equal(existsSync(join(ws.flowsDir, 'agente-workflows.json')), true);

      // Outro workflow pode ser deletado com allowDelete=true
      const delOk = await rtUnlocked.toolProvider!.invoke('workflow_delete', { name: 'descartavel' }, opts);
      assert.equal(delOk.ok, true);
      assert.equal(existsSync(join(ws.flowsDir, 'descartavel.json')), false);
    } finally {
      ws.cleanup();
    }
  });
});

describe('tool.web_search — pesquisa externa e proteção anti-SSRF', () => {
  test('WS1: web_search com __fetcher mock formata resultados e web_fetch_doc bloqueia SSRF', async () => {
    const requestedUrls: string[] = [];
    const mockFetcher: FetcherFn = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      requestedUrls.push(url);
      if (url.includes('api.duckduckgo.com')) {
        return new Response(
          JSON.stringify({
            Heading: 'Model Context Protocol',
            AbstractText: 'MCP é um padrão aberto para conectar agentes a ferramentas.',
            AbstractURL: 'https://modelcontextprotocol.io/docs',
            RelatedTopics: [
              {
                Text: 'JSON-RPC 2.0 - Protocolo leve usado pelo MCP sobre stdio e HTTP.',
                FirstURL: 'https://www.jsonrpc.org/specification',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        '<html><head><style>body{color:red}</style><script>alert(1)</script></head><body><h1>MCP Docs</h1><p>Guia oficial &amp; referência.</p></body></html>',
        { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
      );
    };

    const rt = toolWebSearch.create(
      makeDirectCtx(
        'web',
        { timeoutMs: 3000, maxResults: 3, maxChars: 2000 },
        { __fetcher: mockFetcher },
      ),
    );
    const tp = rt.toolProvider!;
    const ac = new AbortController();
    const opts = { signal: ac.signal, runId: 'run-ws1', callerNodeId: 'test' };

    const searchRes = await tp.invoke('web_search', { query: 'Model Context Protocol' }, opts);
    assert.equal(searchRes.ok, true, searchRes.output);
    assert.match(searchRes.output, /Model Context Protocol/);
    assert.match(searchRes.output, /JSON-RPC 2\.0/);

    // web_fetch_doc em URL pública funciona e limpa HTML/scripts
    const fetchOk = await tp.invoke('web_fetch_doc', { url: 'https://modelcontextprotocol.io/docs' }, opts);
    assert.equal(fetchOk.ok, true, fetchOk.output);
    assert.match(fetchOk.output, /MCP Docs/);
    assert.match(fetchOk.output, /Guia oficial & referência/);
    assert.doesNotMatch(fetchOk.output, /alert\(1\)/);

    // SSRF bloqueado para hosts internos, loopback, link-local e file://
    const ssrfUrls = [
      'http://127.0.0.1:8080',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost:8787',
      'file:///etc/passwd',
      'http://10.0.0.1/secret',
      'http://172.16.5.4/internal',
      'http://192.168.1.10/admin',
      'http://[::1]:8080/health',
      'http://localhost./admin',
      'http://127.0.0.1./latest/meta-data',
      'http://metadata.google.internal./computeMetadata',
    ];
    const countBeforeSsrf = requestedUrls.length;
    for (const u of ssrfUrls) {
      assert.equal(validateExternalUrl(u).ok, false, `validateExternalUrl deveria bloquear ${u}`);
      const res = await tp.invoke('web_fetch_doc', { url: u }, opts);
      assert.equal(res.ok, false, `web_fetch_doc deveria bloquear ${u}`);
      assert.match(res.output, /SSRF_BLOCKED/);
    }
    assert.equal(requestedUrls.length, countBeforeSsrf, 'nenhuma chamada HTTP deve sair para URLs SSRF');
  });
});

describe('WA1 — integração completa input.chat -> agent.tools + tool.workflow + tool.web_search -> sink.captions', () => {
  test('WA1: pedido no chat -> workflow_list -> web_search -> workflow_save (com gate) -> resposta e AGENTS.md atualizado', async () => {
    const ws = makeTempWorkspace();
    writeFileSync(ws.agentsMdPath, '# AGENTS.md — Projeto Teste\n\nBase inicial.\n', 'utf8');

    const newFlowSpec = makeValidFlow('Fluxo de monitoramento criado pelo agente');
    let llmTurn = 0;

    // Mock OpenAI server com 4 passos: workflow_list -> web_search -> workflow_save -> resposta final
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        llmTurn++;
        let message: Record<string, unknown>;
        if (llmTurn === 1) {
          message = {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'workflow_list', arguments: '{}' } },
            ],
          };
        } else if (llmTurn === 2) {
          message = {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'web_search', arguments: JSON.stringify({ query: 'falador workflow patterns' }) },
              },
            ],
          };
        } else if (llmTurn === 3) {
          message = {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_3',
                type: 'function',
                function: {
                  name: 'workflow_save',
                  arguments: JSON.stringify({
                    name: 'monitor-chat',
                    flow: newFlowSpec,
                    changeSummary: 'Criado via agente com base na pesquisa externa',
                  }),
                },
              },
            ],
          };
        } else {
          message = {
            role: 'assistant',
            content: 'Workflow "monitor-chat" criado, validado e registrado no AGENTS.md com sucesso.',
          };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message }] }));
      });
    });

    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;

    const mockFetcher: FetcherFn = async () =>
      new Response(
        JSON.stringify({
          Heading: 'Workflow Patterns',
          AbstractText: 'Use pipelines declarativos com validação de contratos antes de persistir.',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    try {
      const reg = registerFaladorNodes(createRegistry());
      let sendChat: ChatSendFn | null = null;
      const finals: string[] = [];
      const gateCalls: AgentGateMeta[] = [];
      const steps: AgentStepEvent[] = [];

      const rg = await runGraph(
        {
          version: 1,
          stopWhenSourcesDone: false,
          nodes: [
            { id: 'chat', type: 'input.chat', params: { placeholder: 'Peça um workflow…' } },
            {
              id: 'agente',
              type: 'agent.tools',
              params: {
                baseUrl: `http://127.0.0.1:${port}`,
                enableThinking: false,
                maxSteps: 6,
                approvalPolicy: 'non_readonly',
              },
            },
            {
              id: 'wf_tools',
              type: 'tool.workflow',
              params: {
                flowsDir: ws.flowsDir,
                agentsMdPath: ws.agentsMdPath,
                auditLogPath: ws.auditLogPath,
                dryRun: false,
              },
            },
            {
              id: 'web_tools',
              type: 'tool.web_search',
              params: { timeoutMs: 3000, maxResults: 3 },
            },
            {
              id: 'cap',
              type: 'sink.captions',
              params: { mode: 'callback', showParcials: false },
            },
          ],
          edges: [
            { from: 'chat.out', to: 'agente.in', capacity: 8, overflow: 'block' },
            { from: 'wf_tools.tool', to: 'agente.tools', capacity: 4, overflow: 'block' },
            { from: 'web_tools.tool', to: 'agente.tools', capacity: 4, overflow: 'block' },
            { from: 'agente.out', to: 'cap.in', capacity: 8, overflow: 'block' },
          ],
          bindings: {
            chat: {
              __registerChatInput: (fn: ChatSendFn) => {
                sendChat = fn;
              },
            },
            agente: {
              __gate: {
                request: async (text: string, meta?: AgentGateMeta) => {
                  if (meta) gateCalls.push(meta);
                  return text; // aprova sem edição
                },
              },
              __onAgentStep: (ev: AgentStepEvent) => steps.push(ev),
            },
            web_tools: {
              __fetcher: mockFetcher,
            },
            cap: {
              __onCaption: (c: { text: string; final: boolean }) => {
                if (c.final) finals.push(c.text);
              },
            },
          },
        },
        reg,
      );

      assert.ok(sendChat, '__registerChatInput deve estar registrado');
      await sendChat!('Crie um workflow monitor-chat pesquisando boas práticas antes.');

      for (let i = 0; i < 100 && finals.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      await rg.stop('fim-teste');
      await rg.done;

      assert.equal(finals.length, 1);
      assert.match(finals[0], /monitor-chat/);

      // Gate acionado apenas para workflow_save (non_readonly), não para workflow_list/web_search (readonly)
      assert.equal(gateCalls.length, 1);
      assert.equal(gateCalls[0].tool, 'workflow_save');

      // Sequência de tools executadas com sucesso
      const resultTools = steps.filter((s) => s.phase === 'result').map((s) => `${s.tool}:${s.ok}`);
      assert.deepEqual(resultTools, ['workflow_list:true', 'web_search:true', 'workflow_save:true']);

      // Arquivo salvo em flowsDir e AGENTS.md atualizado
      const savedPath = join(ws.flowsDir, 'monitor-chat.json');
      assert.equal(existsSync(savedPath), true, 'workflow monitor-chat.json deve existir');
      const agentsContent = readFileSync(ws.agentsMdPath, 'utf8');
      assert.match(agentsContent, /## Conhecimento de Workflows \(auto-atualizado\)/);
      assert.match(agentsContent, /monitor-chat/);
      assert.match(agentsContent, /Criado via agente com base na pesquisa externa/);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      ws.cleanup();
    }
  });
});
