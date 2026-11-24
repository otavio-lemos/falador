# Fix Terminal PTY Real, Auditoria, Botão Enviar (ask_user) e Status de Aprovação Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os 4 bugs de UI/backend reportados: (1) Terminal fake `[comando recebido]` → PTY interativo real (`zsh`/`bash` + `ssh`), (2) `Auditoria (N)` vazia + painel minúsculo → aba `Todos (N)` padrão + altura expansível/maximizar, (3) Botão `Enviar` faltando em `Pergunta do Agente` com `fields` estruturados, (4) Status falso `Aguardando aprovação` / `janela do Console` quando o agente está apenas fazendo uma pergunta (`ask_user`).

**Architecture:** Três frentes independentes com arquivos 100% disjuntos executadas em paralelo via Orca Orchestration (`worker-start --worktree current`):
- Frente 1 (Terminal PTY): `services/pty-bridge.py` (Python 3 stdlib `pty`) + rotas SSE/POST em `apps/web-server.mjs` + `TerminalPanel.tsx` ligado ao PTY real via `EventSource` e `POST /api/terminal/*`.
- Frente 2 (Auditoria + Painel): `useRunner.ts` (tipos de `AuditEvent['op']`), `AuditPanel.tsx` (aba padrão `Todos` com todos os eventos de auditoria e busca `#audit-filter-decisions`), `LogsPanel.tsx` + `index.scss` (altura padrão 300px, teto dinâmico 85% viewport, botão `Expandir painel`/`Restaurar altura` para 72vh).
- Frente 3 (`ask_user` + Status): `LiveView.tsx` (botão `Enviar` + `Enter` nos `fields` estruturados de `ask_user`, reset de `fieldValues`, e `turnStatus` distinguindo `Aguardando resposta` vs `Aguardando aprovação`).

**Tech Stack:** Node 26 (ESM, zero-dep HTTP server), Python 3 stdlib (`pty`, `termios`, `select`, `fcntl`), React 18, `@carbon/react`, `@xterm/xterm`, Playwright.

**Spec:** User bug report (4 screenshots, 2026-11-24).

## Global Constraints

- `apps/web-server.mjs` é zero-dep Node 26 — NÃO instalar `node-pty` nem dependências nativas; usar Python 3 stdlib em `services/pty-bridge.py`.
- `apps/web` usa `@xterm/xterm` + `@xterm/addon-fit` + `@carbon/react` + Vite (`vite.config.ts` já faz proxy de `/api` para `127.0.0.1:8787`, então SSE + HTTP POST em `/api/terminal/*` funciona sem proxy WS extra).
- Cada worker edita exclusivamente seu conjunto disjunto de arquivos.

## Review Focus

- Terminal PTY deve suportar prompts interativos, Ctrl+C (`\x03`), Backspace, resize dinâmico (`SIGWINCH`), reconexão via buffer circular de ~64 KB e cleanup de processos filhos no encerramento do servidor.
- `Auditoria (N)` deve mostrar todos os eventos já emitidos (`run_started`, `run_stopped`, `chat_input`, `exec`, `plan`, `tool_call`, `gate`, `goal_validation`, `agent_final`) na aba padrão `Todos (N)`, mantendo `#audit-filter-decisions` funcional para o clique em passos da conversa e `chat-ux.spec.ts`.
- `LogsPanel` expandido (`72vh`) e restaurado não pode cortar dropdowns nem quebrar o scroll interno da tabela de auditoria ou do `xterm.js`.
- `ask_user` com `fields` estruturados deve enviar o JSON de `fieldValues` tanto clicando em `Enviar` quanto pressionando `Enter` dentro de qualquer `<TextInput>`, limpando `fieldValues` após o envio.
- `turnStatus` só deve mostrar `Aguardando aprovação` quando houver um gate de aprovação real (não `ask_user`), e nunca exibir o texto desatualizado `Aguardando sua aprovação na janela do Console`.

---

### Task 1: Terminal PTY Real (`w1-terminal`)

**Files:**
- Create: `services/pty-bridge.py`
- Modify: `apps/web-server.mjs`
- Create: `apps/web-server.terminal.test.mjs`
- Modify: `apps/web/src/components/TerminalPanel.tsx`
- Modify: `apps/web/src/components/terminal-panel.scss`

**Interfaces:**
- Produces HTTP API:
  - `POST /api/terminal/session` (`{ id?, cols?, rows?, cwd? }`) → `200 { id, shell, cwd, alive: true }`
  - `GET /api/terminal/stream?id=<id>` → SSE `event: output` (`{"data":"<base64>"}`), `event: exit` (`{"code":number}`)
  - `POST /api/terminal/input` (`{ id, data }`) → `200 { ok: true }` | `404`
  - `POST /api/terminal/resize` (`{ id, cols, rows }`) → `200 { ok: true }`
  - `DELETE /api/terminal/session?id=<id>` → `200 { ok: true }`

- [ ] **Step 1: Write `services/pty-bridge.py`**
  Opens a real PTY (`pty.openpty()`), sets window size (`TIOCSWINSZ`), spawns `[shell, '-i']` with `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG=en_US.UTF-8`, multiplexes `master_fd` and `stdin` JSON lines (`input`, `resize`), emits `output` base64 JSON lines and `exit` on termination.
- [ ] **Step 2: Add PTY session manager and `/api/terminal/*` routes in `apps/web-server.mjs`**
  Circular ~64 KB base64 chunk buffer per session, SSE broadcast, stdin forwarding, cleanup on server `close` / `SIGINT` / `SIGTERM`.
- [ ] **Step 3: Write `apps/web-server.terminal.test.mjs` and run it**
  Run: `node --test --test-force-exit apps/web-server.terminal.test.mjs`
  Expected: PASS (real `echo FALADOR_PTY_OK_123`, `pwd`, `resize`, `DELETE` → `404` on subsequent input).
- [ ] **Step 4: Connect `TerminalPanel.tsx` & `terminal-panel.scss` to real PTY**
  Remove fake `lineBufferRef`, fake `falador:~$ ` prompt, `[comando recebido: ...]` and gate interception. Wire `POST /api/terminal/session`, `EventSource('/api/terminal/stream?id=...')`, `POST /api/terminal/input` (ordered queue), `POST /api/terminal/resize` (debounced), and `Nova sessão` button.

---

### Task 2: Auditoria Completa (`Todos`) + Painel Expansível (`w2-audit`)

**Files:**
- Modify: `apps/web/src/useRunner.ts`
- Modify: `apps/web/src/components/AuditPanel.tsx`
- Modify: `apps/web/src/components/LogsPanel.tsx`
- Modify: `apps/web/src/index.scss`
- Create: `apps/web/tests/audit-panel.spec.ts`

**Interfaces:**
- Consumes: `AuditEvent` from `apps/web/src/useRunner.ts`.
- Produces: `AllEventsTable` default tab `Todos ({audit.length})` with `#audit-filter-decisions`; `LogsPanel` expand/restore toggle (`Expandir painel` / `Restaurar altura`, `.logs-panel--expanded` at `72vh`).

- [ ] **Step 1: Extend `AuditEvent['op']` in `apps/web/src/useRunner.ts`**
- [ ] **Step 2: Add `Todos` default tab and fix `executions` filter in `apps/web/src/components/AuditPanel.tsx`**
- [ ] **Step 3: Increase default height, make max height dynamic, add expand/restore toggle in `LogsPanel.tsx` & `index.scss`**
- [ ] **Step 4: Write `apps/web/tests/audit-panel.spec.ts` and run Playwright**
  Run: `cd apps/web && npx playwright test tests/audit-panel.spec.ts`
  Expected: PASS.

---

### Task 3: Botão `Enviar` em `ask_user` + Status Correto (`w3-askuser-status`)

**Files:**
- Modify: `apps/web/src/views/LiveView.tsx`
- Modify: `apps/web/tests/chat-ux.spec.ts`

**Interfaces:**
- Consumes: `gate`, `gateInfo`, `fieldValues`, `approve()`, `turnStatus` in `apps/web/src/views/LiveView.tsx`.

- [ ] **Step 1: Add `Enviar` button and `Enter` submit handler to structured `fields` in `LiveView.tsx`, clear `fieldValues`, and update `turnStatus`**
- [ ] **Step 2: Update and add tests in `apps/web/tests/chat-ux.spec.ts`**
- [ ] **Step 3: Run `cd apps/web && npx playwright test tests/chat-ux.spec.ts`**
  Expected: PASS.

---

### Final Verification (Coordinator)

- [ ] Run `node --test --test-force-exit apps/web-server.terminal.test.mjs apps/web-server.test.mjs apps/web-server.routes.test.mjs`
- [ ] Run `cd apps/web && npx tsc --noEmit && npm run build`
- [ ] Run `cd apps/web && npx playwright test tests/chat-ux.spec.ts tests/audit-panel.spec.ts tests/ui-smoke.spec.ts`
