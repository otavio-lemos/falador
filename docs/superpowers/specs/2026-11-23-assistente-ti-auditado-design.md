# Design — Assistente Especialista TI auditado (caminho A)

Data: 2026-11-23 · Status: APROVADO pelo dono (caminho A + 5 itens) · Worktree: CORRECOES

## Intent e porquê

O workflow `assistente-especialista-ti` executa ações reais de TI (SSH, comandos, MCP) com
aprovação humana. Hoje quem declara "OBJETIVO CONCLUÍDO" é o mesmo LLM que executou —
modo de falha nº 1 documentado pela Anthropic (declarar vitória cedo / sem testar). A auditoria
é espalhada (exec-audit.jsonl + logs debug + agent_step) e não há tela de auditoria nem
plano verificável. O dono quer: auditoria real, exibida na tela, decisor, ferramentas,
consulta a documentação e validação completa do processo.

## Fontes (verificadas em 2026-11-23)

- Anthropic, *Building effective agents*: evaluator-optimizer (quem executa não avalia),
  ground truth por passo, transparência do plano, ACI (descrições de ferramentas).
- Anthropic, *Effective harnesses for long-running agents*: checklist JSON com `passes`
  por item, verificação real antes de marcar feito, progresso incremental.
- LangGraph, *Interrupts*: aprovação/rejeição/edição antes do efeito colateral; efeitos
  idempotentes e só após aprovação.
- OpenTelemetry GenAI semconv (Development): spans `invoke_agent`/`plan`/`execute_tool`,
  `error.type`, conteúdo opt-in → inspiração do esquema de auditoria (não implementamos OTel).

## Abordagens consideradas

- **A (escolhida)**: evoluir sobre a base commitada; reverter partes quebradas do trabalho
  antigo não commitado (backup em `git stash`: "backup-plano-antigo-v2-2026-11-23");
  resgatar `goal-validator.ts` e `AuditPanel.tsx`; implementar em série (L7: cota free).
- B: seguir ORCHESTRATION_PLAN antigo (4 workers + checkpoint/resume) — rejeitado: plano
  velho, meio quebrado (V9 rejeita o flow atual; checkpoint-manager com `writeFileSync`
  sem import; dados de auditoria fabricados no host), escopo não pedido, workers paralelos
  morrem na cota free.
- C: só auditoria+tela — rejeitado: dono pediu decisor e validação completa.

## O que foi verificado no trabalho antigo (e o destino de cada parte)

| Parte | Estado | Destino |
|---|---|---|
| `spec.ts` V9 (SSH allowedHosts obrigatório) | QUEBRA o flow TI atual (`allowedHosts: []` por design, host no Run) | reverter |
| `spec.ts` V10 (MCP allowedTools obrigatório) | válido, não quebra flows | manter + teste |
| `sanitizeToolOutput` escapando todo `< >` | degrada outputs legítimos | reverter ao original |
| `checkpoint-manager.ts` | `writeFileSync` sem import; evidence array→String | remover (escopo não aprovado) |
| `knowledge-injector.ts` + flow v2 | criado mas sem edges/bindings | remover (RAG já coberto por `rag.search`) |
| `goal-validator.ts` | bom, mas sem `omlxAuthHeaders` (omlx exige API key) e não ligado | resgatar: extrair helper `validateGoal()` + corrigir auth |
| `AuditPanel.tsx` | UI Carbon boa; busca no-op; depende de tipos fabricados | resgatar adaptando a eventos reais |
| host/runner/useRunner/LiveView diffs | auditoria fabricada (d1Decision:'auto' hard-coded, RAG de args inexistentes, gate originalText:'', resume duplicado) | reverter e reimplementar limpo |
| `validate-run.mjs` | allowlist hard-coded "reasonable default", gate por proximidade de timestamp, gap>5s falha com pensamento humano | reescrever sobre a trilha única |
| `ORCHESTRATION_PLAN.md`, flow v2 | plano antigo | remover (backup no stash) |

## Desenho (o que será construído)

### 1. Trilha de auditoria única por run

- `agent.tools` ganha binding `__onAudit?: (ev: AuditEvent) => void` e emite eventos
  estruturados e VERDADEIROS (nada fabricado):
  - `op:'plan'` — estado do checklist a cada `update_plan`;
  - `op:'tool_call'` — tool, args, risco d1, decisão do gate (`approved|rejected|edited|not_required|missing_gate`),
    ok, exitCode, durationMs, dryRun, host/transport, outputPreview (truncado), meta RAG real
    (`rag.search` já retorna `{hits, query, chunkIds}`);
  - `op:'goal_validation'` — resultado do avaliador independente;
  - `op:'agent_final'` — resposta final, goalAchieved, maxStepsReached.
- Runner (`run-flow.mjs`): gera `runId`, grava append-only `logs/audit/<runId>.jsonl`
  (1 linha por evento, `seq` monotônico) e emite NDJSON `{type:'audit',...}`.
  Gates de `human.approve` também viram `op:'gate'` (request→pending, ação→approved/rejected/edited).
- Host: repassa SSE `audit` + acumula `sessionBuffer.audit` (cap 1000) + inclui no export.
  SEM persistência duplicada, SEM endpoints de resume.
- `AuditEvent` vive em `packages/falador-nodes/src/audit.ts` (tipo + helpers puros).

### 2. Avaliador independente (evaluator-optimizer)

- `goal-validator.ts` exporta `validateGoal({baseUrl, model, goal, evidence, plan, signal})`
  → `{achieved, confidence, gaps[], nextActions[]}` (JSON rigoroso, fail-closed: erro/JSON
  inválido ⇒ achieved:false). Usa `omlxAuthHeaders`. O nó `goal.validator` continua no
  catálogo usando o mesmo helper.
- `agent.tools`: quando o LLM produz resposta final (sem tool_calls) e há objetivo:
  1. plano com itens não-verificados ⇒ devolve pendências ao LLM e continua o loop;
  2. chama `validateGoal` (modelo `validatorModel`, default LFM3-1.7B — independente do executor);
  3. achieved && confidence ≥ `goalConfidenceThreshold` (default 0.8) ⇒ **gate humano final**
     ("confirmar conclusão") ⇒ aprovado ⇒ emite final com `meta.goalAchieved` + auditoria;
  4. não-achieved ou humano rejeita ⇒ gaps/nextActions realimentam o loop (limitado por maxSteps).
- Sem validador configurado e sem plano ⇒ comportamento legado (não quebra outros flows).

### 3. Plano/checklist verificável (padrão Anthropic harness)

- Tool interna `update_plan` (injetada pelo próprio `agent.tools`, sem nó novo, sem porta nova):
  `items: [{id, description, verification, status: pending|verified|failed, evidence?}]`.
  Estado no agente; cada chamada emite `op:'plan'`. É bookkeeping interno: NÃO passa pelo
  gate (não toca o mundo externo). `verification` = como provar (comando/checagem concreta).
- System prompt do flow TI: planejar primeiro com `update_plan`, 1 item por vez, marcar
  `verified` só com evidência real de tool, citar fonte de documentação (RAG/web) nas decisões.

### 4. d1 como decisor de risco

- `triageWithD1` JÁ existe no agente e o card de gate JÁ mostra "Risco d1" (verificado).
  Falta: ligar `d1Model: 'd1-2B-MLX-4bit'` no flow TI e registrar o risco na auditoria
  (campo `risk` do `tool_call`). Fail-safe existente: d1 falhou ⇒ `sensivel`.

### 5. Validação completa do processo

- `validate-run.mjs` reescrito: lê `logs/audit/<runId>.jsonl` e aplica regras determinísticas:
  - R1 `no_missing_gate`: nenhum tool_call com gate `missing_gate`;
  - R2 `rejected_not_executed`: tool_call rejeitado não tem resultado de execução;
  - R3 `validated_before_done`: `agent_final` com goalAchieved exige `goal_validation`
    achieved=true + gate final aprovado antes;
  - R4 `plan_verified`: último plano com todos itens `verified` quando goalAchieved;
  - R5 `no_unhandled_error`: todo tool_call ok:false tem errorType/outputPreview (rastreável).
  Relatório JSON+md PASS/FAIL; exit code 0/1. Testes com trilhas sintéticas.
- Suítes existentes verdes + novas; `validateFlow` em TODOS os flows; `tsc`+`vite build`.

### UI

- `useRunner`: acumula eventos `audit` reais (array único) — sem polling de export.
- `LiveView`: abas Logs | Auditoria no rodapé (Tabs Carbon); `AuditPanel` recebe
  `audit: AuditEvent[]` + traces e deriva as visões: Decisões, Execuções, Gates, RAG,
  **Plano** (checklist com status), Latência (dos traces reais). Busca das tabelas ligada
  a filtro simples (ou removida se não filtrar de verdade).
- `param-help.ts` / `node-descriptions.ts` / `flow-utils.ts`: entradas do `goal.validator`
  e dos params novos do agente (`validatorModel`, `goalConfidenceThreshold`, `d1Model`).

## Goals / Non-goals / Anti-goals

- Goals: trilha única verdadeira e exibida; conclusão validada por avaliador independente +
  humano; plano verificável; risco d1 auditado; validador pós-run; tudo testado.
- Non-goals: checkpoint/resume, knowledge.inject, OTel real, multi-agente, novos sidecars,
  novas dependências (zero deps continua).
- Anti-goals: dado de auditoria fabricado/inferido; quebrar flows existentes; gate bypass;
  executar efeito colateral antes de aprovação; inflar catálogo com nós redundantes.

## Restrições

- Zero dependências novas; Node 26 type-stripping (sem parameter properties); Carbon na UI;
  trabalho em série (L7); nada de instalar/rodar modelo sem aprovação; E2E ao vivo com
  modelo real fica NÃO VERIFICADO se não rodar nesta sessão.

## Decisões do builder (minhas, não do dono)

- Auditoria escrita pelo RUNNER (fonte única), não pelo host; host só repassa/acumula.
- `update_plan` é tool interna do agente (sem nó/porta novos) e isenta de gate por ser
  bookkeeping sem efeito externo.
- Validador roda na declaração de conclusão (não a cada N steps — o acoplamento antigo
  com checkpointEverySteps era quebrado).
- Flow TI evoluído NO PRÓPRIO arquivo (uma verdade só); v2 removido.