// falador-nodes — testes unitários e adversariais de RAG BM25 + exec.command (ADR-007 Fases A e B)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import { performance } from 'node:perf_hooks';
import {
  createRegistry,
  runGraph,
  type Envelope,
  type FlowSpec,
  type NodeTypeDef,
} from '../../falador-graph/src/index.ts';
import { llmOmlx, registerFaladorNodes } from '../src/index.ts';
import {
  chunkDocument,
  formatContextBlock,
  searchChunks,
  type ContextDocument,
} from '../src/context-store.ts';
import {
  DEFAULT_READONLY_PREFIXES,
  buildSshRemoteCommand,
  execCommand,
  extractCommand,
  parseArgv,
  quotePosix,
  validateCommand,
  type ExecPolicy,
} from '../src/exec-command.ts';

function makeTempAuditPath(): { dir: string; file: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'falador-exec-test-'));
  const file = join(dir, 'exec-audit.jsonl');
  return {
    dir,
    file,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function readAuditLines(file: string): Array<Record<string, unknown>> {
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ============================================================================
// FASE A — RAG BM25 (context-store.ts)
// ============================================================================

describe('ADR-007 Fase A — context-store (chunking + BM25)', () => {
  const RUNBOOK_MD = `# Runbook de Produção

## Nginx
### Erro 502 Bad Gateway
Quando o nginx retornar erro 502 no upstream da API, verifique primeiro se o backend responde na porta local e inspecione os logs de erro do nginx.

\`\`\`bash
# comentário dentro de code fence não deve virar heading
systemctl status nginx
tail -n 50 /var/log/nginx/error.log
\`\`\`

## Postgres
### Conexões Esgotadas
Quando o PostgreSQL recusar conexões por max_connections, confira pg_stat_activity e o pool do PgBouncer.

## Redis
### Latência Alta e OOM
Se o Redis apresentar latência alta ou evictions, verifique used_memory e slowlog get 10.

## Disk
### Disco Cheio (ENOSPC)
Use df -h e du -sh /var/log/* para localizar partições acima de 90% de uso e limpar logs antigos rotacionados.

## DNS
### Falha de Resolução
Execute dig e nslookup contra o resolver interno para validar registros A e SRV do cluster.
`;

  test('R1: runbook .md com 5 seções retorna Nginx em 1º lugar para "erro 502 nginx upstream" em < 10 ms', () => {
    const chunks = chunkDocument('runbook-ops.md', RUNBOOK_MD, { tags: ['ops', 'infra'] });
    assert.equal(chunks.length, 5, 'Deve gerar 5 chunks (Nginx, Postgres, Redis, Disk, DNS)');
    assert.ok(
      chunks[0].text.startsWith('[runbook-ops.md > Runbook de Produção > Nginx > Erro 502 Bad Gateway] '),
      `Prefixo de heading incorreto: ${chunks[0].text.slice(0, 100)}`,
    );
    assert.ok(
      chunks[0].text.includes('# comentário dentro de code fence'),
      'Comentário dentro de code fence deve permanecer no chunk sem quebrar heading',
    );

    const docs: ContextDocument[] = [
      {
        id: 'doc-1',
        name: 'runbook-ops.md',
        tags: ['ops', 'infra'],
        addedAt: '2026-11-21T00:00:00.000Z',
        points: [],
        chunks,
      },
    ];

    const t0 = performance.now();
    const res = searchChunks(docs, 'erro 502 nginx upstream', { topK: 3, maxChars: 2400 });
    const elapsedMs = performance.now() - t0;

    assert.ok(res.length >= 1, 'Deve retornar pelo menos 1 chunk');
    assert.match(res[0].heading ?? '', /Nginx/i, '1º resultado deve ser a seção Nginx');
    assert.ok(res[0].text.includes('502'), '1º resultado deve conter o conteúdo de erro 502');
    assert.ok(elapsedMs < 10, `Busca BM25 deve levar < 10 ms (levou ${elapsedMs.toFixed(2)} ms)`);
  });

  test('R2: filtro por tags (case-insensitive) restringe os resultados corretamente', () => {
    const nginxDoc: ContextDocument = {
      id: 'd-nginx',
      name: 'nginx.md',
      tags: ['Nginx', 'Web'],
      addedAt: '2026-11-21T00:00:00.000Z',
      points: [],
      chunks: chunkDocument('nginx.md', '# Nginx\nErro 502 upstream timeout no proxy reverso.', { tags: ['Nginx'] }),
    };
    const k8sDoc: ContextDocument = {
      id: 'd-k8s',
      name: 'k8s.md',
      tags: ['K8s', 'Ingress'],
      addedAt: '2026-11-21T00:00:00.000Z',
      points: [],
      chunks: chunkDocument('k8s.md', '# Ingress\nErro 502 upstream no ingress controller do kubernetes.', { tags: ['K8s'] }),
    };

    const onlyK8s = searchChunks([nginxDoc, k8sDoc], 'erro 502 upstream', { tags: ['k8s'] });
    assert.equal(onlyK8s.length, 1);
    assert.equal(onlyK8s[0].docName, 'k8s.md');

    const none = searchChunks([nginxDoc, k8sDoc], 'erro 502 upstream', { tags: ['postgres'] });
    assert.equal(none.length, 0);
  });

  test('R3: respeita topK, maxChars e formatContextBlock', () => {
    const chunks = chunkDocument('runbook-ops.md', RUNBOOK_MD);
    const docs: ContextDocument[] = [
      { id: 'doc-1', name: 'runbook-ops.md', tags: [], addedAt: '2026-11-21T00:00:00.000Z', points: [], chunks },
    ];

    const limitedTopK = searchChunks(docs, 'nginx postgres redis disk dns erro logs', { topK: 2, maxChars: 5000 });
    assert.equal(limitedTopK.length, 2);

    const limitedChars = searchChunks(docs, 'nginx postgres redis disk dns erro logs', { topK: 5, maxChars: 420 });
    const totalChars = limitedChars.reduce((acc, c) => acc + c.text.length, 0);
    assert.ok(totalChars <= 420, `Total de chars (${totalChars}) excedeu maxChars (420)`);

    const formatted = formatContextBlock(limitedTopK, 300);
    assert.ok(formatted.startsWith('[DOCUMENTAÇÃO OFICIAL RELEVANTE]\n'));
    assert.ok(formatted.length <= 300);
  });

  test('R4: chunking de .txt/.pdf quebra por parágrafo com overlap', () => {
    const p1 = 'Paragrafo um sobre monitoramento de disco e particoes cheias no servidor Linux principal.';
    const p2 = 'Paragrafo dois explicando rotacao de logs com logrotate e limpeza segura de arquivos antigos.';
    const p3 = 'Paragrafo tres detalhando alertas de telemetria e verificacao de inodes com df menos i.';
    const text = `${p1}\n\n${p2}\n\n${p3}`;

    const chunks = chunkDocument('guia-disco.pdf', text, { chunkSize: 140, overlap: 40 });
    assert.ok(chunks.length >= 2, `Esperado >= 2 chunks, obtido ${chunks.length}`);

    // Verifica que há overlap textual entre chunk 0 e chunk 1
    const tailOfFirst = chunks[0].text.slice(-30).trim();
    assert.ok(
      chunks[1].text.includes(tailOfFirst),
      `Chunk 1 deveria conter overlap do final do Chunk 0 ("${tailOfFirst}")`,
    );
  });
});

// ============================================================================
// FASE B — exec.command (testes unitários + adversariais)
// ============================================================================

describe('ADR-007 Fase B — exec.command (validador adversarial + execução segura)', () => {
  const localReadonlyPolicy: ExecPolicy = {
    transport: 'local',
    mode: 'readonly',
    allowedPrefixes: [...DEFAULT_READONLY_PREFIXES],
    allowedHosts: [],
  };

  test('E1: parseArgv e extractCommand aceitam JSON, markdown fence e linha única; rejeitam múltiplas linhas', () => {
    assert.deepEqual(parseArgv(`grep -E "erro 502" '/var/log/nginx/error.log'`), [
      'grep',
      '-E',
      'erro 502',
      '/var/log/nginx/error.log',
    ]);

    const fromJson = extractCommand(JSON.stringify({ command: 'df -h', host: 'prod-01', reason: 'checar disco' }));
    assert.equal(fromJson.ok, true);
    if (fromJson.ok) {
      assert.equal(fromJson.command, 'df -h');
      assert.equal(fromJson.host, 'prod-01');
      assert.equal(fromJson.reason, 'checar disco');
    }

    const fromFence = extractCommand('Aqui está o comando:\n```bash\nuptime\n```');
    assert.equal(fromFence.ok, true);
    if (fromFence.ok) assert.equal(fromFence.command, 'uptime');

    const multiLine = extractCommand('uname -s\ndf -h');
    assert.equal(multiLine.ok, false);
    if (!multiLine.ok) assert.equal(multiLine.code, 'EXEC_POLICY_DENIED');
  });

  test('E2 (Adversarial): shell injection bloqueada com EXEC_POLICY_DENIED', () => {
    const attacks = [
      'df -h; rm -rf /',
      'uptime && cat /etc/shadow',
      'uptime || id',
      'ls $(whoami)',
      'ps `id`',
      'cat /etc/hosts > /tmp/x',
      'cat /etc/hosts >> /tmp/x',
      'cat < /etc/passwd',
      'ps aux | grep node',
    ];

    for (const cmd of attacks) {
      const res = validateCommand(cmd, localReadonlyPolicy);
      assert.equal(res.ok, false, `Ataque deveria ser bloqueado: ${cmd}`);
      if (!res.ok) {
        assert.equal(res.code, 'EXEC_POLICY_DENIED', `Código esperado EXEC_POLICY_DENIED para: ${cmd}`);
      }
    }
  });

  test('E3 (Adversarial): binários destrutivos bloqueados mesmo se colocados em allowedPrefixes', () => {
    const permissivePolicy: ExecPolicy = {
      transport: 'local',
      mode: 'allowlist',
      allowedPrefixes: ['rm', 'shutdown', 'chmod', 'mkfs', '/sbin/mkfs.ext4', 'dd', 'kill'],
      allowedHosts: [],
    };

    const destructive = [
      'rm -rf /tmp/x',
      'shutdown -h now',
      'chmod -R 777 /tmp',
      '/sbin/mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/tmp/disk',
      'kill -9 1',
    ];

    for (const cmd of destructive) {
      const res = validateCommand(cmd, permissivePolicy);
      assert.equal(res.ok, false, `Binário destrutivo deveria ser bloqueado: ${cmd}`);
      if (!res.ok) assert.equal(res.code, 'EXEC_POLICY_DENIED');
    }
  });

  test('E4: fronteira de palavra na allowlist de prefixos ("df" casa "df -h", NÃO casa "dfx")', () => {
    const ok1 = validateCommand('df', localReadonlyPolicy);
    assert.equal(ok1.ok, true);

    const ok2 = validateCommand('df -h', localReadonlyPolicy);
    assert.equal(ok2.ok, true);

    const bad = validateCommand('dfx -h', localReadonlyPolicy);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, 'EXEC_POLICY_DENIED');
  });

  test('E5 (Adversarial): host injection e allowedHosts vazio bloqueados em modo SSH', () => {
    const sshPolicy: ExecPolicy = {
      transport: 'ssh',
      mode: 'readonly',
      allowedPrefixes: ['uptime', 'df'],
      allowedHosts: ['staging-api', 'prod-readonly-01'],
    };

    // Host começando com hífen (flag injection -oProxyCommand=...)
    const flagInj = validateCommand(
      JSON.stringify({ command: 'uptime', host: '-oProxyCommand=id' }),
      { ...sshPolicy, allowedHosts: ['-oProxyCommand=id', 'staging-api'] },
    );
    assert.equal(flagInj.ok, false);
    if (!flagInj.ok) assert.equal(flagInj.code, 'EXEC_POLICY_DENIED');

    // Host fora de allowedHosts
    const outside = validateCommand(JSON.stringify({ command: 'uptime', host: 'prod-db-01' }), sshPolicy);
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.equal(outside.code, 'EXEC_POLICY_DENIED');

    // allowedHosts vazio recusa SSH
    const emptyHosts = validateCommand(
      JSON.stringify({ command: 'uptime', host: 'staging-api' }),
      { ...sshPolicy, allowedHosts: [] },
    );
    assert.equal(emptyHosts.ok, false);
    if (!emptyHosts.ok) assert.equal(emptyHosts.code, 'EXEC_POLICY_DENIED');

    // Host válido passa
    const valid = validateCommand(JSON.stringify({ command: 'uptime', host: 'staging-api' }), sshPolicy);
    assert.equal(valid.ok, true);
    if (valid.ok) assert.equal(valid.host, 'staging-api');
  });

  test('E6: dryRun=true valida, grava audit log e emite preview sem executar processo', async () => {
    const tmp = makeTempAuditPath();
    try {
      const sourceOne: NodeTypeDef = {
        type: 'test.src',
        sourceOnly: true,
        inputs: [],
        outputs: [{ name: 'out', type: 'phrase' }],
        create: (ctx) => ({
          async start() {
            await ctx.emit('out', 'uname -s', { meta: { trace: { tAsrMs: 123 } } });
          },
          async onInput() {},
          async stop() {},
        }),
      };

      const collected: Envelope[] = [];
      const sinkNode: NodeTypeDef = {
        type: 'test.sink',
        sink: true,
        inputs: [{ name: 'in', type: 'phrase' }],
        outputs: [],
        create: () => ({
          async start() {},
          async onInput(_p, msg) {
            collected.push(msg);
          },
          async stop() {},
        }),
      };

      const reg = createRegistry().register(sourceOne).register(execCommand).register(sinkNode);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'test.src' },
          { id: 'exec', type: 'exec.command', params: { dryRun: true, auditLogPath: tmp.file } },
          { id: 'sink', type: 'test.sink' },
        ],
        edges: [
          { from: 'src.out', to: 'exec.in' },
          { from: 'exec.out', to: 'sink.in' },
        ],
      };

      const rg = await runGraph(flow, reg, { runId: 'run-dry-1' });
      await rg.done;

      assert.equal(collected.length, 1);
      assert.match(String(collected[0].payload), /\[DRY-RUN\]/);
      assert.equal((collected[0].meta?.exec as Record<string, unknown>)?.dryRun, true);
      assert.equal((collected[0].meta?.trace as Record<string, unknown>)?.tAsrMs, 123);
      assert.equal(typeof (collected[0].meta?.trace as Record<string, unknown>)?.tExecStartMs, 'number');

      const lines = readAuditLines(tmp.file);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].dryRun, true);
      assert.equal(lines[0].decision, 'dry_run');
      assert.equal(lines[0].command, 'uname -s');
    } finally {
      tmp.cleanup();
    }
  });

  test('E7: execução local real controlada ("uname -s" com dryRun=false) retorna Darwin, exitCode=0 e audit log', async () => {
    const tmp = makeTempAuditPath();
    try {
      const sourceOne: NodeTypeDef = {
        type: 'test.src',
        sourceOnly: true,
        inputs: [],
        outputs: [{ name: 'out', type: 'phrase' }],
        create: (ctx) => ({
          async start() {
            await ctx.emit('out', 'uname -s');
          },
          async onInput() {},
          async stop() {},
        }),
      };

      const collected: Envelope[] = [];
      const sinkNode: NodeTypeDef = {
        type: 'test.sink',
        sink: true,
        inputs: [{ name: 'in', type: 'phrase' }],
        outputs: [],
        create: () => ({
          async start() {},
          async onInput(_p, msg) {
            collected.push(msg);
          },
          async stop() {},
        }),
      };

      const reg = createRegistry().register(sourceOne).register(execCommand).register(sinkNode);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'test.src' },
          { id: 'exec', type: 'exec.command', params: { transport: 'local', mode: 'readonly', dryRun: false, auditLogPath: tmp.file } },
          { id: 'sink', type: 'test.sink' },
        ],
        edges: [
          { from: 'src.out', to: 'exec.in' },
          { from: 'exec.out', to: 'sink.in' },
        ],
      };

      const rg = await runGraph(flow, reg);
      await rg.done;

      assert.equal(collected.length, 1);
      assert.match(String(collected[0].payload), /Darwin/);
      const execMeta = collected[0].meta?.exec as Record<string, unknown>;
      assert.equal(execMeta.exitCode, 0);
      assert.equal(execMeta.dryRun, false);
      assert.equal(execMeta.timedOut, false);
      assert.equal(execMeta.host, 'local');

      const lines = readAuditLines(tmp.file);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].decision, 'allowed');
      assert.equal(lines[0].exitCode, 0);
      assert.equal(lines[0].dryRun, false);
    } finally {
      tmp.cleanup();
    }
  });

  test('E8: timeout mata processo filho que excede timeoutMs e retorna timedOut=true', async () => {
    const tmp = makeTempAuditPath();
    try {
      const sourceOne: NodeTypeDef = {
        type: 'test.src',
        sourceOnly: true,
        inputs: [],
        outputs: [{ name: 'out', type: 'phrase' }],
        create: (ctx) => ({
          async start() {
            await ctx.emit('out', 'sleep 5');
          },
          async onInput() {},
          async stop() {},
        }),
      };

      const collected: Envelope[] = [];
      const sinkNode: NodeTypeDef = {
        type: 'test.sink',
        sink: true,
        inputs: [{ name: 'in', type: 'phrase' }],
        outputs: [],
        create: () => ({
          async start() {},
          async onInput(_p, msg) {
            collected.push(msg);
          },
          async stop() {},
        }),
      };

      const reg = createRegistry().register(sourceOne).register(execCommand).register(sinkNode);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'test.src' },
          {
            id: 'exec',
            type: 'exec.command',
            params: {
              transport: 'local',
              mode: 'allowlist',
              dryRun: false,
              allowedPrefixes: ['sleep'],
              timeoutMs: 150,
              auditLogPath: tmp.file,
            },
          },
          { id: 'sink', type: 'test.sink' },
        ],
        edges: [
          { from: 'src.out', to: 'exec.in' },
          { from: 'exec.out', to: 'sink.in' },
        ],
      };

      const t0 = performance.now();
      const rg = await runGraph(flow, reg);
      await rg.done;
      const elapsed = performance.now() - t0;

      assert.ok(elapsed < 2500, `Timeout deveria ter matado sleep 5 rapidamente (levou ${elapsed.toFixed(0)} ms)`);
      assert.equal(collected.length, 1);
      const execMeta = collected[0].meta?.exec as Record<string, unknown>;
      assert.equal(execMeta.timedOut, true);
      assert.equal(rg.snapshot().nodes.exec.counters['exec.command.killed'], 1);

      const lines = readAuditLines(tmp.file);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].timedOut, true);
    } finally {
      tmp.cleanup();
    }
  });

  test('E9: interrupt (ADR-006) via emitControl aborta processo filho em voo', async () => {
    const tmp = makeTempAuditPath();
    try {
      const sourceInterrupt: NodeTypeDef = {
        type: 'test.src_interrupt',
        sourceOnly: true,
        inputs: [],
        outputs: [{ name: 'out', type: 'phrase' }],
        create: (ctx) => ({
          async start() {
            await ctx.emit('out', 'sleep 5');
            await new Promise((r) => setTimeout(r, 120));
            ctx.emitControl('out', {
              kind: 'interrupt',
              scope: 'port',
              sourceNode: ctx.id,
              reason: 'barge-in-test',
            });
          },
          async onInput() {},
          async stop() {},
        }),
      };

      const collected: Envelope[] = [];
      const sinkNode: NodeTypeDef = {
        type: 'test.sink',
        sink: true,
        inputs: [{ name: 'in', type: 'phrase' }],
        outputs: [],
        create: () => ({
          async start() {},
          async onInput(_p, msg) {
            collected.push(msg);
          },
          async stop() {},
        }),
      };
      const reg = createRegistry().register(sourceInterrupt).register(execCommand).register(sinkNode);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'test.src_interrupt' },
          {
            id: 'exec',
            type: 'exec.command',
            params: {
              transport: 'local',
              mode: 'allowlist',
              dryRun: false,
              allowedPrefixes: ['sleep'],
              timeoutMs: 10_000,
              auditLogPath: tmp.file,
            },
          },
          { id: 'sink', type: 'test.sink' },
        ],
        edges: [
          { from: 'src.out', to: 'exec.in' },
          { from: 'exec.out', to: 'sink.in' },
        ],
      };

      const t0 = performance.now();
      const rg = await runGraph(flow, reg);
      await rg.done;
      const elapsed = performance.now() - t0;

      assert.ok(elapsed < 2500, `Interrupt deveria ter abortado sleep 5 rapidamente (levou ${elapsed.toFixed(0)} ms)`);
      assert.ok(
        (rg.snapshot().nodes.exec.counters['exec.command.killed'] ?? 0) >= 1,
        'Contador exec.command.killed deveria ser >= 1',
      );
      const lines = readAuditLines(tmp.file);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].reason, 'interrupted');
    } finally {
      tmp.cleanup();
    }
  });

  test('E10: comando bloqueado no grafo emite node_error EXEC_POLICY_DENIED e grava audit log denied', async () => {
    const tmp = makeTempAuditPath();
    try {
      const sourceBad: NodeTypeDef = {
        type: 'test.src_bad',
        sourceOnly: true,
        inputs: [],
        outputs: [{ name: 'out', type: 'phrase' }],
        create: (ctx) => ({
          async start() {
            await ctx.emit('out', 'df -h; rm -rf /');
          },
          async onInput() {},
          async stop() {},
        }),
      };

      const sinkNode: NodeTypeDef = {
        type: 'test.sink',
        sink: true,
        inputs: [{ name: 'in', type: 'phrase' }],
        outputs: [],
        create: () => ({
          async start() {},
          async onInput() {},
          async stop() {},
        }),
      };
      const reg = createRegistry().register(sourceBad).register(execCommand).register(sinkNode);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'test.src_bad' },
          { id: 'exec', type: 'exec.command', params: { dryRun: false, auditLogPath: tmp.file } },
          { id: 'sink', type: 'test.sink' },
        ],
        edges: [
          { from: 'src.out', to: 'exec.in' },
          { from: 'exec.out', to: 'sink.in' },
        ],
      };

      const rg = await runGraph(flow, reg);
      await rg.done;

      const errEvt = rg
        .eventsSnapshot()
        .find((e) => e.type === 'node_error' && e.nodeId === 'exec' && e.code === 'EXEC_POLICY_DENIED');
      assert.ok(errEvt && errEvt.type === 'node_error', 'Deve emitir evento node_error EXEC_POLICY_DENIED');
      assert.equal(errEvt.code, 'EXEC_POLICY_DENIED');

      const lines = readAuditLines(tmp.file);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].decision, 'denied');
    } finally {
      tmp.cleanup();
    }
  });

  test('E11: saída maior que maxOutputBytes é truncada preservando o final com marcador [truncado]', async () => {
    const tmp = makeTempAuditPath();
    try {
      const sourceLong: NodeTypeDef = {
        type: 'test.src_long',
        sourceOnly: true,
        inputs: [],
        outputs: [{ name: 'out', type: 'phrase' }],
        create: (ctx) => ({
          async start() {
            await ctx.emit('out', 'seq 1 200');
          },
          async onInput() {},
          async stop() {},
        }),
      };

      const collected: Envelope[] = [];
      const sinkNode: NodeTypeDef = {
        type: 'test.sink',
        sink: true,
        inputs: [{ name: 'in', type: 'phrase' }],
        outputs: [],
        create: () => ({
          async start() {},
          async onInput(_p, msg) {
            collected.push(msg);
          },
          async stop() {},
        }),
      };

      const reg = createRegistry().register(sourceLong).register(execCommand).register(sinkNode);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'test.src_long' },
          {
            id: 'exec',
            type: 'exec.command',
            params: {
              transport: 'local',
              mode: 'allowlist',
              dryRun: false,
              allowedPrefixes: ['seq'],
              maxOutputBytes: 80,
              auditLogPath: tmp.file,
            },
          },
          { id: 'sink', type: 'test.sink' },
        ],
        edges: [
          { from: 'src.out', to: 'exec.in' },
          { from: 'exec.out', to: 'sink.in' },
        ],
      };

      const rg = await runGraph(flow, reg);
      await rg.done;

      assert.equal(collected.length, 1);
      const outText = String(collected[0].payload);
      assert.ok(outText.includes('[truncado]'), 'Saída deve incluir marcador [truncado]');
      assert.ok(outText.includes('200'), 'Deve preservar o final da saída (número 200)');
      const execMeta = collected[0].meta?.exec as Record<string, unknown>;
      assert.equal(execMeta.truncated, true);
      assert.equal(execMeta.exitCode, 0);
    } finally {
      tmp.cleanup();
    }
  });

  test('E12 (Adversarial): bypass via "&" simples (background) bloqueado com EXEC_POLICY_DENIED', () => {
    const attacks = ['df -h & rm -rf /', 'uptime & whoami'];
    for (const cmd of attacks) {
      const res = validateCommand(cmd, localReadonlyPolicy);
      assert.equal(res.ok, false, `Ataque com & simples deveria ser bloqueado: ${cmd}`);
      if (!res.ok) {
        assert.equal(res.code, 'EXEC_POLICY_DENIED');
      }
    }
  });

  test('E13 (Adversarial): sshUser inválido (-oProxyCommand=id, root;id) bloqueado com EXEC_POLICY_DENIED antes de spawn e registrado no audit log', async () => {
    const baseSshPolicy: ExecPolicy = {
      transport: 'ssh',
      mode: 'readonly',
      allowedPrefixes: ['uptime'],
      allowedHosts: ['staging-api'],
      defaultHost: 'staging-api',
    };

    for (const badUser of ['-oProxyCommand=id', 'root;id', 'admin user']) {
      const res = validateCommand('uptime', { ...baseSshPolicy, sshUser: badUser });
      assert.equal(res.ok, false, `sshUser inválido deveria ser bloqueado: ${badUser}`);
      if (!res.ok) assert.equal(res.code, 'EXEC_POLICY_DENIED');
    }

    // sshUser válido passa
    const ok = validateCommand('uptime', { ...baseSshPolicy, sshUser: 'ops_user-01.ro' });
    assert.equal(ok.ok, true);

    // No grafo, dryRun=false com sshUser malicioso deve emitir EXEC_POLICY_DENIED e gravar audit log denied sem spawn
    const tmp = makeTempAuditPath();
    try {
      const sourceOne: NodeTypeDef = {
        type: 'test.src_ssh_user',
        sourceOnly: true,
        inputs: [],
        outputs: [{ name: 'out', type: 'phrase' }],
        create: (ctx) => ({
          async start() {
            await ctx.emit('out', 'uptime');
          },
          async onInput() {},
          async stop() {},
        }),
      };
      const sinkNode: NodeTypeDef = {
        type: 'test.sink',
        sink: true,
        inputs: [{ name: 'in', type: 'phrase' }],
        outputs: [],
        create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
      };

      const reg = createRegistry().register(sourceOne).register(execCommand).register(sinkNode);
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          { id: 'src', type: 'test.src_ssh_user' },
          {
            id: 'exec',
            type: 'exec.command',
            params: {
              transport: 'ssh',
              mode: 'readonly',
              dryRun: false,
              allowedPrefixes: ['uptime'],
              allowedHosts: ['staging-api'],
              defaultHost: 'staging-api',
              sshUser: '-oProxyCommand=id',
              auditLogPath: tmp.file,
            },
          },
          { id: 'sink', type: 'test.sink' },
        ],
        edges: [
          { from: 'src.out', to: 'exec.in' },
          { from: 'exec.out', to: 'sink.in' },
        ],
      };

      const rg = await runGraph(flow, reg);
      await rg.done;

      const errEvt = rg
        .eventsSnapshot()
        .find((e) => e.type === 'node_error' && e.nodeId === 'exec' && e.code === 'EXEC_POLICY_DENIED');
      assert.ok(errEvt && errEvt.type === 'node_error', 'Deve emitir node_error EXEC_POLICY_DENIED para sshUser malicioso');

      const lines = readAuditLines(tmp.file);
      assert.equal(lines.length, 1);
      assert.equal(lines[0].decision, 'denied');
      assert.match(String(lines[0].reason), /sshUser/i);
    } finally {
      tmp.cleanup();
    }
  });

  test('E14: escape POSIX do SSH (quotePosix e buildSshRemoteCommand) envolve cada token em single quotes', () => {
    assert.equal(quotePosix('df'), `'df'`);
    assert.equal(quotePosix('erro 502'), `'erro 502'`);
    assert.equal(quotePosix("it's a $HOME"), `'it'\\''s a $HOME'`);

    const argv = parseArgv(`grep -E "erro 502" '/var/log/nginx/error.log'`);
    assert.equal(
      buildSshRemoteCommand(argv),
      `'grep' '-E' 'erro 502' '/var/log/nginx/error.log'`,
    );
  });
});

describe('ADR-007 Integração — llm.omlx + RAG automático (context/docs.json)', () => {
  test('R5: useContext: false não injeta vs useContext: true injeta topK respeitando contextMaxChars', async () => {
    const prevDir = process.env.FALADOR_CONTEXT_DIR;
    const ctxDir = mkdtempSync(join(tmpdir(), 'falador-ctx-test-'));
    const capturedSystems: string[] = [];

    const mockServer = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
        const sys = parsed.messages?.find((m) => m.role === 'system')?.content ?? '';
        capturedSystems.push(sys);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });

    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const addr = mockServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    try {
      const md = [
        '# Runbook Nginx',
        '## Erro 502 Upstream',
        'Verifique nginx upstream timeout e rode journalctl -u nginx -n 50 para diagnosticar 502.',
        '## Disk Usage',
        'Use df -h para checar espaço em disco.',
        '## Redis Latency',
        'Verifique slowlog no redis-cli.',
      ].join('\n\n');
      const doc: ContextDocument = {
        id: 'doc-1',
        name: 'runbook-ops.md',
        tags: ['ops', 'nginx'],
        addedAt: new Date().toISOString(),
        points: ['Verificar upstream 502'],
        chunks: chunkDocument('runbook-ops.md', md, { tags: ['ops', 'nginx'] }),
        text: md,
      };
      writeFileSync(join(ctxDir, 'docs.json'), JSON.stringify([doc]));
      process.env.FALADOR_CONTEXT_DIR = ctxDir;

      const srcQuery: NodeTypeDef = {
        type: 'test.src_query',
        sourceOnly: true,
        inputs: [],
        outputs: [{ name: 'out', type: 'phrase' }],
        create: (ctx) => ({
          async start() {
            await ctx.emit('out', 'erro 502 nginx upstream');
          },
          async onInput() {},
          async stop() {},
        }),
      };
      const sinkNoop: NodeTypeDef = {
        type: 'test.sink_noop',
        sink: true,
        inputs: [{ name: 'in', type: 'tokens_parcial' }],
        outputs: [],
        create: () => ({ async start() {}, async onInput() {}, async stop() {} }),
      };

      const reg = registerFaladorNodes(createRegistry()).register(srcQuery).register(sinkNoop);
      assert.ok(reg.has('turn.detector'), 'turn.detector registrado no registry');
      assert.ok(reg.has('exec.command'), 'exec.command registrado no registry');

      // 1) useContext: false -> não injeta documentação
      const rgFalse = await runGraph(
        {
          version: 1,
          stopWhenSourcesDone: true,
          nodes: [
            { id: 'src', type: 'test.src_query' },
            {
              id: 'llm',
              type: 'llm.omlx',
              params: {
                baseUrl: `http://127.0.0.1:${port}`,
                system: 'BASE_SYSTEM',
                enableThinking: false,
                useContext: false,
              },
            },
            { id: 'snk', type: 'test.sink_noop' },
          ],
          edges: [
            { from: 'src.out', to: 'llm.in' },
            { from: 'llm.out', to: 'snk.in' },
          ],
        },
        reg,
      );
      await rgFalse.done;

      // 2) useContext: true -> injeta chunk relevante respeitando contextMaxChars
      const rgTrue = await runGraph(
        {
          version: 1,
          stopWhenSourcesDone: true,
          nodes: [
            { id: 'src', type: 'test.src_query' },
            {
              id: 'llm',
              type: 'llm.omlx',
              params: {
                baseUrl: `http://127.0.0.1:${port}`,
                system: 'BASE_SYSTEM',
                enableThinking: false,
                useContext: true,
                contextTopK: 1,
                contextMaxChars: 140,
              },
            },
            { id: 'snk', type: 'test.sink_noop' },
          ],
          edges: [
            { from: 'src.out', to: 'llm.in' },
            { from: 'llm.out', to: 'snk.in' },
          ],
        },
        reg,
      );
      await rgTrue.done;

      assert.equal(capturedSystems.length, 2);
      assert.equal(capturedSystems[0], 'BASE_SYSTEM', 'useContext: false não deve injetar RAG');
      assert.ok(
        capturedSystems[1].includes('[DOCUMENTAÇÃO OFICIAL RELEVANTE]'),
        'useContext: true deve injetar bloco de documentação',
      );
      assert.ok(
        capturedSystems[1].toLowerCase().includes('nginx'),
        'useContext: true deve recuperar chunk de Nginx',
      );
      const injectedPart = capturedSystems[1].slice('BASE_SYSTEM\n\n'.length);
      assert.ok(
        injectedPart.length <= 140,
        `Bloco injetado (${injectedPart.length}) deve respeitar contextMaxChars (140)`,
      );
    } finally {
      if (prevDir === undefined) delete process.env.FALADOR_CONTEXT_DIR;
      else process.env.FALADOR_CONTEXT_DIR = prevDir;
      rmSync(ctxDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});
