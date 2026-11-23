# Assistente TI Auditado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (execução NATIVE em série, aprovada pelo dono — L7 cota free proíbe workers paralelos). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Evoluir `assistente-especialista-ti` com trilha de auditoria única exibida na tela, avaliador independente de conclusão, plano/checklist verificável e risco d1 auditado.

**Architecture:** `agent.tools` emite `AuditEvent` via binding `__onAudit`; runner grava JSONL append-only por run e emite NDJSON `audit`; host repassa SSE; `AuditPanel` (Carbon) deriva as visões. Conclusão do agente passa por `validateGoal()` (LLM independente) + gate humano final. Plano é tool interna `update_plan` (sem nó novo).

**Tech Stack:** Node 26 type-stripping (zero deps), React+Carbon existente, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-23-assistente-ti-auditado-design.md`

## Global Constraints

- Zero dependências novas; sem parameter properties (Node type-stripping).
- Stdout do runner = 100% NDJSON; logs em stderr/arquivo.
- NENHUM dado de auditoria fabricado/inferido — só o que aconteceu.
- Efeito colateral externo só após gate aprovado; `update_plan` é bookkeeping interno (isento).
- `MAX_STEPS_CAP = 12` inalterado; fail-closed: erro do validador ⇒ `achieved:false`.
- Backup do trabalho antigo: stash `backup-plano-antigo-v2-2026-11-23` (já criado).
- Testes: `npm test` em `packages/falador-graph`, `packages/falador-nodes`, `packages/falador-cli`; host `node --test apps/web-server.test.mjs apps/web-server.routes.test.mjs`; UI `cd apps/web && npx tsc --noEmit && npm run build`.
- `validateFlow` em todos os flows com `__gate` injetado (padrão do script de verificação já usado).

## Review Focus

1. Validador retorna lixo/HTTP 500 ⇒ nunca conclui sozinho (fail-closed) — Tasks 2/3.
2. Humano rejeita gate final ⇒ loop continua, sem `goalAchieved` — Task 3.
3. `update_plan` com itens malformados ⇒ erro devolvido ao LLM, estado intacto — Task 3.
4. Stop/interrupt durante validação/gate ⇒ sem pendurar, gates rejeitados — Tasks 3/4.
5. Falha de escrita do JSONL (dir indisponível) ⇒ run continua, warn — Task 4.
6. Evidência gigante ⇒ budget cortado, validador ainda recebe contexto útil — Task 2.

## Interfaces (contratos entre tasks)

```ts
// packages/falador-nodes/src/audit.ts
export interface PlanItem { id: string; description: string; verification: string;
  status: 'pending' | 'verified' | 'failed'; evidence?: string }
export interface AuditEvent {
  ts: number; op: 'plan' | 'tool_call' | 'gate' | 'goal_validation' | 'agent_final';
  nodeId: string; step?: number; tool?: string; args?: Record<string, unknown>;
  risk?: 'seguro' | 'sensivel';
  gate?: 'approved' | 'rejected' | 'edited' | 'not_required' | 'missing_gate' | 'pending';
  ok?: boolean; exitCode?: number | null; durationMs?: number; dryRun?: boolean;
  host?: string; transport?: string; outputPreview?: string; errorType?: string;
  rag?: { query: string; hits: number; chunkIds?: string[] };
  plan?: PlanItem[];
  validation?: { achieved: boolean; confidence: number; gaps: string[]; nextActions: string[] };
  goal?: string; text?: string; goalAchieved?: boolean; maxStepsReached?: boolean;
}
export function parsePlanItems(raw: unknown): { ok: true; items: PlanItem[] } | { ok: false; error: string }
export function preview(output: string, max?: number): string  // default 2000, corta no FIM mantendo cauda

// packages/falador-nodes/src/goal-validator.ts
export interface GoalValidation { achieved: boolean; confidence: number; gaps: string[]; nextActions: string[] }
export async function validateGoal(o: { baseUrl: string; model: string; goal: string;
  evidence: string[]; plan?: PlanItem[]; signal: AbortSignal;
  evidenceCharBudget?: number /* default 12000 */ }): Promise<GoalValidation>

// agent.tools: binding __onAudit?: (ev: AuditEvent) => void
// params novos: validatorModel?: string (default 'LiquidAI--LFM3-1.7B-MLX-4bit'),
//               goalConfidenceThreshold?: number (default 0.8, 0..1)
// runner: NDJSON {type:'audit', runId, seq, ...AuditEvent}; arquivo logs/audit/<runId>.jsonl
//         env FALADOR_AUDIT_DIR sobrescreve dir (testes); runId = `run-${Date.now()}-${rand4}`
//         run_started ganha campo runId
```

---

### Task 0: Reverter trabalho antigo quebrado + limpeza

**Files:**
- Revert p/ HEAD: `apps/web-server.mjs`, `apps/web/src/useRunner.ts`, `apps/web/src/views/LiveView.tsx`, `packages/falador-cli/run-flow.mjs`, `packages/falador-cli/test/run-flow.test.mjs`, `packages/falador-nodes/src/trace.ts`
- Modify: `packages/falador-graph/src/spec.ts` (remover V9, MANTER V10), `packages/falador-nodes/src/agent-tools.ts` (reverter sanitize/checkpoint/systemPatch/restore/goal-periódico; MANTER captura de `userGoal` + `collectedEvidence`), `packages/falador-nodes/src/index.ts` (sem checkpoint/knowledge; exporta `goalValidator`)
- Delete: `packages/falador-nodes/src/checkpoint-manager.ts`, `packages/falador-nodes/src/knowledge-injector.ts`, `apps/tui/flows/assistente-especialista-ti-v2.json`, `ORCHESTRATION_PLAN.md`
- Keep p/ tasks seguintes: `goal-validator.ts`, `AuditPanel.tsx`, `validate-run.mjs` (será reescrito)
- Test: `packages/falador-graph/test/validation-matrix.test.ts` (caso V10 MCP_MISSING_ALLOWED_TOOLS + V9 removido não quebra SSH com allowedHosts vazio)

- [ ] **Step 1:** `git checkout HEAD -- <arquivos revert acima>`; deletar os 4 arquivos; editar spec/agent-tools/index conforme acima. Catálogo volta a 23 + goal.validator = **24** (ajustar contagem no teste do runner de volta para 24 após Task 1 registrar o nó — neste task o teste espera 23 se goalValidator ainda não registrado; registrar `goalValidator` no index já neste task e ajustar teste p/ 24).
- [ ] **Step 2:** Teste V10 na matriz: flow com `tool.mcp` `allowedTools: []` ⇒ throw `MCP_MISSING_ALLOWED_TOOLS`; flow SSH `allowedHosts: []` ⇒ válido.
- [ ] **Step 3:** `npm test` nos 3 pacotes + script validateFlow em todos os flows (MISSING_BINDING de `human.approve` sem `__gate` injetado é esperado; injetar no script). Esperado: tudo verde, flow TI válido.
- [ ] **Step 4:** Commit `refactor: revert broken v2 work, keep goal.validator + V10 hardening`.

### Task 1: audit.ts — tipos + helpers puros

**Files:** Create `packages/falador-nodes/src/audit.ts`; Test `packages/falador-nodes/test/audit.test.ts`; Modify `index.ts` (export types/helpers).

- [ ] **Step 1:** Testes falhando: `parsePlanItems` aceita itens válidos; rejeita status inválido, `verification` vazia, id duplicado, não-array; `preview('a'.repeat(5000))` tem ≤2000 chars e contém a cauda.
- [ ] **Step 2:** `npm test -- --test-name-pattern=audit` ⇒ FAIL (módulo não existe).
- [ ] **Step 3:** Implementar conforme Interfaces.
- [ ] **Step 4:** Testes PASS. Commit `feat(nodes): audit event types + plan parsing helpers`.

### Task 2: validateGoal() independente + fail-closed

**Files:** Modify `packages/falador-nodes/src/goal-validator.ts` (extrair helper; nó usa o helper; `omlxAuthHeaders` em TODAS as chamadas); Test `packages/falador-nodes/test/goal-validator.test.ts`; Modify `index.ts` (export `validateGoal`, `GoalValidation`).

- [ ] **Step 1:** Testes falhando com `httpServer` mock (padrão de `agent-tools.test.ts`):
  - JSON válido `{achieved:true,confidence:0.9,...}` ⇒ retorna igual;
  - resposta lixo ⇒ `{achieved:false,confidence:0}`; HTTP 500 ⇒ idem; JSON em code-fence ⇒ parseado;
  - request tem header de auth (`omlxAuthHeaders`) e `chat_template_kwargs.enable_thinking:false`;
  - evidência de 50k chars ⇒ corpo enviado ≤ budget+overhead (corta mantendo as ÚLTIMas evidências);
  - `plan` incluído no prompt do user quando presente.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar helper (system rigoroso existente + bloco PLANO). **Step 4:** PASS + suíte nós inteira verde. Commit `feat(nodes): independent goal validator helper, fail-closed + auth`.

### Task 3: agent.tools — update_plan + auditoria + conclusão validada

**Files:** Modify `packages/falador-nodes/src/agent-tools.ts`; Test `packages/falador-nodes/test/agent-audit.test.ts` (novo; mocks httpServer + makeManualSource + mockToolNode).

**Comportamento exato:**
- Tool interna `update_plan` (readonly:true, description ACI clara com exemplo) sempre presente; invoke valida via `parsePlanItems`, guarda estado, emite `op:'plan'`, retorna JSON `{saved:true, pending:N}`; isenta de gate.
- Cada tool call externa emite `op:'tool_call'` com risk (d1), gate outcome, ok/exitCode/durationMs/dryRun/host/transport, `outputPreview`, `rag` quando `result.meta.query` existe.
- Resposta final (sem tool_calls) com `userGoal` e (`validatorModel` configurado OU plano existente):
  1. plano com pendentes ⇒ mensagem user listando itens não-verified, continua loop;
  2. `validateGoal` ⇒ emite `op:'goal_validation'`;
  3. achieved && conf ≥ threshold ⇒ gate final (preview JSON da validação, meta `{tool:'goal.confirm', step}`) ⇒ aprovado ⇒ emite out final `meta.goalAchieved:true` + `op:'agent_final'`; rejeitado ⇒ gaps realimentam;
  4. não-achieved ⇒ gaps/nextActions realimentam (conta step);
  5. sem goal/validator/plano ⇒ caminho legado inalterado.
- `collectedEvidence` limitado (budget 12k chars, mantém cauda). `agent_final` também no caminho maxSteps (`maxStepsReached:true`, `goalAchieved:false`).

- [ ] **Step 1:** Testes falhando (mock LLM por sequência de respostas):
  - tools enviadas ao LLM incluem `update_plan`; chamada grava plano + emite audit `plan`; NÃO abre gate com approvalPolicy 'always';
  - itens malformados ⇒ tool output ok:false, plano anterior intacto;
  - exec aprovado ⇒ audit `tool_call` gate:'approved', ok:true, exitCode; rejeitado ⇒ gate:'rejected' sem execução;
  - RAG tool ⇒ audit com `rag.query/hits` reais do meta;
  - final com plano pendente ⇒ LLM recebe pendências (2ª chamada acontece);
  - validador achieved + gate final aprovado ⇒ out `meta.goalAchieved` + audits `goal_validation`/`agent_final`;
  - gate final rejeitado ⇒ continua, sem goalAchieved;
  - validador lixo ⇒ fail-closed continua loop;
  - sem validatorModel e sem plano ⇒ final legado (1 chamada, sem goal_validation);
  - interrupt durante gate final ⇒ retorna sem pendurar.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS + suítes nós/graph verdes. Commit `feat(agent): verifiable plan tool, audit trail, evaluator-optimizer completion`.

### Task 4: Runner — JSONL por run + NDJSON audit + gates auditados

**Files:** Modify `packages/falador-cli/run-flow.mjs`; Test `packages/falador-cli/test/run-flow.test.mjs` (+casos) ou `test/runner-audit.test.mjs` novo.

- [ ] **Step 1:** Teste falhando (spawn do runner com flow sintético `agent.tools` + mock HTTP + tool mock, `FALADOR_AUDIT_DIR` tmp): linhas NDJSON `audit` com `runId`/`seq` monotônico; arquivo `<runId>.jsonl` existe com os mesmos eventos; `run_started` tem `runId`; gate request ⇒ audit `gate` pending, gate_action ⇒ audit `gate` approved/rejected; dir de auditoria indisponível ⇒ run completa + sem crash.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar: gerar runId; binding `__onAudit` (append JSONL try/catch warn stderr + `line({type:'audit',runId,seq,...ev})`); no gate holder existente, emitir audit gate pending na request e approved/rejected/edited na resolução (edited = texto não-vazio diferente do original? runner não tem original — usar `approved` com `text`; edição detectada pelo agente no tool_call). **Step 4:** PASS + suíte CLI verde. Commit `feat(cli): per-run append-only audit JSONL + NDJSON audit events`.

### Task 5: Host + UI — aba Auditoria real

**Files:** Modify `apps/web-server.mjs` (NDJSON `audit` ⇒ `broadcast('audit', ev)` + `sessionBuffer.audit` cap 1000 + export inclui `audit`), `apps/web/src/useRunner.ts` (estado `audit: AuditEvent[]` acumulado do SSE, cap 1000; reset limpa), `apps/web/src/views/LiveView.tsx` (Tabs Carbon Logs|Auditoria no rodapé), `apps/web/src/components/AuditPanel.tsx` (recebe `audit` + deriva Decisões/Execuções/Gates/RAG/Plano/Latência; latência = agregados reais de `durationMs` por tool; filtro de busca ligado ou removido), `apps/web/src/param-help.ts` + `node-descriptions.ts` + `flow-utils.ts` (goal.validator + params novos do agente).

- [ ] **Step 1:** Host: teste em `web-server.routes.test.mjs` — evento audit do child chega no SSE e no export (mock runner ou flow sintético). UI: sem teste unitário novo; verificação = build + Playwright existente.
- [ ] **Step 2:** Implementar. **Step 3:** `node --test apps/web-server*.test.mjs` verde; `cd apps/web && npx tsc --noEmit && npm run build` verdes; `npx playwright test` 6/6 (porta isolada, lição AGENTS). Commit `feat(web): real audit tab (SSE audit events) + goal.validator docs`.

### Task 6: validate-run.mjs — conformidade determinística

**Files:** Rewrite `packages/falador-cli/validate-run.mjs`; Test `packages/falador-cli/test/validate-run.test.mjs`.

Regras (sobre `logs/audit/<runId>.jsonl`, sem heurística de timestamp): R1 `no_missing_gate`; R2 `rejected_not_executed` (tool_call gate rejected não tem ok:true); R3 `validated_before_done` (agent_final goalAchieved exige goal_validation achieved antes + gate approved depois dela); R4 `plan_verified` (último op:plan todo verified quando goalAchieved); R5 `errors_traceable` (tool_call ok:false tem errorType ou outputPreview). Saída: relatório JSON+md em `sessions/<runId>/` (cria dir), exit 0/1. `--help` sem args.

- [ ] **Step 1:** Testes falhando: trilha sintética PASS; 5 trilhas FAIL (uma por regra); arquivo inexistente ⇒ exit 1 com mensagem.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS. Commit `feat(cli): deterministic post-run compliance validator over audit trail`.

### Task 7: Flow TI + docs + verificação final

**Files:** Modify `apps/tui/flows/assistente-especialista-ti.json` (params agente: `d1Model:'d1-2B-MLX-4bit'`, `validatorModel:'LiquidAI--LFM3-1.7B-MLX-4bit'`, `goalConfidenceThreshold:0.8`; system prompt: regras de plano `update_plan` primeiro, 1 item por vez, `verified` só com evidência real, citar fonte RAG/web, conclusão só via validador+gate), `.gitignore` (`logs/audit/`), `AGENTS.md` (§3 ADR-012, §6 estado, §4 se medir), Create `docs/adr/ADR-012-assistente-ti-auditado.md` (decisão + fontes + o que ficou NÃO VERIFICADO), Modify `docs/testing.md`/`run.md` se contagens/comandos mudaram.

- [ ] **Step 1:** Atualizar flow + docs. **Step 2:** `validateFlow` em TODOS os flows (com `__gate` injetado) ⇒ todos OK. **Step 3:** Todas as suítes + tsc/build + Playwright verdes; `node packages/falador-cli/validate-run.mjs --help` ok. **Step 4:** E2E ao vivo SOMENTE com serviços já no ar e aprovação implícita do dono p/ testes locais sem efeito externo (dryRun:true mantém); se não rodar, marcar NÃO VERIFICADO. **Step 5:** Commit `feat(flow): TI specialist with d1 risk, independent validation + plan; ADR-012`.