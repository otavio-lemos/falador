// falador-cli — contrato do validador pós-run (validate-run.mjs, ADR-012):
// determinístico sobre a trilha de auditoria (logs/audit/<runId>.jsonl).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GENESIS_HASH, chainAuditEvent } from '../../falador-nodes/src/audit.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'validate-run.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'validate-run-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

function runValidate(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function trail(events) {
  const dir = mkdtempSync(join(tmp, 'audit-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const runId = 'run-test-' + Math.random().toString(36).slice(2);
  const lines = events.map((e, i) => JSON.stringify({ runId, seq: i + 1, ts: 1000 + i * 100, ...e })).join('\n') + '\n';
  writeFileSync(join(auditDir, `${runId}.jsonl`), lines, 'utf-8');
  return { dir, auditDir, runId };
}

const PASS_TRAIL = [
  { op: 'plan', plan: [{ id: '1', status: 'verified' }] },
  { op: 'tool_call', tool: 'exec_local', gate: 'approved', ok: true, exitCode: 0, durationMs: 10 },
  { op: 'goal_validation', validation: { achieved: true, confidence: 0.9, gaps: [], nextActions: [] } },
  { op: 'gate', gate: 'approved', nodeId: 'agente', tool: 'goal.confirm' },
  { op: 'agent_final', goalAchieved: true },
];

test('--help sem args sai 0 e imprime uso', async () => {
  const { code, stdout } = await runValidate(['--help'], {});
  assert.equal(code, 0);
  assert.match(stdout, /Usage/i);
});

test('args vazio sai 1 com erro', async () => {
  const { code, stdout, stderr } = await runValidate([], {});
  assert.equal(code, 1);
  assert.match(stdout + stderr, /Usage|runId/i);
});

test('trail válido: todas as regras PASS, exit 0', async () => {
  const { auditDir, runId } = trail(PASS_TRAIL);
  const { code, stdout } = await runValidate([runId], { FALADOR_AUDIT_DIR: auditDir, FALADOR_SESSIONS_DIR: join(tmp, 'sessions') });
  assert.equal(code, 0);
  assert.match(stdout, /Overall: PASS/i);
});

test('runId inexistente: exit 1 com mensagem', async () => {
  const auditDir = join(tmp, 'audit-missing');
  mkdirSync(auditDir, { recursive: true });
  const { code } = await runValidate(['run-nao-existe'], { FALADOR_AUDIT_DIR: auditDir });
  assert.equal(code, 1);
});

test('R1 no_missing_gate: tool_call com gate missing_gate ⇒ FAIL', async () => {
  const { auditDir, runId } = trail([
    { op: 'tool_call', tool: 'exec_local', gate: 'missing_gate', ok: false, exitCode: null, outputPreview: 'x' },
  ]);
  const { code, stdout } = await runValidate([runId], { FALADOR_AUDIT_DIR: auditDir });
  assert.equal(code, 1);
  assert.match(stdout, /no_missing_gate/i);
});

test('R2 rejected_not_executed: tool_call rejeitado mas ok:true ⇒ FAIL', async () => {
  const { auditDir, runId } = trail([
    { op: 'tool_call', tool: 'exec_local', gate: 'rejected', ok: true, exitCode: 0 },
  ]);
  const { code, stdout } = await runValidate([runId], { FALADOR_AUDIT_DIR: auditDir });
  assert.equal(code, 1);
  assert.match(stdout, /rejected_not_executed/i);
});

test('R3 validated_before_done: goalAchieved true sem goal_validation ⇒ FAIL', async () => {
  const { auditDir, runId } = trail([
    { op: 'agent_final', goalAchieved: true },
  ]);
  const { code, stdout } = await runValidate([runId], { FALADOR_AUDIT_DIR: auditDir });
  assert.equal(code, 1);
  assert.match(stdout, /validated_before_done/i);
});

test('R3 validated_before_done: goal_validation achieved mas gate aprovado ANTES dela ⇒ FAIL', async () => {
  const { auditDir, runId } = trail([
    { op: 'gate', gate: 'approved', nodeId: 'agente', tool: 'goal.confirm' },
    { op: 'goal_validation', validation: { achieved: true, confidence: 0.9, gaps: [], nextActions: [] } },
    { op: 'agent_final', goalAchieved: true },
  ]);
  const { code, stdout } = await runValidate([runId], { FALADOR_AUDIT_DIR: auditDir });
  assert.equal(code, 1);
  assert.match(stdout, /validated_before_done/i);
});

test('R4 plan_verified: goalAchieved true com item pendente no último plano ⇒ FAIL', async () => {
  const { auditDir, runId } = trail([
    { op: 'plan', plan: [{ id: '1', status: 'pending' }] },
    { op: 'goal_validation', validation: { achieved: true, confidence: 0.9, gaps: [], nextActions: [] } },
    { op: 'gate', gate: 'approved', nodeId: 'agente', tool: 'goal.confirm' },
    { op: 'agent_final', goalAchieved: true },
  ]);
  const { code, stdout } = await runValidate([runId], { FALADOR_AUDIT_DIR: auditDir });
  assert.equal(code, 1);
  assert.match(stdout, /plan_verified/i);
});

test('R5 errors_traceable: tool_call ok:false sem errorType/outputPreview ⇒ FAIL', async () => {
  const { auditDir, runId } = trail([
    { op: 'tool_call', tool: 'exec_local', gate: 'approved', ok: false, exitCode: 1 },
  ]);
  const { code, stdout } = await runValidate([runId], { FALADOR_AUDIT_DIR: auditDir });
  assert.equal(code, 1);
  assert.match(stdout, /errors_traceable/i);
});

test('R6 audit_chain_integrity: cadeia SHA-256 válida ⇒ PASS; adulterada ⇒ FAIL', async () => {
  const dir = mkdtempSync(join(tmp, 'audit-chain-'));
  const auditDir = join(dir, 'audit');
  mkdirSync(auditDir, { recursive: true });
  const runId = 'run-chain-ok';
  let prev = GENESIS_HASH;
  const chained = PASS_TRAIL.map((e, i) => {
    const rec = chainAuditEvent({ runId, seq: i + 1, ts: 1000 + i * 100, ...e }, prev);
    prev = rec.hash;
    return rec;
  });
  writeFileSync(join(auditDir, `${runId}.jsonl`), chained.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

  const okRes = await runValidate([runId], { FALADOR_AUDIT_DIR: auditDir, FALADOR_SESSIONS_DIR: join(tmp, 'sessions') });
  assert.equal(okRes.code, 0);
  assert.match(okRes.stdout, /audit_chain_integrity.*íntegra/i);

  // Adultera 1 campo no meio da cadeia
  const badRunId = 'run-chain-bad';
  const tampered = chained.map((r, i) => (i === 1 ? { ...r, exitCode: 99 } : r));
  writeFileSync(join(auditDir, `${badRunId}.jsonl`), tampered.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  const badRes = await runValidate([badRunId], { FALADOR_AUDIT_DIR: auditDir, FALADOR_SESSIONS_DIR: join(tmp, 'sessions') });
  assert.equal(badRes.code, 1);
  assert.match(badRes.stdout, /audit_chain_integrity/i);
});
