# ADR-012 — Assistente Especialista TI auditado (trilha única + avaliador independente + plano verificável + d1)

Data: 2026-11-23 · Status: ACEITO (implementado) · Spec: docs/superpowers/specs/2026-11-23-assistente-ti-auditado-design.md

## Decisão

O workflow `assistente-especialista-ti` passa a ter:

1. **Trilha de auditoria única por run** (`logs/audit/<runId>.jsonl`, append-only, NDJSON no stdout
   e SSE para a UI): eventos estruturados `plan`, `tool_call`, `gate`, `goal_validation`, `agent_final`,
   com runId/seq/ts e dados REAIS (risco d1, decisão do gate, ok/exitCode/duração, preview de output,
   meta RAG real). Nada fabricado.
2. **Avaliador independente** (`validateGoal` em `goal-validator.ts`): quem executa NÃO declara a própria
   vitória. A conclusão só é emitida após `validateGoal` retornar `achieved && confidence ≥ threshold`
   E o humano aprovar o gate final. Fail-closed em erro/JSON inválido.
3. **Plano/checklist verificável** (tool interna `update_plan` do próprio `agent.tools`, sem nó novo):
   item só vira `verified` com evidência real de verificação; itens pendentes realimentam o loop.
4. **d1 como decisor de risco** (params `d1Model` no flow TI): rotula `seguro`/`sensivel` antes do
   gate, na auditoria e no card da UI. Fail-safe: d1 falhou ⇒ `sensivel`.
5. **Validador pós-run** (`validate-run.mjs`, R1–R5) sobre a trilha: missing_gate, rejected_executed,
   validated_before_done, plan_verified, errors_traceable. Exit 0/1.

## Fontes reais (verificadas em 2026-11-23)

- Anthropic, *Building effective agents* (evaluator-optimizer, ground truth, transparência, ACI).
- Anthropic, *Effective harnesses for long-running agents* (checklist JSON com passes por item,
  verificação real antes de marcar feito, progresso incremental).
- LangGraph, *Interrupts* (aprovação/rejeição/edição antes do efeito colateral; idempotência).
- OpenTelemetry GenAI semantic conventions (status Development) — inspiração do esquema
  (`invoke_agent`/`plan`/`execute_tool`, `error.type`, conteúdo opt-in). Não implementamos OTel real.

## O que foi revertido (e por quê)

- V9 (SSH `allowedHosts` obrigatório): quebrava o flow TI (`allowedHosts: []` por design, host escolhido no Run).
- `sanitizeToolOutput` escapando todo `< >` (degradava outputs legítimos).
- `checkpoint-manager.ts`, `knowledge-injector.ts`, flow v2, ORCHESTRATION_PLAN.md: escopo não aprovado /
  meio quebrados (backup no stash `backup-plano-antigo-v2-2026-11-23`).
- Auditoria fabricada do host (d1Decision:'auto' hard-coded, RAG de args inexistentes, gate originalText:''),
  resume duplicado, checkpoint-manager com `writeFileSync` sem import, evidence array→String.

## O que NÃO foi verificado (NÃO VERIFICADO)

- E2E ao vivo com modelo real no browser nesta rodada (serviços locais não foram subidos pelo agente);
  a validação foi feita com mocks HTTP nos testes unitários.
- MCP server externo real e SSH em host remoto real (já NÃO VERIFICADO em ADR-008).
- `validate-run.mjs` contra uma trilha real de uma sessão ao vivo (só trilhas sintéticas nos testes).
- `validateGoal` com o modelo real LFM3-1.7B (testado apenas com HTTP mock).

## Consequências

- Catálogo: 24 nós (23 + goal.validator).
- Suítes: falador-graph 42, falador-nodes 186 (1 skip N7 mic), falador-cli 14 (11 + 3 audit) + 10 validate-run, host 16, UI tsc+build verdes, Playwright 6/6 (a confirmar nesta rodada).
- Trabalho antigo preservado em stash caso seja preciso recuperar alguma parte.