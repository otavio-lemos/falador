// falador-cli — validate-run.mjs: validador de conformidade PÓS-RUN (ADR-012).
// Uso: node validate-run.mjs <runId>
// Lê: logs/audit/<runId>.jsonl (trilha única, append-only, emitida pelo runner)
// Regras (determinísticas, sem heurística de timestamp):
//   R1 no_missing_gate       — nenhum tool_call com gate='missing_gate'
//   R2 rejected_not_executed  — tool_call rejeitado (gate='rejected') não pode ter ok:true
//   R3 validated_before_done  — agent_final goalAchieved exige goal_validation achieved + gate approved DEPOIS dela
//   R4 plan_verified          — último plano tem todos itens 'verified' quando goalAchieved
//   R5 errors_traceable       — tool_call ok:false exige errorType ou outputPreview não-vazio
// Saída: relatório JSON+md em sessions/<runId>/ e stdout. Exit 0 se tudo PASS, 1 caso contrário.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAuditChain } from '../falador-nodes/src/audit.ts';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const AUDIT_DIR = process.env.FALADOR_AUDIT_DIR || join(ROOT, 'logs', 'audit');
const SESSIONS_DIR = process.env.FALADOR_SESSIONS_DIR || join(ROOT, 'sessions');

function usage() {
  console.log('Usage: node validate-run.mjs <runId>');
  console.log('');
  console.log('Validates a completed run against the audit trail (logs/audit/<runId>.jsonl).');
  console.log('');
  console.log('Rules: no_missing_gate, rejected_not_executed, validated_before_done,');
  console.log('       plan_verified, errors_traceable.');
  console.log('');
  console.log('Exit code: 0 = all PASS, 1 = at least one FAIL (or missing trail).');
}

function readJsonLines(file) {
  if (!existsSync(file)) return null;
  const content = readFileSync(file, 'utf-8');
  return content.trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function runRules(events) {
  const results = [];
  const toolCalls = events.filter((e) => e.op === 'tool_call');
  const final = events.filter((e) => e.op === 'agent_final').pop();
  const goalAchieved = final?.goalAchieved === true;

  // R1
  const missing = toolCalls.filter((e) => e.gate === 'missing_gate');
  results.push(missing.length === 0
    ? { rule: 'no_missing_gate', status: 'PASS', message: 'Nenhum tool_call com gate missing_gate' }
    : { rule: 'no_missing_gate', status: 'FAIL', message: `${missing.length} tool_call sem gate configurado`, details: missing });

  // R2
  const badRejected = toolCalls.filter((e) => e.gate === 'rejected' && e.ok === true);
  results.push(badRejected.length === 0
    ? { rule: 'rejected_not_executed', status: 'PASS', message: 'Nenhum tool_call rejeitado foi executado' }
    : { rule: 'rejected_not_executed', status: 'FAIL', message: `${badRejected.length} tool_call rejeitado com ok=true`, details: badRejected });

  // R3
  if (!goalAchieved) {
    results.push({ rule: 'validated_before_done', status: 'PASS', message: 'Sem agent_final goalAchieved (nada a validar)' });
  } else {
    const goalValidations = events.filter((e) => e.op === 'goal_validation');
    const lastGv = goalValidations.filter((e) => e.validation?.achieved === true).pop();
    const approvedAfter = lastGv
      ? events.some((e, i) => e.op === 'gate' && e.gate === 'approved' && i > events.indexOf(lastGv))
      : false;
    if (lastGv && approvedAfter) {
      results.push({ rule: 'validated_before_done', status: 'PASS', message: 'goal_validation achieved + gate approved após ela' });
    } else {
      results.push({ rule: 'validated_before_done', status: 'FAIL', message: 'goalAchieved sem goal_validation achieved ou sem gate approved posterior', details: { goalValidations, final } });
    }
  }

  // R4
  const planEvents = events.filter((e) => e.op === 'plan' && Array.isArray(e.plan));
  if (goalAchieved && planEvents.length > 0) {
    const lastPlan = planEvents[planEvents.length - 1].plan;
    const allVerified = lastPlan.every((p) => p.status === 'verified');
    results.push(allVerified
      ? { rule: 'plan_verified', status: 'PASS', message: `Plano final: ${lastPlan.length}/${lastPlan.length} itens verificados` }
      : { rule: 'plan_verified', status: 'FAIL', message: `Plano final tem itens não verificados`, details: lastPlan.filter((p) => p.status !== 'verified') });
  } else {
    results.push({ rule: 'plan_verified', status: 'PASS', message: goalAchieved ? 'Sem eventos de plano (nada a validar)' : 'Sem goalAchieved (nada a validar)' });
  }

  // R5
  const untraceable = toolCalls.filter((e) => e.ok === false && !(typeof e.errorType === 'string' && e.errorType.length > 0) && !(typeof e.outputPreview === 'string' && e.outputPreview.length > 0));
  results.push(untraceable.length === 0
    ? { rule: 'errors_traceable', status: 'PASS', message: 'Todo erro de tool tem rastreabilidade (errorType/outputPreview)' }
    : { rule: 'errors_traceable', status: 'FAIL', message: `${untraceable.length} tool_call com erro sem rastreabilidade`, details: untraceable });

  // R6: integridade da hash chain SHA-256 (quando presente — retrocompatível com logs legados)
  const hasHashChain = events.some((e) => typeof e.hash === 'string' || typeof e.prevHash === 'string');
  if (hasHashChain) {
    const chain = verifyAuditChain(events);
    results.push(chain.ok
      ? { rule: 'audit_chain_integrity', status: 'PASS', message: `Cadeia SHA-256 íntegra (${chain.checked} eventos)` }
      : { rule: 'audit_chain_integrity', status: 'FAIL', message: `Quebra de integridade SHA-256 no evento #${chain.index}: ${chain.reason}`, details: chain });
  } else {
    results.push({ rule: 'audit_chain_integrity', status: 'PASS', message: 'Log legado sem hash chain (retrocompatível)' });
  }

  return results;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { usage(); process.exit(0); }
  if (args.length === 0) { usage(); process.exit(1); }
  const runId = args[0];
  const auditFile = join(AUDIT_DIR, `${runId}.jsonl`);
  const events = readJsonLines(auditFile);
  if (events === null) {
    console.error(`Audit trail não encontrado: ${auditFile}`);
    process.exit(1);
  }
  if (events.length === 0) {
    console.error(`Audit trail vazio: ${auditFile}`);
    process.exit(1);
  }

  console.log(`Validating run: ${runId}`);
  console.log(`Audit events: ${events.length}`);
  console.log('');

  const results = runRules(events);
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const overall = failed === 0 ? 'PASS' : 'FAIL';

  for (const r of results) {
    console.log(`${r.status === 'PASS' ? '✅' : '❌'} ${r.rule}: ${r.message}`);
  }
  console.log('');
  console.log(`Overall: ${overall}`);
  console.log(`Passed: ${passed}/${results.length}`);
  console.log(`Failed: ${failed}`);

  const reportDir = join(SESSIONS_DIR, runId);
  try {
    if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
    const jsonPath = join(reportDir, 'compliance-report.json');
    const mdPath = join(reportDir, 'compliance-report.md');
    writeFileSync(jsonPath, JSON.stringify({ runId, validatedAt: new Date().toISOString(), overall, summary: { total: results.length, passed, failed }, rules: results }, null, 2));
    let md = `# Compliance Report — ${runId}\n\n**Overall:** ${overall === 'PASS' ? '✅ PASS' : '❌ FAIL'}\n\n`;
    md += `| Rule | Status |\n|------|--------|\n`;
    for (const r of results) md += `| ${r.rule} | ${r.status === 'PASS' ? '✅ PASS' : '❌ FAIL'} |\n`;
    md += `\n## Details\n\n`;
    for (const r of results) {
      md += `### ${r.rule} — ${r.status}\n\n${r.message}\n\n`;
      if (r.details) md += '```json\n' + JSON.stringify(r.details, null, 2) + '\n```\n\n';
    }
    writeFileSync(mdPath, md);
    console.log(`Report: ${jsonPath}`);
    console.log(`Report: ${mdPath}`);
  } catch (e) {
    console.warn(`[validate-run] não foi possível gravar relatório: ${e?.message ?? e}`);
  }

  process.exit(failed === 0 ? 0 : 1);
}

main();