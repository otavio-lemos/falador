// Níveis de aprovação globais (A/B/C) no exec.command:
//   ask_all      → abrir gate SEMPRE (mesmo comando já na allowlist)
//   non_readonly → allowlist livre; recusa/mutação abre gate (comportamento padrão)
//   approve_all  → não abre gate; executa pré-aprovado
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { execCommand } from '../src/exec-command.ts';

function mk(approvalLevel: string, gate?: (text: string) => Promise<string | null>) {
  const ctl = new AbortController();
  let asked = 0;
  const ctx = {
    id: 'exec1',
    params: {
      transport: 'local',
      mode: 'allowlist',
      dryRun: false,
      allowedPrefixes: ['ls'],
      approvalLevel,
      auditLogPath: join(tmpdir(), `falador-exec-lvl-${approvalLevel}.jsonl`),
    },
    bindings: gate
      ? { __gate: { request: async (t: string) => { asked += 1; return gate(t); } } }
      : {},
    signal: ctl.signal,
    log: () => {},
    metrics: { counter: () => {}, timer: () => {} },
    emit: async () => {},
  };
  const rt = execCommand.create(ctx as never);
  return {
    asked: () => asked,
    invoke: (command: string) =>
      rt.toolProvider!.invoke('exec_local', { command }, { signal: new AbortController().signal, runId: 'r1', callerNodeId: 'a1' }),
  };
}

test('nível A (ask_all): comando JÁ na allowlist também abre gate e executa após aprovar', async () => {
  const { invoke, asked } = mk('ask_all', async () => 'ls -la');
  const res = await invoke('ls -la');
  assert.equal(asked(), 1);
  assert.equal(res.ok, true);
});

test('nível A (ask_all): recusa no gate não executa', async () => {
  const { invoke, asked } = mk('ask_all', async () => null);
  const res = await invoke('ls -la');
  assert.equal(asked(), 1);
  assert.equal(res.ok, false);
  assert.match(res.output, /negado pelo usuário/);
});

test('nível B (non_readonly): leitura na allowlist NÃO abre gate', async () => {
  const { invoke, asked } = mk('non_readonly', async () => null);
  const res = await invoke('ls -la');
  assert.equal(asked(), 0);
  assert.equal(res.ok, true);
});

test('nível B (non_readonly): fora da allowlist abre gate', async () => {
  const { invoke, asked } = mk('non_readonly', async () => 'uname -a');
  const res = await invoke('uname -a');
  assert.equal(asked(), 1);
  assert.equal(res.ok, true);
});

test('nível C (approve_all): fora da allowlist NÃO abre gate e executa', async () => {
  const { invoke, asked } = mk('approve_all', async () => null);
  const res = await invoke('uname -a');
  assert.equal(asked(), 0);
  assert.equal(res.ok, true);
});
