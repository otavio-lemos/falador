# Standardização de Nomes dos Componentes em Inglês — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Padronizar em inglês APENAS os nomes dos componentes e dos grupos (sufixo ` N` da instância e `Output 1/2/3` continuam), mantendo `Input 1`, `Output 2`… idênticos, sem mudar nenhum outro texto.

**Architecture:** Alterações puros de string nos campos que alimentam os nomes exibidos — dados (`data.ts`), derivação de etapas (`live-utils.ts`), badges dos logs (`LogsPanel.tsx`), títulos/roles do LiveView/BuilderView e asserções dos testes. Nada de mudança de estrutura.

**Tech Stack:** TypeScript/React (apps/web), Playwright (tests), Node (tarefa final de auditoria).

**Spec:** Tabela aprovada pelo dono (Hoje → Proposto EN, Título do card EN, Termo de mercado). Esta análise consolidou em: `SHORT_NAMES`, `NODE_META.titles`, `CATEGORIES.labels` (apps/web/src/data.ts), `deriveStages` labels (apps/web/src/live-utils.ts), `LogsPanel` BASE_SERVICES, `LiveView`/`BuilderView` gate titles e roles da conversa, `Palette` chip "Teste", e `ui-smoke.spec.ts`.

## Global Constraints

- Apenas NOMES de componentes e grupos mudam. SUBEXPOSTOS: param help, descriptions, legendas de portas, prompts, flow JSONs, palavras genéricas de UI — NÃO mudam.
- Sufixo de instância ` N` e grupos `Output 1/2/3` permanecem (regra "UMA VERDADE SÓ" de AGENTS.md §6).
- `data.ts` IDs internos (`capture.ffmpeg`, `asr.realtime`…) NÃO mudam.
- Ponto de verdade de nomes é `SHORT_NAMES` + `NODE_META.titles`; `nodeDisplayNames()` é a única fonte exibida — na mudança só o `label` base sai dela.

## Review Focus

1. `LiveView` roles `Transcrição`/`Agente`/`Voz` → `Transcription`/`Agent`/`Playback`: são nomes exibidos como componentes.
2. `LIVE` exibe nomes em `deriveStages` — suas labels viram EN.
3. `LogsPanel` badges usam `shortNodeName()` — os valores mudam só via `SHORT_NAMES`.
4. Sufixos internos de acesso (`selectedByGroup[grp.label]` com `'Input'`/`'Output'`) — são labelKeys, `Input`/`Output` CONTINUAM iguais.
5. Testes Playwright — 3 asserções sobre nomes mudam e DEVEM passar no sonho de IC; `npm install` faltante.

---

### Task 1: Categorias da paleta — `apps/web/src/data.ts` (`CATEGORIES` labels)

**Files:** Modify: `apps/web/src/data.ts:16,18,20,21`

- [ ] Passo 1: Atualizar labels: `transcricao`: `'Transcrição'` → `'Transcription'`; `pensar`: `'Pensar'` → `'Reasoning'`; `decidir`: `'Decisão'` → `'Routing'`; `acoes`: `'Ações / Conectores'` → `'Actions / Connectors'`; `teste`: `'Teste'` → `'Testing'` (`input`: `'Input'`, `output`: `'Output'` mantêm).
- [ ] Passo 2: Verificar: `grep -n "label: 'Transcription'" apps/web/src/data.ts` retorna 1 hit.

### Task 2: Títulos dos cards — `apps/web/src/data.ts` (`NODE_META.title`)

**Files:** Modify: `apps/web/src/data.ts:31-53`

Mapeamento exato (somente `title`; subtitles/descs/subtitles do card NÃO mudam):

| Type | Old title | New title |
|---|---|---|
| input.chat | 'Chat / Prompt de texto' | 'Chat Input' |
| asr.realtime | 'Transcrição em tempo real' | 'Speech to Text (STT)' |
| asr.lfm3 | 'Transcrição + tradução direta' | 'Speech Translation (S2ST)' |
| llm.omlx | 'Assistente de texto' | 'LLM' |
| agent.tools | 'Agente com Tools' | 'Tool-calling Agent' |
| turn.detector | 'Detector de fim de turno' | 'Turn Detection' |
| decision.llm | 'Decisão automática' | 'Decision / Router' |
| human.approve | 'Aprovação manual' | 'Human Approval (HITL)' |
| exec.command | 'Executar comando' | 'Execute Command' |
| rag.search | 'Busca RAG (Tool)' | 'RAG Search' |
| tool.mcp | 'Conector MCP' | 'MCP Connector' |
| tool.workflow | 'Gerenciar Workflows (Tool)' | 'Workflow Tools' |
| tool.web_search | 'Pesquisa Web (Tool)' | 'Web Search' |
| tool.crawler | 'Crawler / Scraping' | 'Crawler' |
| tts.sts | 'Voz (falar em voz alta)' | 'Text to Speech' |
| sink.playback | 'Tocar no alto-falante' | 'Audio Playback' |
| source.tone | 'Frases de teste' | 'Test Source' |
| pipe.delay | 'Atraso' | 'Delay' |
| pipe.parcs | 'Parciais' | 'Partials' |
| sink.collect | 'Coleta resultado' | 'Collector' |

(`capture.ffmpeg`: 'Input' e `sink.captions`: 'Output' — já OK.)

- [ ] Passo 1: Aplicar as trocas exatas da tabela.
- [ ] Passo 2: Verificar: `grep -n "Transcrição\|Assistente\|Voz (falar" apps/web/src/data.ts` → 0 hits em `NODE_META` (apenas em `SHORT_NAMES` para `asr.realtime` — esperado, ver Task 3).

### Task 3: Nomes curtos exibidos + `shortNodeName` — `apps/web/src/data.ts`

**Files:** Modify: `apps/web/src/data.ts:65-90`

- [ ] Passo 1: Atualizar `SHORT_NAMES`:
  - `'asr.realtime'`: 'Transcrição' → 'Transcription'
  - `'asr.lfm3'`: 'ASR+Trad.' → 'Speech Translation'
  - `'llm.omlx'`: 'Assistente' → 'LLM'
  - `'agent.tools'`: 'Agente' → 'Agent'
  - `'turn.detector'`: 'Turno' → 'Turn Detector'
  - `'decision.llm'`: 'Decisão' → 'Decision'
  - `'human.approve'`: 'Aprovação' → 'Approval'
  - `'exec.command'`: 'Exec' → 'Command'
  - `'tts.sts'`: 'Voz TTS' → 'TTS'
  - `'sink.playback'`: 'Áudio' → 'Playback'
  - NÃO mudar: capture.ffmpeg 'Input', input.chat 'Chat', translate.llm 'Traduzir', rag.search 'RAG', tool.mcp 'MCP', tool.workflow 'Workflows', tool.web_search 'Web', tool.crawler 'Crawler', sink.captions 'Output'.
  - Obrigatório: adicionar `'source.tone'`: 'Test Source', `'pipe.delay'`: 'Delay', `'pipe.parcs'`: 'Partials', `'sink.collect'`: 'Collector' (sem entrada hoje, caiam no fallback de first-word do title; pela tabela do dono = exatamente esses 4 nomes curtos).
- [ ] Passo 2: `shortNodeName`: `if (type === 'llm.omlx' && params && params.targetLanguage !== undefined) return 'Traduzir';` → `return 'Translate';`.
- [ ] Passo 3: Verificar: `grep -n "Traduzir\|Transcrição\|Assistente\|Voz TTS\|ASR+Trad\|'Áudio'" apps/web/src/data.ts` → 0 hits (exceto comentários; o comentário da linha 2, se tiver).

### Task 4: `deriveStages` labels — `apps/web/src/live-utils.ts:138-313`

**Files:** Modify: `apps/web/src/live-utils.ts:178,189,206,222,237,249,260,271,282,293`

- [ ] Passo 1: Trocar labels: `'Transcrição'` → `'Transcription'` (asr.realtime); `'ASR+Trad.'` → `'Speech Translation'` (asr.lfm3); `'Traduzir'` → `'Translate'` (llm.omlx targetLanguage E o assistente llm.omlx normal → `'LLM'`); `'Agente'` → `'Agent'`; `'Turno'` → `'Turn Detector'`; `'Decisão'` → `'Decision'`; `'Aprovação'` → `'Approval'`; `'Voz TTS'` → `'TTS'`. (`'Input'` e `'Output'` permanecem.)
- [ ] Passo 2: Verificar: `grep -n "'Transcrição'\|'ASR+Trad.\|'Assistente'\|'Turno'\|'Voz TTS'" apps/web/src/live-utils.ts` → 0 hits.

### Task 5: Badge dos logs — `apps/web/src/components/LogsPanel.tsx:29-67`

**Files:** Modify: `apps/web/src/components/LogsPanel.tsx:33-66`

- [ ] Passo 1: web: `fallbackLabel: 'Input · Aprovação · Output'` → `'Input · Approval · Output'`; `fallbackColors` labels `'Aprovação'` → `'Approval'`, `'Exec / RAG / MCP'` → `'Command / RAG / MCP'`.
- [ ] Passo 2: asr: `fallbackLabel: 'Transcrição'` → `'Transcription'`; colors `{ color: '#14b8a6', label: 'Transcrição' }` → `'Transcription'`.
- [ ] Passo 3: omlx: `fallbackLabel: 'Assistente · Traduzir · Agente · Decisão'` → `'LLM · Translate · Agent · Decision'`; colors `'Assistente / Traduzir / Agente'` → `'LLM / Translate / Agent'`, `'Decisão / Turno'` → `'Decision / Turn Detection'`.
- [ ] Passo 4: tts: `fallbackLabel: 'Voz TTS · ASR+Trad.'` → `'TTS · Speech Translation'`; colors `'Voz TTS'` → `'TTS'`, `'ASR+Trad.'` → `'Speech Translation'`.
- [ ] Passo 5: Verificar: `grep -n "Transcrição\|Assistente\|Aprovação\|Voz TTS\|ASR+Trad" apps/web/src/components/LogsPanel.tsx` → 0 hits.

### Task 6: Roles da conversa + gate card — `apps/web/src/views/LiveView.tsx`

**Files:** Modify: `apps/web/src/views/LiveView.tsx:577,723-727`

- [ ] Passo 1: linha 577: `Aprovação de Comando ({gate.nodeId})` → `Approval of Command ({gate.nodeId})`.
- [ ] Passo 2: linha 724: `'Transcrição'` → `'Transcription'`; linha 725: `'Agente'` → `'Agent'`; linha 726: `'Voz'` → `'Playback'`.
- [ ] Passo 3: Verificar: `grep -n "'Transcrição'\|'Agente'\|'Voz'" apps/web/src/views/LiveView.tsx` → 0 hits.

### Task 7: Gate card — `apps/web/src/views/BuilderView.tsx:235`

**Files:** Modify: `apps/web/src/views/BuilderView.tsx:235`

- [ ] Passo 1: `Aprovação ({g.nodeId})` → `Approval ({g.nodeId})`.
- [ ] Passo 2: Verificar: `grep -n "Aprovação" apps/web/src/views/BuilderView.tsx` → 0 hits.

### Task 8: Chip "Teste" — `apps/web/src/components/Palette.tsx:51`

**Files:** Modify: `apps/web/src/components/Palette.tsx:51`

- [ ] Passo 1: `'Teste'` → `'Testing'` no chip recolhível (`pal-cat--teste` e `teste` id internos NÃO mudam).
- [ ] Passo 2: Verificar: `grep -n "'Teste'" apps/web/src/components/Palette.tsx` → 0 hits.

### Task 9: Asserções Playwright — `apps/web/tests/ui-smoke.spec.ts`

**Files:** Modify: `apps/web/tests/ui-smoke.spec.ts:29,116,118`

- [ ] Passo 1: linha 29: `^Transcrição 1$` → `^Transcription 1$`.
- [ ] Passo 2: linha 116: `'Transcrição'` → `'Transcription'`.
- [ ] Passo 3: linha 118: `'Agente'` → `'Agent'`.
- [ ] Passo 4: verificar: `grep -n "Transcrição\|'Agente'" apps/web/tests/ui-smoke.spec.ts` → 0 hits.

### Task 10:truth-of-names doc — `AGENTS.md` §6

**Files:** Modify: `AGENTS.md:130` (sequência de nomes)

- [ ] Passo 1: trocar `` `Input 1`, `Transcrição 1`, `Output 1`, `Turno 1`, `Assistente 1`, `Decisão 1`, `Output 2`, `Aprovação 1`, `Output 3` `` → `` `Input 1`, `Transcription 1`, `Output 1`, `Turn Detection 1`, `LLM 1`, `Decision 1`, `Output 2`, `Approval 1`, `Output 3` ``.
- [ ] Passo 2: Verificar grep: `grep -n "Transcrição 1\|Assistente 1\|Turno 1\|Aprovação 1" AGENTS.md` → 0 hits.

### Task 11: Auditoria + verificação — comandos do dono

**Files:** (sem edição — checks read-only)

- [ ] Passo 1: `cd apps/web && npm install` (sem node_modules ainda).
- [ ] Passo 2: `npx tsc --noEmit` — 0 erros.
- [ ] Passo 3: `npm run build` — sucesso (vite build).
- [ ] Passo 4: `npm run test:e2e` — Playwright green. (Se já houver servidor em :8787 de outro checkout testando `dist` velho, subir sem `reuseExistingServer` ou com `FALADOR_WEB_PORT=8799` + baseURL correspondente — per AGENTS.md L4-trap.)
- [ ] Passo 5: Auditoria final: `grep -rn "Transcrição\|Assistente\|Aprovação\|Voz TTS\|ASR+Trad\|Frases de teste\|Coleta resultado\|Parciais\|Atraso\|'Voz'" apps/web/src apps/web/tests apps/tui --include="*.ts" --include="*.tsx" --include="*.py"` → esperado 0 hits. Exceções aceitáveis (não são nomes de componentes): `'Agente de Workflows'` (label de workflow em App.tsx:54), idiomas em `LANGS`/`LANG_OPTION_LABELS`, comentários internos, `'Orquestrador'`.
- [ ] Passo 6: Commit por alteração: `git add -A && git commit -m "refactor(web): nomes dos componentes em inglês (dono)"`.

---

## Interfaces / dependências entre tarefas

- Task 3 (`SHORT_NAMES`) alimenta `nodeDisplayNames()` (live-utils 121-136), `LogsPanel` (via `shortNodeName`), `FlowNode.data.title` (via `flow-utils.ts:135,143`) e `deriveStages` não.
- Task 4 alimenta `Stage.label`/`StageGroup.label` exibidos em RunPanel e `selectedByGroup` (keying por `'Input'`/`'Output'` — inalterado).
- Task 5 consome `shortNodeName()` — ganha a mudança pela Task 3; os badges mudam com ela (interdependência: rodar T3 antes de rodar T5, se rodar em sequência).
- Tarefas 6–8 são independentes de entre si; a auditoria (T11-5) passa por tudo.

## Notas de scope (o que NÃO muda)

- Param help (`PARAM_HELP`), subtitles de cards, descs de paleta, textos de erro, legenda de portas (`Entrada/Saída`), tags de conversa (`Especialista`, `Roteamento`, `Passo N`…), `Orquestrador` no LiveView, `Aplicações/Microfone/Chat/Escrever/Falar` (modos, não nomes de componentes), descrição em PT dos fluxos em `apps/tui/flows/*.json`.
- ID internos e `data.ts` IDs.
- ADR-011 fica como registro histórico (a emenda 2026-11-22); o estado atual fica ajustado em AGENTS.md §6.

## Proporção

~25 trocas de string + 3 trocas de asserção em spec + 1 doc living + auditoria. Sem novo código.
