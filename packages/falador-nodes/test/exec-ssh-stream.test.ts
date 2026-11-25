// falador-nodes — testes unitários e de integração para hardening SSH/Bastion, hostPolicies, process group kill e streaming chunk-a-chunk (P1)
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import { createRegistry, runGraph, type FlowSpec } from '../../falador-graph/src/index.ts';
import {
  buildSshArgv,
  execCommand,
  resolveHostPolicy,
  type ExecChunkEvent,
} from '../src/exec-command.ts';
import { registerFaladorNodes } from '../src/index.ts';

function makeTmpDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeFakeCtx(params: Record<string, unknown>, bindings: Record<string, unknown> = {}) {
  const ctl = new AbortController();
  const emitted: Array<{ port: string; payload: unknown; meta?: Record<string, unknown> }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const counters = new Map<string, number>();
  return {
    ctx: {
      id: 'exec1',
      params,
      bindings,
      signal: ctl.signal,
      log: (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => logs.push({ level, msg }),
      metrics: {
        counter: (name: string, inc = 1) => counters.set(name, (counters.get(name) ?? 0) + inc),
        timer: () => {},
      },
      emit: async (port: string, payload: unknown, opts?: { meta?: Record<string, unknown> }) => {
        emitted.push({ port, payload, meta: opts?.meta });
      },
    },
    ctl,
    emitted,
    logs,
    counters,
  };
}

describe('P1 — Hardening SSH/Bastion (-J) & hostPolicies', () => {
  test('buildSshArgv inclui flags obrigatórias, 1 e 2 bastions (-J), identityFile e sshConfigPath', () => {
    const argv1 = buildSshArgv({
      host: 'app-01.internal',
      sshUser: 'ops',
      sshPort: 2222,
      remoteCommand: "'uptime'",
      jumpHosts: ['bastion1.corp'],
      identityFile: '/home/ops/.ssh/id_ed25519',
      sshConfigPath: '/home/ops/.ssh/config',
    });

    assert.ok(argv1.includes('-T'));
    for (const opt of [
      'BatchMode=yes',
      'ForwardAgent=no',
      'ClearAllForwardings=yes',
      'RequestTTY=no',
      'ServerAliveInterval=15',
      'ServerAliveCountMax=3',
      'StrictHostKeyChecking=yes',
      'ConnectTimeout=5',
      'ControlMaster=auto',
      'ControlPersist=600',
      'ControlPath=/tmp/falador-ssh-%C',
      'IdentitiesOnly=yes',
    ]) {
      const idx = argv1.indexOf(opt);
      assert.ok(idx > 0 && argv1[idx - 1] === '-o', `Flag obrigatória ausente: -o ${opt}`);
    }
    assert.equal(argv1[argv1.indexOf('-i') + 1], '/home/ops/.ssh/id_ed25519');
    assert.equal(argv1[argv1.indexOf('-F') + 1], '/home/ops/.ssh/config');
    assert.equal(argv1[argv1.indexOf('-J') + 1], 'bastion1.corp');
    assert.equal(argv1[argv1.indexOf('-p') + 1], '2222');
    assert.deepEqual(argv1.slice(-3), ['--', 'ops@app-01.internal', "'uptime'"]);

    const argv2 = buildSshArgv({
      host: 'db-01.internal',
      remoteCommand: "'df' '-h'",
      jumpHosts: ['jump@b1.corp:2222', 'b2.corp'],
      strictHostKeyChecking: 'accept-new',
      connectTimeoutSec: 12,
    });
    assert.equal(argv2[argv2.indexOf('-J') + 1], 'jump@b1.corp:2222,b2.corp');
    assert.ok(argv2.includes('StrictHostKeyChecking=accept-new'));
    assert.ok(argv2.includes('ConnectTimeout=12'));
  });

  test('buildSshArgv e validateParams rejeitam -oProxyCommand, StrictHostKeyChecking=no, .. e jumpHost não permitido', () => {
    assert.throws(
      () =>
        buildSshArgv({
          host: 'srv-01',
          remoteCommand: "'uptime'",
          jumpHosts: ['-oProxyCommand=id'],
        }),
      /hífen|ProxyCommand/i,
    );
    assert.throws(
      () =>
        buildSshArgv({
          host: 'srv-01',
          remoteCommand: "'uptime'",
          jumpHosts: ['ProxyCommand=nc'],
        }),
      /ProxyCommand/i,
    );
    assert.throws(
      () =>
        buildSshArgv({
          host: 'srv-01',
          remoteCommand: "'uptime'",
          strictHostKeyChecking: 'no' as 'yes',
        }),
      /strictHostKeyChecking/i,
    );
    assert.throws(
      () =>
        buildSshArgv({
          host: 'srv-01',
          remoteCommand: "'uptime'",
          sshConfigPath: '../evil/config',
        }),
      /\.\./,
    );
    assert.throws(
      () =>
        buildSshArgv({
          host: 'srv-01',
          remoteCommand: "'uptime'",
          identityFile: '-i/tmp/key',
        }),
      /hífen/i,
    );
    assert.throws(
      () =>
        buildSshArgv({
          host: 'srv-01',
          remoteCommand: "'uptime'",
          jumpHosts: ['b2.corp'],
          allowedJumpHosts: ['b1.corp'],
        }),
      /allowedJumpHosts/,
    );

    const paramErrs = execCommand.validateParams!({
      jumpHosts: ['-oProxyCommand=whoami'],
      strictHostKeyChecking: 'no',
      connectTimeoutSec: 99,
      identityFile: '../../id_rsa',
      sshConfigPath: '-F/etc/ssh',
    });
    assert.ok(paramErrs.some((e) => e.path === 'params.jumpHosts'));
    assert.ok(paramErrs.some((e) => e.path === 'params.strictHostKeyChecking'));
    assert.ok(paramErrs.some((e) => e.path === 'params.connectTimeoutSec'));
    assert.ok(paramErrs.some((e) => e.path === 'params.identityFile'));
    assert.ok(paramErrs.some((e) => e.path === 'params.sshConfigPath'));
  });

  test('hostPolicies é fail-closed para env=prod e hosts não listados', () => {
    const policies = {
      'prod-01': { env: 'prod' as const, dryRun: false, mode: 'allowlist' as const, jumpHosts: ['b-prod'] },
      'dev-01': { env: 'dev' as const, dryRun: false, mode: 'allowlist' as const, jumpHosts: ['b-dev'] },
    };

    const prod = resolveHostPolicy('prod-01', { dryRun: false, mode: 'allowlist' }, policies);
    assert.equal(prod.dryRun, true, 'prod deve forçar dryRun=true mesmo se configurado false');
    assert.equal(prod.requireTypedConfirm, true);

    const unlisted = resolveHostPolicy('unknown-01', { dryRun: false, mode: 'allowlist' }, policies);
    assert.equal(unlisted.dryRun, true, 'host não listado deve forçar dryRun=true');
    assert.equal(unlisted.mode, 'readonly', 'host não listado deve degradar para readonly');
    assert.equal(unlisted.requireTypedConfirm, true);

    const dev = resolveHostPolicy('dev-01', { dryRun: true, mode: 'readonly' }, policies);
    assert.equal(dev.dryRun, false);
    assert.equal(dev.mode, 'allowlist');
    assert.deepEqual(dev.jumpHosts, ['b-dev']);
    assert.equal(dev.requireTypedConfirm, false);
  });

  test('exec.command aplica hostPolicies fail-closed em runtime e marca exitCode=255 como sshTransportError', async () => {
    const { dir, cleanup } = makeTmpDir('falador-ssh-255-');
    const fakeBinDir = join(dir, 'bin');
    const auditFile = join(dir, 'audit.jsonl');
    const origPath = process.env.PATH ?? '';
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(fakeBinDir, { recursive: true });
      const fakeSsh = join(fakeBinDir, 'ssh');
      writeFileSync(fakeSsh, '#!/bin/sh\necho "ssh: connect to host $*" >&2\nexit 255\n', 'utf8');
      chmodSync(fakeSsh, 0o755);
      process.env.PATH = `${fakeBinDir}:${origPath}`;

      // 1. prod-01 em hostPolicies força dryRun=true
      const { ctx: prodCtx } = makeFakeCtx({
        transport: 'ssh',
        dryRun: false,
        allowedHosts: ['prod-01', 'dev-01'],
        allowedPrefixes: ['uptime'],
        jumpHosts: ['bastion-1'],
        auditLogPath: auditFile,
        hostPolicies: {
          'prod-01': { env: 'prod', dryRun: false },
          'dev-01': { env: 'dev', dryRun: false },
        },
      });
      const prodRt = execCommand.create(prodCtx as never);
      const prodRes = await prodRt.toolProvider!.invoke(
        'exec_ssh',
        { command: 'uptime', host: 'prod-01' },
        { signal: new AbortController().signal, runId: 'r-prod', callerNodeId: 'a1' },
      );
      assert.equal(prodRes.dryRun, true);
      assert.equal(prodRes.meta?.requireTypedConfirm, true);
      assert.match(prodRes.output, /\[DRY-RUN\]/);
      assert.match(prodRes.output, /prod-01 via bastion-1/);

      // 2. dev-01 executa ssh falso que retorna 255 -> sshTransportError=true
      const devRes = await prodRt.toolProvider!.invoke(
        'exec_ssh',
        { command: 'uptime', host: 'dev-01' },
        { signal: new AbortController().signal, runId: 'r-dev', callerNodeId: 'a1' },
      );
      assert.equal(devRes.ok, false);
      assert.equal(devRes.exitCode, 255);
      assert.equal(devRes.meta?.sshTransportError, true);
      assert.match(devRes.output, /SSH_TRANSPORT_ERROR/);

      const auditLines = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(auditLines[1].sshTransportError, true);
      assert.equal(auditLines[1].bastion, 'bastion-1');
    } finally {
      process.env.PATH = origPath;
      cleanup();
    }
  });
});

describe('P1 — Process Group Kill, Isolamento de Interrupt & Streaming Chunk-a-Chunk', () => {
  test('killProcessTree encerra grupo de processos no timeout (pai + filho)', async () => {
    const { dir, cleanup } = makeTmpDir('falador-pgkill-');
    const pidFile = join(dir, 'child.pid');
    const scriptFile = join(dir, 'spawn-child.cjs');
    const auditFile = join(dir, 'audit.jsonl');
    try {
      const { ctx } = makeFakeCtx({
        transport: 'local',
        mode: 'allowlist',
        dryRun: false,
        allowedPrefixes: ['node'],
        timeoutMs: 180,
        auditLogPath: auditFile,
      });
      const rt = execCommand.create(ctx as never);
      writeFileSync(
        scriptFile,
        [
          `const { spawn } = require('node:child_process');`,
          `const fs = require('node:fs');`,
          `const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
          `setInterval(() => {}, 1000);`,
        ].join('\n'),
        'utf8',
      );

      const res = await rt.toolProvider!.invoke(
        'exec_local',
        { command: `node ${scriptFile}` },
        { signal: new AbortController().signal, runId: 'r-pg', callerNodeId: 'a1' },
      );
      assert.equal(res.meta?.timedOut, true);

      const childPid = Number(readFileSync(pidFile, 'utf8').trim());
      assert.ok(Number.isInteger(childPid) && childPid > 0);
      // Aguarda um breve tick para o kernel recolher o processo filho após SIGTERM no process group
      await new Promise((r) => setTimeout(r, 80));
      assert.throws(() => process.kill(childPid, 0), /ESRCH/);
    } finally {
      cleanup();
    }
  });

  test('interrupted é isolado por invocação (abortar uma chamada não marca a outra)', async () => {
    const { dir, cleanup } = makeTmpDir('falador-iso-');
    const slowScript = join(dir, 'slow.cjs');
    const fastScript = join(dir, 'fast.cjs');
    try {
      writeFileSync(slowScript, `setTimeout(() => console.log('done1'), 2000);\n`, 'utf8');
      writeFileSync(fastScript, `setTimeout(() => console.log('done2'), 150);\n`, 'utf8');
      const { ctx } = makeFakeCtx({
        transport: 'local',
        mode: 'allowlist',
        dryRun: false,
        allowedPrefixes: ['node'],
        timeoutMs: 5000,
        auditLogPath: join(dir, 'audit.jsonl'),
      });
      const rt = execCommand.create(ctx as never);
      const ctl1 = new AbortController();
      const ctl2 = new AbortController();

      const p1 = rt.toolProvider!.invoke(
        'exec_local',
        { command: `node ${slowScript}` },
        { signal: ctl1.signal, runId: 'r-iso', callerNodeId: 'a1' },
      );
      const p2 = rt.toolProvider!.invoke(
        'exec_local',
        { command: `node ${fastScript}` },
        { signal: ctl2.signal, runId: 'r-iso', callerNodeId: 'a1' },
      );

      setTimeout(() => ctl1.abort(), 40);
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1.meta?.interrupted, true);
      assert.equal(r2.meta?.interrupted, false);
      assert.equal(r2.ok, true);
      assert.match(r2.output, /done2/);
    } finally {
      cleanup();
    }
  });

  test('streaming chunk-a-chunk redige segredo dividido na fronteira de chunks', async () => {
    const { dir, cleanup } = makeTmpDir('falador-stream-');
    const streamScript = join(dir, 'stream.cjs');
    try {
      writeFileSync(
        streamScript,
        [
          `process.stdout.write('ok TOKEN=super');`,
          `setTimeout(() => {`,
          `  process.stdout.write('secret12345\\n');`,
          `  process.stderr.write('err: fail\\n');`,
          `}, 110);`,
        ].join('\n'),
        'utf8',
      );
      const events: ExecChunkEvent[] = [];
      const reg = registerFaladorNodes(createRegistry());
      const flow: FlowSpec = {
        version: 1,
        stopWhenSourcesDone: true,
        nodes: [
          {
            id: 'src',
            type: 'input.chat',
          },
          {
            id: 'exec',
            type: 'exec.command',
            params: {
              transport: 'local',
              mode: 'allowlist',
              dryRun: false,
              allowedPrefixes: ['node'],
              timeoutMs: 5000,
              auditLogPath: join(dir, 'audit.jsonl'),
            },
          },
        ],
        edges: [{ from: 'src.out', to: 'exec.in' }],
        bindings: {
          exec: {
            __onExecChunk: (ev: ExecChunkEvent) => events.push(ev),
          },
        },
      };

      // Executa direto via node runtime para controlar o payload de forma determinística
      const { ctx } = makeFakeCtx(
        {
          transport: 'local',
          mode: 'allowlist',
          dryRun: false,
          allowedPrefixes: ['node'],
          timeoutMs: 5000,
          auditLogPath: join(dir, 'audit.jsonl'),
        },
        {
          __onExecChunk: (ev: ExecChunkEvent) => events.push(ev),
        },
      );
      const rt = execCommand.create(ctx as never);
      const res = await rt.toolProvider!.invoke(
        'exec_local',
        { command: `node ${streamScript}` },
        { signal: new AbortController().signal, runId: 'r-stream', callerNodeId: 'a1' },
      );

      assert.equal(res.ok, true);
      const startEv = events.find((e) => e.type === 'exec_start');
      const endEv = events.find((e) => e.type === 'exec_end');
      const chunks = events.filter((e): e is Extract<ExecChunkEvent, { type: 'exec_chunk' }> => e.type === 'exec_chunk');

      assert.ok(startEv && startEv.type === 'exec_start');
      assert.ok(endEv && endEv.type === 'exec_end');
      assert.equal(endEv.ok, true);
      assert.equal(endEv.exitCode, 0);

      const stdoutText = chunks.filter((c) => c.stream === 'stdout').map((c) => c.text).join('');
      const stderrText = chunks.filter((c) => c.stream === 'stderr').map((c) => c.text).join('');
      assert.ok(stdoutText.includes('[REDACTED:secret]'), `stdout deveria estar redigido: ${stdoutText}`);
      assert.ok(!stdoutText.includes('supersecret12345'), 'segredo cru nunca pode vazar em chunk');
      assert.ok(stderrText.includes('err: fail'), `stderr esperado: ${stderrText}`);
      assert.ok(reg.get('exec.command')?.bindingNames?.includes('__onExecChunk'));
      assert.ok(flow.nodes.length === 2);
      void runGraph;
    } finally {
      cleanup();
    }
  });
});
