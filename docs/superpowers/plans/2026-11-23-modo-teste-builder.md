# Modo Teste no Builder/LiveView — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um "Modo Teste" explícito ao Builder/LiveView que executa o workflow com dryRun forçado, banner "MODO TESTE", highlight nó-a-nó, gate por nó (regerar/editar/rejeitar) e checklist de validação ao final.

**Architecture:** Flag `testMode` propagada do Builder (botão "Testar Fluxo") → host `/api/run` → runner, que força `dryRun:true` em todos os `exec.command`/`tool.mcp` e emite eventos `test_step` com status por nó. LiveView exibe banner + checklist. Resultado persistido em `logs/test-runs/<runId>.json`.

**Tech Stack:** React + @carbon/react + @xyflow/react (frontend), Node runner `run-flow.mjs`, host `web-server.mjs`.

**Spec:** AGENTS.md §6 (UI web fase 2/3), ADR-012.

## Global Constraints

- dryRun forçado em modo teste (nunca executa comando real).
- Zero deps novas.
- tsc --noEmit + vite build verdes; Playwright 6/6.
- Nomes de arquivo/variável em inglês; UI em PT-BR.

## Review Focus

- Modo teste não deve alterar o flow JSON persistido (só overlay em memória).
- Gate humano deve continuar funcionando em modo teste (regerar/editar/rejeitar).
- Checklist final deve refletir status real (ok/erro/skip), não fabricado.
- Reset deve limpar estado de teste.
- Modo teste em flow sem exec.command deve funcionar (só LLM/TTS).

---

### Task 1: Flag testMode no runner (run-flow.mjs)

**Files:**
- Modify: `packages/falador-cli/run-flow.mjs`
- Test: `packages/falador-cli/test/run-flow.test.mjs`

**Interfaces:**
- Produces: env/arg `--test-mode` → seta `ctx.testMode = true` e força dryRun em nós de execução.

- [ ] **Step 1: Write failing test** — run-flow com `--test-mode` emite evento `run_started` com `testMode:true` e força dryRun.
- [ ] **Step 2: Run test → FAIL.**
- [ ] **Step 3: Implement** — parse `--test-mode`; ao carregar flow, override `params.dryRun=true` para `exec.command`/`tool.mcp` (overlay, não persiste); emite `{"type":"run_started","testMode":true}`.
- [ ] **Step 4: Run test → PASS.**
- [ ] **Step 5: Commit.**

### Task 2: Host HTTP propaga testMode

**Files:**
- Modify: `apps/web-server.mjs`
- Test: `apps/web-server.test.mjs`

**Interfaces:**
- Consumes: `POST /api/run` body `{flow, testMode?}`.
- Produces: repassa `--test-mode` ao runner; SSE inclui `testMode`.

- [ ] **Step 1: Write failing test** — POST /api/run com testMode:true → runner recebe flag; resposta SSE contém `testMode:true`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — aceitar `testMode` no body; append `--test-mode` ao spawn; persistir em `logs/test-runs/<runId>.json` ao final.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

### Task 3: Builder — botão "Testar Fluxo" ativa modo teste

**Files:**
- Modify: `apps/web/src/components/TopBar.tsx`, `apps/web/src/views/BuilderView.tsx`
- Test: `apps/web/tests/ui-smoke.spec.ts`

**Interfaces:**
- Produces: `onStart(flow, {testMode:true})`.

- [ ] **Step 1: Write failing test** — clicar "Testar Fluxo" → LiveView recebe `runner` com testMode e banner "MODO TESTE" visível.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — TopBar botão "Testar Fluxo" chama `onStart(flow, {testMode:true})`; propaga.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

### Task 4: LiveView — banner + checklist de validação

**Files:**
- Modify: `apps/web/src/views/LiveView.tsx`, `apps/web/src/components/WorkflowMiniMap.tsx`
- Test: `apps/web/tests/ui-smoke.spec.ts`

**Interfaces:**
- Consumes: `runner.testMode`, `runner.testResults: {nodeId, status, error?}[]`.

- [ ] **Step 1: Write failing test** — em modo teste, banner "MODO TESTE" visível; ao final, checklist com ✓/✗ por nó.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — banner Carbon (Tag magenta) no header; coletar `testResults` de eventos `node_started`/`node_error`/`node_completed`; renderizar checklist ao final do run.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

### Task 5: Gate por nó em modo teste (regerar/editar/rejeitar)

**Files:**
- Modify: `apps/web/src/views/LiveView.tsx` (commandGateCard já existe)

**Interfaces:**
- Consumes: `runner.gates`.

- [ ] **Step 1: Write failing test** — em modo teste, gate card exibe "TESTE" badge e botão "Regerar" funciona.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — adicionar badge "TESTE" ao commandGateCard quando testMode; reutilizar approve/reject/regenerate existentes.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

### Task 6: Persistência de resultado de teste

**Files:**
- Modify: `apps/web-server.mjs`
- Create: `logs/test-runs/.gitkeep`

**Interfaces:**
- Produces: `logs/test-runs/<runId>.json` com `{runId, flow, testMode, results, ts}`.

- [ ] **Step 1: Write failing test** — após run em modo teste, arquivo `logs/test-runs/<runId>.json` existe com resultados.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — ao `run_stopped` com testMode, gravar JSON.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.**

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-23-modo-teste-builder.md`. Please review the plan. Does it capture what you want?