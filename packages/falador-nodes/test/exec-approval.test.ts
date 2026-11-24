// aprovação de comando fora da allowlist: vale só para a execução atual
import assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execCommand, validateCommand, type ExecPolicy } from '../src/exec-command.ts';

const policy: ExecPolicy = {
  transport: 'local',
  mode: 'allowlist',
  allowedPrefixes: ['ls'],
  allowedHosts: [],
};

function makeCtx(gate?: { request(text: string, meta?: Record<string, unknown>): Promise<string | null> }) {
  const ctl = new AbortController();
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      id: 'exec1',
      params: {
        transport: 'local',
        mode: 'allowlist',
        dryRun: true,
        allowedPrefixes: ['ls'],
        auditLogPath: join(tmpdir(), 'falador-exec-approval-audit.jsonl'),
      },
      bindings: gate ? { __gate: { request: gate } } : {},
      signal: ctl.signal,
      log: () => {},
      metrics: { counter: () => {}, timer: () => {} },
      emit: async () => {},
    },
  };
}

async function invoke(gate?: { request(text: string, meta?: Record<string, unknown>): Promise<string | null> }, command = 'uname -a') {
  const { ctx, calls } = makeCtx(gate);
  const rt = execCommand.create(ctx as never);
  const res = await rt.toolProvider!.invoke(
    'exec_local',
    { command },
    { signal: new AbortController().signal, runId: 'r1', callerNodeId: 'a1' },
  );
  return { res, calls };
}

test('validateCommand: aprovação libera prefixo, destrutivo e metacaracteres', () => {
  assert.equal(validateCommand('uname -a', policy, { approved: true }).ok, true);
  assert.equal(validateCommand('rm -rf /tmp/x', policy, { approved: true }).ok, true);
  assert.equal(validateCommand('echo oi && ls', policy, { approved: true }).ok, true);
});

test('SSH: allowedHosts vazio também é pergunta, não proibição', () => {
  const ssh: ExecPolicy = { ...policy, transport: 'ssh', allowedHosts: [] };
  assert.equal(validateCommand({ command: 'uptime', host: 'srv.example.com' }, ssh).ok, false);
  assert.equal(validateCommand({ command: 'uptime', host: 'srv.example.com' }, ssh, { approved: true }).ok, true);
});

test('comando na allowlist roda sem chamar gate', async () => {
  let asked = 0;
  const { res } = await invoke(
    {
      request: async () => {
        asked += 1;
        return null;
      },
    },
    'ls -la',
  );
  assert.equal(asked, 0);
  assert.equal(res.ok, true);
});

test('fora da allowlist: aprovado roda nesta exec; negado não roda', async () => {
  const approved = await invoke(async () => 'uname -a');
  assert.equal(approved.res.ok, true);

  const rejected = await invoke(async () => null);
  assert.equal(rejected.res.ok, false);
  assert.match(rejected.res.output, /negado pelo usuário/);
});

test('rm -f: aprovado executa nesta vez; negado não executa', async () => {
  const approved = await invoke(async () => 'rm -f /tmp/x');
  assert.equal(approved.res.ok, true);

  const rejected = await invoke(async () => null, 'rm -f /tmp/x');
  assert.equal(rejected.res.ok, false);
  assert.match(rejected.res.output, /negado pelo usuário/);
});

test('ferramenta exec declara selfApproval (agente não pergunta de novo)', async () => {
  const { ctx } = makeCtx();
  const rt = execCommand.create(ctx as never);
  const tools = await rt.toolProvider!.listTools();
  assert.equal(tools[0]?.selfApproval, true);
});
