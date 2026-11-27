// falador-cli — contrato da trilha de auditoria do runner (ADR-012):
// NDJSON {type:'audit',runId,seq,...} + JSONL append-only por run + gates auditados.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyAuditChain } from '../../falador-nodes/src/audit.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'run-flow.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'falador-audit-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const VALID_VALIDATION = '{"achieved":true,"confidence":0.9,"gaps":[],"nextActions":[]}';
const PLAN_VERIFIED = [{ id: '1', description: 'Checar disco', verification: 'df -h', status: 'verified', evidence: '45%' }];

function mockLlm() {
  const execQ = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ items: PLAN_VERIFIED }) } }] } }] },
    {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c2', type: 'function', function: { name: 'exec_local', arguments: JSON.stringify({ command: 'df -h' }) } },
            { id: 'c3', type: 'function', function: { name: 'exec_local', arguments: JSON.stringify({ command: 'uptime' }) } },
          ],
        },
      }],
    },
    { choices: [{ message: { role: 'assistant', content: 'OBJETIVO CONCLUÍDO' } }] },
  ];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/json');
      if (body.model !== 'exec-model') {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: VALID_VALIDATION } }] }));
        return;
      }
      const next = execQ.shift() ?? { choices: [{ message: { role: 'assistant', content: '(fila esgotada)' } }] };
      res.end(JSON.stringify(next));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => srv.close(() => r())) });
    });
  });
}

function auditFlow(llmUrl) {
  return {
    version: 1,
    stopWhenSourcesDone: false,
    nodes: [
      { id: 'input', type: 'input.chat', params: {} },
      {
        id: 'agente', type: 'agent.tools',
        params: { baseUrl: llmUrl, model: 'exec-model', validatorModel: 'val-model', approvalPolicy: 'never', maxSteps: 5 },
      },
      { id: 'exec', type: 'exec.command', params: { transport: 'local', mode: 'readonly', dryRun: true, toolName: 'exec_local' } },
      { id: 'out', type: 'sink.captions', params: { mode: 'callback', outputMode: 'write' } },
    ],
    edges: [
      { from: 'input.out', to: 'agente.in' },
      { from: 'exec.tool', to: 'agente.tools' },
      { from: 'agente.out', to: 'out.in' },
    ],
  };
}

/** Sobe o runner, alimenta o chat, aprova o gate final quando anunciado, e devolve eventos+runId. */
function runAudited(flowPath, env, { approveGate = true, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, flowPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    let runId = null;
    let chatSent = false;
    let done = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* já morto */ }
      reject(new Error(`timeout; stdout parcial: ${stdout.slice(0, 600)}`));
    }, timeoutMs);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, runId });
    };
    child.stdout.on('data', (d) => {
      stdout += d;
      for (const l of String(d).split('\n')) {
        if (!l.trim()) continue;
        let ev;
        try { ev = JSON.parse(l); } catch { continue; }
        if (ev.type === 'run_started') runId = ev.runId;
        if (ev.type === 'metrics' && !chatSent) {
          chatSent = true;
          child.stdin.write(JSON.stringify({ type: 'chat_input', nodeId: 'input', text: 'objetivo: checar disco' }) + '\n');
        }
        if (ev.type === 'gate' && ev.meta?.tool === 'goal.confirm') {
          child.stdin.write(JSON.stringify({ type: 'gate_action', nodeId: ev.nodeId, text: approveGate ? '' : null }) + '\n');
        }
        if (ev.type === 'audit' && ev.op === 'agent_final') {
          setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* já morto */ } }, 100);
        }
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', finish);
  });
}

const parseNdjson = (stdout) =>
  stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

test('runner: audit NDJSON + JSONL por run com runId/seq, gates pending→approved', async () => {
  const llm = await mockLlm();
  const auditDir = join(tmp, 'audit-ok');
  const flowPath = join(tmp, 'flow-audit.json');
  writeFileSync(flowPath, JSON.stringify(auditFlow(llm.url)), 'utf-8');
  try {
    const r = await runAudited(flowPath, { FALADOR_AUDIT_DIR: auditDir });
    const events = parseNdjson(r.stdout);
    assert.ok(r.runId, 'run_started deve carregar runId');
    const started = events.find((e) => e.type === 'run_started');
    assert.equal(typeof started.runId, 'string');

    const audits = events.filter((e) => e.type === 'audit');
    assert.ok(audits.length >= 4, `esperava >=4 eventos audit, veio ${audits.length}`);
    for (const a of audits) {
      assert.equal(a.runId, r.runId);
      assert.equal(typeof a.seq, 'number');
      assert.equal(typeof a.ts, 'number');
    }
    const seqs = audits.map((a) => a.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), 'seq monotônico');
    assert.equal(new Set(seqs).size, seqs.length, 'seq único');

    const ops = audits.map((a) => a.op);
    assert.ok(ops.includes('run_started'), 'op run_started');
    assert.ok(ops.includes('chat_input'), 'op chat_input');
    assert.ok(ops.includes('plan'), 'op plan');
    assert.ok(ops.includes('goal_validation'), 'op goal_validation');
    assert.ok(ops.includes('agent_final'), 'op agent_final');
    const gateReqs = audits.filter((a) => a.op === 'gate' && a.nodeId === 'agente');
    assert.ok(gateReqs.some((a) => a.gate === 'pending'), 'gate pending auditado');
    assert.ok(gateReqs.some((a) => a.gate === 'approved'), 'gate approved auditado');
    const fin = audits.find((a) => a.op === 'agent_final');
    assert.equal(fin.goalAchieved, true);

    // JSONL append-only com os MESMOS eventos e cadeia SHA-256 íntegra
    const file = join(auditDir, `${r.runId}.jsonl`);
    assert.ok(existsSync(file), `arquivo ${file} deve existir`);
    const jsonl = readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(jsonl.length, audits.length);
    for (const [i, rec] of jsonl.entries()) {
      assert.equal(rec.seq, audits[i].seq);
      assert.equal(rec.op, audits[i].op);
      assert.equal(rec.runId, r.runId);
      assert.equal(typeof rec.hash, 'string');
      assert.equal(typeof rec.prevHash, 'string');
    }
    const chainRes = verifyAuditChain(jsonl);
    assert.equal(chainRes.ok, true, `hash chain inválida: ${JSON.stringify(chainRes)}`);
  } finally { await llm.close(); }
});

test('runner: gate final rejeitado fica auditado como rejected e não conclui', async () => {
  const llm = await mockLlm();
  const auditDir = join(tmp, 'audit-rej');
  const flowPath = join(tmp, 'flow-audit-rej.json');
  writeFileSync(flowPath, JSON.stringify(auditFlow(llm.url)), 'utf-8');
  try {
    const r = await runAudited(flowPath, { FALADOR_AUDIT_DIR: auditDir }, { approveGate: false });
    const audits = parseNdjson(r.stdout).filter((e) => e.type === 'audit');
    const gateReqs = audits.filter((a) => a.op === 'gate' && a.nodeId === 'agente');
    assert.ok(gateReqs.some((a) => a.gate === 'rejected'), 'rejeição auditada');
    const fin = audits.find((a) => a.op === 'agent_final');
    assert.ok(fin, 'agent_final existe (síntese maxSteps)');
    assert.notEqual(fin.goalAchieved, true);
  } finally { await llm.close(); }
});

test('runner: dir de auditoria indisponível NÃO derruba o run (warn no stderr)', async () => {
  const llm = await mockLlm();
  const blocker = join(tmp, 'not-a-dir');
  writeFileSync(blocker, 'arquivo bloqueando mkdir', 'utf-8');
  const flowPath = join(tmp, 'flow-audit-bad.json');
  writeFileSync(flowPath, JSON.stringify(auditFlow(llm.url)), 'utf-8');
  try {
    const r = await runAudited(flowPath, { FALADOR_AUDIT_DIR: join(blocker, 'sub') });
    const events = parseNdjson(r.stdout);
    const audits = events.filter((e) => e.type === 'audit');
    assert.ok(audits.some((a) => a.op === 'agent_final'), 'run completou mesmo sem poder gravar JSONL');
    assert.match(r.stderr, /audit/i, 'aviso de falha de escrita no stderr');
  } finally { await llm.close(); }
});