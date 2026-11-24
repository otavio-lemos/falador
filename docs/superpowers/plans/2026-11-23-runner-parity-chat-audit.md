# Runner = Builder, Logs ⇄ Auditoria e conversa única

> Aprovado pelo dono em 2026-11-23: (1) mini-mapa continua MINÚSCULO no visual atual; (2) abas Carbon **dentro** do painel de logs; (3) toda ocorrência vira card de conversa no padrão `.live-chat-entry`.

**Goal:** o Runner mostra exatamente o mesmo workflow do Builder (todos os nós, inclusive desligados pelo modo), o painel inferior alterna Logs ⇄ Auditoria no MESMO frame Carbon, e todo evento (aprovação, decisão, passo, erro, áudio, resposta) é exibido no formato único de card de conversa.

**Architecture:** nenhum componente novo de layout. Reuso de `FlowNode`/nomes via `nodeDisplayNames`, `WorkflowMiniMap`, `LogsPanel` + `AuditPanel` e das classes `.live-chat-entry`.

## Global Constraints

- Não inventar UI: só Carbon (`Tabs`, `TabList`, `Tag`, `Button`, `TextArea`, `MultiSelect`) e classes existentes.
- Mini-mapa: mesmo tamanho/visual atual; nada de canvas grande.
- Zero dependências novas.
- Nenhum dado fabricado: hora do gate = hora de recebimento do evento.

## T1 — Renomear a aba `Workflow` → `Runner`

- `apps/web/src/components/TopBar.tsx`: texto do botão da view `live`.
- `apps/web/src/views/LiveView.tsx`: botão `aria-current` da nav (o título do Dropdown continua "Workflow", pois seleciona workflows).
- `apps/web/tests/ui-smoke.spec.ts`: `getByRole('button', { name: 'Runner' })`.

**Verificação:** build + Playwright; nav mostra `Builder | Runner`.

## T2 — Mini-mapa com TODOS os nós

- `apps/web/src/components/WorkflowMiniMap.tsx`: remover o filtro `enabled !== false`; nós desligados continuam desenhados com `opacity` menor e contorno tracejado. Layout e tamanho inalterados (`nodeW 86`, `nodeH 24`).

**Verificação:** com `assistente-entrevista` em modo Chat, o mini-mapa lista os 9 nós do Builder (antes: 6).

## T3 — Logs ⇄ Auditoria no mesmo painel

- `apps/web/src/components/LogsPanel.tsx`:
  - `Tabs` Carbon (`TabList size="sm"`) no cabeçalho, substituindo o título estático: `Logs` e `Auditoria (N)`.
  - Corpo troca entre os blocos de log e `<AuditPanel audit={audit} />`.
  - Remover `AUDIT_SERVICE_ID` do `MultiSelect`, dos badges, do polling e do limpar logs.
- `apps/web/src/views/LiveView.tsx`: remover as `Tabs` externas do rodapé (`footerTab`) e passar `audit` direto ao `LogsPanel`.
- `apps/web/src/index.scss`: comprimir `TabList` dentro de `.logs-panel-head` (altura ≤ 42 px) e classe do corpo da auditoria com scroll vertical.

**Verificação:** Builder e Runner têm o MESMO painel com abas; "Auditoria" não aparece mais no seletor de componentes.

## T4 — Card único de conversa

- `apps/web/src/useRunner.ts`: `Gate` ganha `ts` (hora de recebimento do evento `gate`).
- `apps/web/src/views/LiveView.tsx`:
  - `renderChatCard()` — um único shell (`.live-chat-entry`, `.live-chat-accent`, `.live-chat-avatar`, `.live-chat-entry-head/role/meta`, `.live-chat-entry-text`) usado por conversa, gate e erro.
  - Aprovação/comando pendente: card `Aprovação` + tag `Revisão` / `Comando` (+ host, risco d1, dry-run/exec ativo), texto editável e botões DENTRO do card. Remove `.live-chat-suggestion` e o card de comando acima da conversa.
  - Erro (`node_error`/`flow_invalid`/`lastRunError`): card `Erro`, vermelho. Remove o banner `.live2-error` do Live.
  - Passos do agente sempre visíveis (card `Agent` + tag `Passo N`), não mais atrás do toggle.
  - `decision.llm` / `turn.detector` viram card `Decisão` sempre visível.
  - `Pensamentos` fica só para o raciocínio cru do modelo.
- `apps/web/src/index.scss`: remover `.live-chat-suggestion*`; adicionar `.live-chat-gate-tags` e espaçamento do editor dentro do card.

**Verificação:** Playwright — gate renderiza `.live-chat-entry`; passo do agente visível sem toggle; erro como card; aprovar/rejeitar funcionam.

## T5 — Fechamento

- `npx tsc --noEmit` e `npx vite build` em `apps/web`; `node --test apps/web-server.routes.test.mjs`; Playwright `ui-smoke.spec.ts` com host próprio em porta isolada.
- Atualizar `AGENTS.md` §6 e `run.md` (nome Runner + painel).
