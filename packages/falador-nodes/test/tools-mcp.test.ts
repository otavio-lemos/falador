// falador-nodes — testes unitários e adversariais de ToolProviders (exec.command, rag.search, tool.mcp) — ADR-008 Fases 2 e 3
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import {
  createRegistry,
  runGraph,
  type FlowSpec,
  type NodeCtx,
  type NodeTypeDef,
  type ToolCallResult,
  type ToolDef,
} from '../../falador-graph/src/index.ts';
import { chunkDocument, type ContextDocument } from '../src/context-store.ts';
import { execCommand } from '../src/exec-command.ts';
import { ragSearch } from '../src/rag-search.ts';
import { buildFilteredEnv, toolMcp, validateMcpCommand, validateMcpUrl } from '../src/tool-mcp.ts';

function makeTempDir(prefix = 'falador-tools-mcp-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function readAuditLines(file: string): Array<Record<string, unknown>> {
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeFakeCtx(
  id: string,
  params: Record<string, unknown> = {},
  bindings: Record<string, unknown> = {},
): { ctx: NodeCtx; ac: AbortController; logs: string[]; counters: Record<string, number> } {
  const ac = new AbortController();
  const logs: string[] = [];
  const counters: Record<string, number> = {};
  const ctx: NodeCtx = {
    id,
    params,
    bindings,
    async emit() {},
    emitControl() {},
    isCancelled: () => false,
    metrics: {
      counter(name: string, delta = 1) {
        counters[name] = (counters[name] ?? 0) + delta;
      },
      timer() {},
    },
    log(level, msg) {
      logs.push(`[${level}] ${msg}`);
    },
    signal: ac.signal,
  };
  return { ctx, ac, logs, counters };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    return code !== 'ESRCH';
  }
}

// ============================================================================
// M1 — exec.command como ToolProvider
// ============================================================================

describe('ADR-008 Fase 2 — M1: exec.command como ToolProvider', () => {
  test('M1.1: exec_local com dryRun=false executa uname -s e retorna Darwin (ok=true, exitCode=0)', async () => {
    const tmp = makeTempDir();
    const auditFile = join(tmp.dir, 'audit.jsonl');
    try {
      const { ctx } = makeFakeCtx('exec_local_node', {
        transport: 'local',
        mode: 'readonly',
        dryRun: false,
        auditLogPath: auditFile,
      });
      const rt = execCommand.create(ctx);
      await rt.start();
      assert.ok(rt.toolProvider, 'exec.command deve expor toolProvider');

      const tools = await rt.toolProvider.listTools();
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'exec_local');
      assert.equal(tools[0].readonly, true);
      assert.equal(tools[0].sourceNodeId, 'exec_local_node');
      assert.deepEqual((tools[0].parameters as { required: string[] }).required, ['command']);

      const callAc = new AbortController();
      const res = await rt.toolProvider.invoke(
        'exec_local',
        { command: 'uname -s', reason: 'teste M1' },
        { signal: callAc.signal, runId: 'run-m1', callerNodeId: 'agent' },
      );

      assert.equal(res.ok, true, `Esperado ok=true, veio: ${JSON.stringify(res)}`);
      assert.equal(res.exitCode, 0);
      assert.equal(res.dryRun, false);
      assert.ok(res.output.includes('Darwin'), `Esperado Darwin na saída: ${res.output}`);

      const audit = readAuditLines(auditFile);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].decision, 'allowed');
      assert.equal(audit[0].runId, 'run-m1');
      assert.equal(audit[0].exitCode, 0);

      await rt.stop('done');
    } finally {
      tmp.cleanup();
    }
  });

  test('M1.2: dryRun=true retorna preview sem executar e grava audit log dry_run', async () => {
    const tmp = makeTempDir();
    const auditFile = join(tmp.dir, 'audit.jsonl');
    try {
      const { ctx } = makeFakeCtx('exec_dry', {
        transport: 'local',
        mode: 'readonly',
        dryRun: true,
        auditLogPath: auditFile,
      });
      const rt = execCommand.create(ctx);
      await rt.start();

      const res = await rt.toolProvider!.invoke(
        'exec_local',
        { command: 'uname -s', reason: 'preview' },
        { signal: new AbortController().signal, runId: 'run-dry', callerNodeId: 'agent' },
      );

      assert.equal(res.ok, true);
      assert.equal(res.dryRun, true);
      assert.equal(res.exitCode, 0);
      assert.ok(res.output.includes('[DRY-RUN]'));
      assert.ok(!res.output.includes('Darwin'), 'dryRun não deve executar o comando real');

      const audit = readAuditLines(auditFile);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].decision, 'dry_run');
      assert.equal(audit[0].dryRun, true);

      await rt.stop('done');
    } finally {
      tmp.cleanup();
    }
  });

  test('M1.3: shell injection (df -h; rm -rf / e df -h & id) retorna ok=false EXEC_POLICY_DENIED com audit log', async () => {
    const tmp = makeTempDir();
    const auditFile = join(tmp.dir, 'audit.jsonl');
    try {
      const { ctx } = makeFakeCtx('exec_sec', {
        transport: 'local',
        mode: 'readonly',
        dryRun: false,
        auditLogPath: auditFile,
      });
      const rt = execCommand.create(ctx);
      await rt.start();

      for (const badCmd of ['df -h; rm -rf /', 'df -h & id']) {
        const res = await rt.toolProvider!.invoke(
          'exec_local',
          { command: badCmd },
          { signal: new AbortController().signal, runId: 'run-adv', callerNodeId: 'agent' },
        );
        assert.equal(res.ok, false, `Comando malicioso deveria ser bloqueado: ${badCmd}`);
        assert.ok(res.output.includes('EXEC_POLICY_DENIED'), `Esperado EXEC_POLICY_DENIED, veio: ${res.output}`);
        assert.equal(res.durationMs, 0);
      }

      const audit = readAuditLines(auditFile);
      assert.equal(audit.length, 2);
      assert.equal(audit[0].decision, 'denied');
      assert.equal(audit[1].decision, 'denied');

      await rt.stop('done');
    } finally {
      tmp.cleanup();
    }
  });

  test('M1.4: exec.command conectado só pela porta tool em runGraph (sem conectar out) + schema SSH', async () => {
    const tmp = makeTempDir();
    const auditFile = join(tmp.dir, 'audit.jsonl');
    try {
      let seenTools: ToolDef[] = [];
      let callRes: ToolCallResult | null = null;

      const fakeAgent: NodeTypeDef = {
        type: 'test.agent',
        inputs: [{ name: 'tools', type: 'tool' }],
        outputs: [],
        create: (ctx) => ({
          async start() {
            const providers = ctx.getTools?.('tools') ?? [];
            for (const p of providers) {
              const list = await p.listTools();
              seenTools.push(...list);
              const localTool = list.find((t) => t.name === 'exec_local');
              if (localTool) {
                callRes = await p.invoke(
                  localTool.name,
                  { command: 'uname -s' },
                  { signal: ctx.signal, runId: 'run-graph-m1', callerNodeId: ctx.id },
                );
              }
            }
          },
          async onInput() {},
          async stop() {},
        }),
      };

      const reg = createRegistry();
      reg.register(execCommand);
      reg.register(fakeAgent);

      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          {
            id: 'local_tool',
            type: 'exec.command',
            params: { transport: 'local', dryRun: false, auditLogPath: auditFile },
          },
          {
            id: 'ssh_tool',
            type: 'exec.command',
            params: {
              transport: 'ssh',
              mode: 'allowlist',
              allowedPrefixes: ['systemctl status'],
              allowedHosts: ['prod-01'],
              toolName: 'ssh_prod',
              auditLogPath: auditFile,
            },
          },
          { id: 'agent', type: 'test.agent' },
        ],
        edges: [
          { from: 'local_tool.tool', to: 'agent.tools' },
          { from: 'ssh_tool.tool', to: 'agent.tools' },
        ],
      };

      const rg = await runGraph(flow, reg, { runId: 'run-graph-m1' });
      await rg.done;

      assert.equal(seenTools.length, 2);
      assert.equal(seenTools[0].name, 'exec_local');
      assert.equal(seenTools[1].name, 'ssh_prod');
      assert.equal(seenTools[1].readonly, false);
      assert.deepEqual((seenTools[1].parameters as { required: string[] }).required, ['command', 'host']);
      assert.ok(seenTools[1].description.includes('prod-01'));
      assert.ok(callRes && (callRes as ToolCallResult).ok);
      assert.ok((callRes as ToolCallResult).output.includes('Darwin'));
    } finally {
      tmp.cleanup();
    }
  });
});

// ============================================================================
// M2 — rag.search como ToolProvider
// ============================================================================

describe('ADR-008 Fase 2 — M2: rag.search como ToolProvider', () => {
  const RUNBOOK_MD = `# Runbook SRE

## Nginx
### Erro 502 Bad Gateway
Quando o nginx retornar erro 502 no upstream da API, verifique o backend local e inspecione /var/log/nginx/error.log.

## Postgres
### Conexões Esgotadas
Quando o PostgreSQL atingir max_connections, confira pg_stat_activity e o pool PgBouncer.

## Redis
### OOM e Evictions
Verifique used_memory e slowlog get 10.
`;

  test('M2.1: busca BM25 via __getDocs retorna chunk de Nginx para "erro 502 nginx"', async () => {
    const docs: ContextDocument[] = [
      {
        id: 'doc-1',
        name: 'runbook-sre.md',
        tags: ['ops', 'infra'],
        addedAt: '2026-11-21T00:00:00.000Z',
        points: [],
        chunks: chunkDocument('runbook-sre.md', RUNBOOK_MD, { tags: ['ops', 'infra'] }),
      },
    ];

    const { ctx } = makeFakeCtx('rag_node', { topK: 2, maxChars: 1200 }, { __getDocs: () => docs });
    const rt = ragSearch.create(ctx);
    await rt.start();
    assert.ok(rt.toolProvider);

    const tools = await rt.toolProvider.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'search_docs');
    assert.equal(tools[0].readonly, true);
    assert.equal(tools[0].sourceNodeId, 'rag_node');

    const res = await rt.toolProvider.invoke(
      'search_docs',
      { query: 'erro 502 nginx' },
      { signal: new AbortController().signal, runId: 'run-m2', callerNodeId: 'agent' },
    );

    assert.equal(res.ok, true);
    assert.ok(res.output.includes('[DOCUMENTAÇÃO OFICIAL RELEVANTE]'));
    assert.ok(res.output.includes('Nginx'), `Esperado seção Nginx: ${res.output}`);
    assert.ok(res.output.includes('502'), `Esperado conteúdo 502: ${res.output}`);
    await rt.stop('done');
  });

  test('M2.2: busca BM25 lendo docsPath em disco + filtro por tags + query vazia rejeitada', async () => {
    const tmp = makeTempDir();
    const docsFile = join(tmp.dir, 'docs.json');
    try {
      const docs: ContextDocument[] = [
        {
          id: 'doc-1',
          name: 'runbook-sre.md',
          tags: ['ops'],
          addedAt: '2026-11-21T00:00:00.000Z',
          points: [],
          chunks: chunkDocument('runbook-sre.md', RUNBOOK_MD, { tags: ['ops'] }),
        },
      ];
      writeFileSync(docsFile, JSON.stringify(docs), 'utf8');

      const { ctx } = makeFakeCtx('rag_disk', {
        toolName: 'runbook_lookup',
        docsPath: docsFile,
        topK: 1,
      });
      const rt = ragSearch.create(ctx);
      await rt.start();

      const res = await rt.toolProvider!.invoke(
        'runbook_lookup',
        { query: 'erro 502 nginx', tags: ['ops'] },
        { signal: new AbortController().signal, runId: 'run-m2-disk', callerNodeId: 'agent' },
      );
      assert.equal(res.ok, true);
      assert.ok(res.output.includes('502'));

      const noTagMatch = await rt.toolProvider!.invoke(
        'runbook_lookup',
        { query: 'erro 502 nginx', tags: ['financeiro'] },
        { signal: new AbortController().signal, runId: 'run-m2-disk', callerNodeId: 'agent' },
      );
      assert.equal(noTagMatch.ok, true);
      assert.equal((noTagMatch.meta as { hits: number }).hits, 0);

      const emptyQ = await rt.toolProvider!.invoke(
        'runbook_lookup',
        { query: '   ' },
        { signal: new AbortController().signal, runId: 'run-m2-disk', callerNodeId: 'agent' },
      );
      assert.equal(emptyQ.ok, false);

      await rt.stop('done');
    } finally {
      tmp.cleanup();
    }
  });
});

// ============================================================================
// M3 — tool.mcp transporte stdio (servidor MCP mock real via processo filho)
// ============================================================================

const MOCK_STDIO_MCP_SCRIPT = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-stdio-mcp', version: '1.0.0' },
      },
    }) + '\\n');
    return;
  }

  if (msg.method === 'notifications/initialized') {
    initialized = true;
    return;
  }

  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'get_status',
            description: 'Retorna status do serviço e PID do servidor MCP',
            inputSchema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'drop_table',
            description: 'Tool perigosa que deve ser filtrada por allowedTools',
            inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] },
          },
          {
            name: 'inspect_env',
            description: 'Retorna chaves de ambiente recebidas pelo servidor',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    }) + '\\n');
    return;
  }

  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === 'get_status') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: 'service=' + (args.service || 'unknown') + ' status=healthy pid=' + process.pid + ' init=' + initialized }],
        },
      }) + '\\n');
      return;
    }
    if (name === 'inspect_env') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env).sort()) }],
        },
      }) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: 'Unknown tool: ' + name },
    }) + '\\n');
  }
});
`;

describe('ADR-008 Fase 3 — M3: tool.mcp transporte stdio', () => {
  test('M3.1: handshake initialize, tools/list filtrado, tools/call real, bloqueio fora de allowedTools, envAllowlist e stop() sem zumbi', async () => {
    const tmp = makeTempDir();
    const auditFile = join(tmp.dir, 'mcp-audit.jsonl');
    const prevAllowed = process.env.FALADOR_TEST_ALLOWED_VAR;
    const prevSecret = process.env.FALADOR_TEST_SECRET_TOKEN;
    process.env.FALADOR_TEST_ALLOWED_VAR = 'ok-value';
    process.env.FALADOR_TEST_SECRET_TOKEN = 'super-secret-must-not-leak';

    try {
      const { ctx } = makeFakeCtx('mcp_stdio', {
        serverName: 'ops',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', MOCK_STDIO_MCP_SCRIPT],
        envAllowlist: ['FALADOR_TEST_ALLOWED_VAR'],
        allowedTools: ['get_status', 'inspect_env'],
        dryRun: false,
        timeoutMs: 5000,
        auditLogPath: auditFile,
      });

      const rt = toolMcp.create(ctx);
      await rt.start();

      // tools/list filtra drop_table e aplica prefixo ops_
      const tools = await rt.toolProvider!.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ['ops_get_status', 'ops_inspect_env'],
      );
      assert.equal(tools[0].readonly, true);
      assert.equal(tools[0].sourceNodeId, 'mcp_stdio');

      // tools/call real
      const callRes = await rt.toolProvider!.invoke(
        'ops_get_status',
        { service: 'nginx' },
        { signal: new AbortController().signal, runId: 'run-m3', callerNodeId: 'agent' },
      );
      assert.equal(callRes.ok, true, `Esperado ok=true: ${JSON.stringify(callRes)}`);
      assert.ok(callRes.output.includes('service=nginx status=healthy'));
      assert.ok(callRes.output.includes('init=true'));

      // Extrai PID do filho para validar shutdown limpo (sem zumbi)
      const pidMatch = /pid=(\d+)/.exec(callRes.output);
      assert.ok(pidMatch, `PID não encontrado na saída: ${callRes.output}`);
      const childPid = Number(pidMatch[1]);
      assert.equal(isPidAlive(childPid), true, 'Processo filho MCP deve estar vivo antes de stop()');

      // Verifica isolamento de envAllowlist (não vaza FALADOR_TEST_SECRET_TOKEN)
      const envRes = await rt.toolProvider!.invoke(
        'ops_inspect_env',
        {},
        { signal: new AbortController().signal, runId: 'run-m3', callerNodeId: 'agent' },
      );
      assert.equal(envRes.ok, true);
      const envKeys = JSON.parse(envRes.output) as string[];
      assert.ok(envKeys.includes('FALADOR_TEST_ALLOWED_VAR'), 'Var da envAllowlist deve estar presente');
      assert.ok(!envKeys.includes('FALADOR_TEST_SECRET_TOKEN'), 'Segredo fora da envAllowlist NÃO pode vazar');

      // Bloqueio de tool fora de allowedTools
      const deniedRes = await rt.toolProvider!.invoke(
        'ops_drop_table',
        { table: 'users' },
        { signal: new AbortController().signal, runId: 'run-m3', callerNodeId: 'agent' },
      );
      assert.equal(deniedRes.ok, false);
      assert.ok(deniedRes.output.includes('MCP_TOOL_DENIED'));

      // Audit log deve conter 2 allowed + 1 denied
      const audit = readAuditLines(auditFile);
      assert.equal(audit.length, 3);
      assert.equal(audit[0].decision, 'allowed');
      assert.equal(audit[2].decision, 'denied');
      assert.equal(audit[2].tool, 'drop_table');

      // stop() encerra processo filho sem zumbi
      await rt.stop('test_done');
      assert.equal(isPidAlive(childPid), false, `Processo filho PID ${childPid} não foi encerrado no stop()`);
    } finally {
      if (prevAllowed === undefined) delete process.env.FALADOR_TEST_ALLOWED_VAR;
      else process.env.FALADOR_TEST_ALLOWED_VAR = prevAllowed;
      if (prevSecret === undefined) delete process.env.FALADOR_TEST_SECRET_TOKEN;
      else process.env.FALADOR_TEST_SECRET_TOKEN = prevSecret;
      tmp.cleanup();
    }
  });

  test('M3.2: dryRun=true (default) retorna preview sem chamar servidor + validações de comando/env', async () => {
    const tmp = makeTempDir();
    const auditFile = join(tmp.dir, 'mcp-dry-audit.jsonl');
    try {
      const { ctx } = makeFakeCtx('mcp_dry', {
        serverName: 'ops',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', MOCK_STDIO_MCP_SCRIPT],
        allowedTools: ['get_status'],
        // dryRun omitido -> default true!
        auditLogPath: auditFile,
      });

      const rt = toolMcp.create(ctx);
      // Não precisa nem iniciar o filho para dryRun retornar preview
      const res = await rt.toolProvider!.invoke(
        'ops_get_status',
        { service: 'postgres' },
        { signal: new AbortController().signal, runId: 'run-m3-dry', callerNodeId: 'agent' },
      );
      assert.equal(res.ok, true);
      assert.equal(res.dryRun, true);
      assert.ok(res.output.includes('[DRY-RUN MCP ops]'));

      const audit = readAuditLines(auditFile);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].decision, 'dry_run');

      // Validação de comando bloqueia metacaracteres e binários destrutivos
      assert.equal(validateMcpCommand('npx; rm -rf /').ok, false);
      assert.equal(validateMcpCommand('/bin/rm').ok, false);
      assert.equal(validateMcpCommand('').ok, false);

      // buildFilteredEnv só passa PATH, HOME e allowlist
      const env = buildFilteredEnv(['MY_KEY'], {
        PATH: '/usr/bin',
        HOME: '/tmp',
        MY_KEY: '123',
        AWS_SECRET_ACCESS_KEY: 'nope',
      });
      assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/tmp', MY_KEY: '123' });

      await rt.stop('done');
    } finally {
      tmp.cleanup();
    }
  });
});

// ============================================================================
// M4 — tool.mcp transporte http (Streamable HTTP mock local)
// ============================================================================

describe('ADR-008 Fase 3 — M4: tool.mcp transporte http', () => {
  test('M4.1: initialize + Mcp-Session-Id + tools/list + tools/call + timeout + SSE', async () => {
    const tmp = makeTempDir();
    const auditFile = join(tmp.dir, 'mcp-http-audit.jsonl');
    const receivedSessionHeaders: Array<string | undefined> = [];
    const receivedMethods: string[] = [];

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id?: number;
          method: string;
          params?: Record<string, unknown>;
        };
        receivedMethods.push(body.method);
        receivedSessionHeaders.push(req.headers['mcp-session-id'] as string | undefined);

        if (body.method === 'initialize') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'sess-abc-123',
          });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'mock-http-mcp', version: '1.0.0' },
              },
            }),
          );
          return;
        }

        if (body.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end();
          return;
        }

        if (body.method === 'tools/list') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                tools: [
                  {
                    name: 'query_metrics',
                    description: 'Consulta métricas do cluster',
                    inputSchema: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] },
                    annotations: { readOnlyHint: true },
                  },
                  {
                    name: 'slow_op',
                    description: 'Operação lenta para testar timeout',
                    inputSchema: { type: 'object', properties: {} },
                  },
                  {
                    name: 'sse_tool',
                    description: 'Retorna resposta via text/event-stream',
                    inputSchema: { type: 'object', properties: {} },
                  },
                  {
                    name: 'delete_cluster',
                    description: 'Perigosa - fora da allowlist',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              },
            }),
          );
          return;
        }

        if (body.method === 'tools/call') {
          const toolName = body.params?.name as string;
          const toolArgs = (body.params?.arguments ?? {}) as Record<string, unknown>;
          if (toolName === 'query_metrics') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: {
                  content: [{ type: 'text', text: `cpu_usage{expr="${String(toolArgs.expr)}"} 0.42` }],
                },
              }),
            );
            return;
          }
          if (toolName === 'sse_tool') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const ssePayload = JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                content: [{ type: 'text', text: 'sse-ok-payload' }],
              },
            });
            res.end(`event: message\ndata: ${ssePayload}\n\n`);
            return;
          }
          if (toolName === 'slow_op') {
            // Segura resposta além do timeoutMs (150ms)
            const t = setTimeout(() => {
              if (!res.writableEnded) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'late' }] } }));
              }
            }, 1500);
            t.unref?.();
            return;
          }
        }

        res.writeHead(404);
        res.end('not found');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const url = `http://127.0.0.1:${addr.port}/mcp`;

    try {
      const { ctx } = makeFakeCtx('mcp_http', {
        serverName: 'graf',
        transport: 'http',
        url,
        allowedTools: ['query_metrics', 'slow_op', 'sse_tool'],
        dryRun: false,
        timeoutMs: 150,
        auditLogPath: auditFile,
      });

      const rt = toolMcp.create(ctx);
      await rt.start();

      const tools = await rt.toolProvider!.listTools();
      assert.deepEqual(
        tools.map((t) => t.name),
        ['graf_query_metrics', 'graf_slow_op', 'graf_sse_tool'],
      );

      // tools/call JSON
      const res = await rt.toolProvider!.invoke(
        'graf_query_metrics',
        { expr: 'up' },
        { signal: new AbortController().signal, runId: 'run-m4', callerNodeId: 'agent' },
      );
      assert.equal(res.ok, true);
      assert.ok(res.output.includes('cpu_usage{expr="up"} 0.42'));

      // tools/call SSE (Streamable HTTP)
      const sseRes = await rt.toolProvider!.invoke(
        'graf_sse_tool',
        {},
        { signal: new AbortController().signal, runId: 'run-m4', callerNodeId: 'agent' },
      );
      assert.equal(sseRes.ok, true);
      assert.equal(sseRes.output, 'sse-ok-payload');

      // Verifica que Mcp-Session-Id foi enviado após initialize
      assert.equal(receivedMethods[0], 'initialize');
      assert.equal(receivedSessionHeaders[0], undefined);
      assert.equal(receivedMethods[1], 'notifications/initialized');
      assert.equal(receivedSessionHeaders[1], 'sess-abc-123');
      assert.equal(receivedSessionHeaders[2], 'sess-abc-123');
      assert.equal(receivedSessionHeaders[3], 'sess-abc-123');

      // Timeout
      const timeoutRes = await rt.toolProvider!.invoke(
        'graf_slow_op',
        {},
        { signal: new AbortController().signal, runId: 'run-m4', callerNodeId: 'agent' },
      );
      assert.equal(timeoutRes.ok, false);
      assert.ok(timeoutRes.output.toLowerCase().includes('timeout'), `Esperado timeout: ${timeoutRes.output}`);

      await rt.stop('done');
    } finally {
      server.close();
      tmp.cleanup();
    }
  });

  test('M4.2: bloqueia URL externa fora de allowedUrls e permite quando listada explicitamente', async () => {
    const tmp = makeTempDir();
    const auditFile = join(tmp.dir, 'mcp-url-audit.jsonl');
    try {
      assert.equal(validateMcpUrl('http://127.0.0.1:9000/mcp', []).ok, true);
      assert.equal(validateMcpUrl('http://localhost:9000/mcp', []).ok, true);
      assert.equal(validateMcpUrl('https://evil.example.com/mcp', []).ok, false);
      assert.equal(validateMcpUrl('file:///etc/passwd', ['file:///etc/passwd']).ok, false);
      assert.equal(
        validateMcpUrl('https://mcp.internal.corp/v1/rpc', ['https://mcp.internal.corp/v1']).ok,
        true,
      );

      const { ctx } = makeFakeCtx('mcp_blocked_url', {
        transport: 'http',
        url: 'https://evil.example.com/mcp',
        allowedUrls: [],
        allowedTools: ['ping'],
        dryRun: false,
        auditLogPath: auditFile,
      });

      const rt = toolMcp.create(ctx);
      await assert.rejects(() => rt.start(), /MCP_URL_DENIED/);

      const invokeRes = await rt.toolProvider!.invoke(
        'ping',
        {},
        { signal: new AbortController().signal, runId: 'run-m4-url', callerNodeId: 'agent' },
      );
      assert.equal(invokeRes.ok, false);
      assert.ok(invokeRes.output.includes('MCP_URL_DENIED'));

      const audit = readAuditLines(auditFile);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].decision, 'denied');

      await rt.stop('done');
    } finally {
      tmp.cleanup();
    }
  });

  test('M4.3 (Segurança SSRF): HTTP 302 redirect é rejeitado sem seguir o redirecionamento', async () => {
    const tmp = makeTempDir();
    const auditFile = join(tmp.dir, 'mcp-redirect-audit.jsonl');
    let targetHits = 0;

    const targetServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
      targetHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'evil', version: '1' } },
        }),
      );
    });

    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const targetAddr = targetServer.address();
    assert.ok(targetAddr && typeof targetAddr === 'object');
    const targetUrl = `http://127.0.0.1:${targetAddr.port}/secret`;

    const redirectServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(302, { Location: targetUrl });
      res.end();
    });

    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    const redirectAddr = redirectServer.address();
    assert.ok(redirectAddr && typeof redirectAddr === 'object');
    const redirectUrl = `http://127.0.0.1:${redirectAddr.port}/mcp`;

    try {
      const { ctx } = makeFakeCtx('mcp_redirect', {
        transport: 'http',
        url: redirectUrl,
        allowedTools: ['ping'],
        dryRun: false,
        timeoutMs: 2000,
        auditLogPath: auditFile,
      });

      const rt = toolMcp.create(ctx);
      await assert.rejects(() => rt.start(), /fetch failed|redirect/i);

      const invokeRes = await rt.toolProvider!.invoke(
        'ping',
        {},
        { signal: new AbortController().signal, runId: 'run-m4-redirect', callerNodeId: 'agent' },
      );
      assert.equal(invokeRes.ok, false, 'tools/call deve falhar quando servidor retornar 302');
      assert.equal(targetHits, 0, 'O alvo do redirect 302 NÃO pode ter sido acessado');

      await rt.stop('done');
    } finally {
      redirectServer.close();
      targetServer.close();
      tmp.cleanup();
    }
  });

  test('M4.4 (Segurança fronteira de caminho): validateMcpUrl rejeita prefixo sem barra (/api-admin/secret) e aceita /api e /api/tools', () => {
    const allowed = ['https://mcp.internal/api'];
    assert.equal(validateMcpUrl('https://mcp.internal/api', allowed).ok, true);
    assert.equal(validateMcpUrl('https://mcp.internal/api/tools', allowed).ok, true);
    assert.equal(validateMcpUrl('https://mcp.internal/api/v1/rpc', allowed).ok, true);
    assert.equal(validateMcpUrl('https://mcp.internal/api-admin/secret', allowed).ok, false);
    assert.equal(validateMcpUrl('https://mcp.internal/api/../api-admin/secret', allowed).ok, false);
  });
});
