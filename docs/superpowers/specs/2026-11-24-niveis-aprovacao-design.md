# Níveis de aprovação A/B/C (global por Run)

Escolha do dono (2026-11-24): **opção A** (nível global por Run) + `human.approve`
explícito **continua** valendo. Status: implementando.

## Intenção
Um único controle: **quanto o humano quer aprovar** antes de o agente agir.
Hoje isso existe só parcialmente (param `approvalPolicy` do `agent.tools`, com
`always|non_readonly|never`) e o gate do `exec.command` é independente disso.

## Níveis
- **A · Perguntar tudo** — todo comando e toda tool abrem gate.
- **B · Só destrutivos/alteração** — leitura roda livre; mutação/desconhecido/sensível abre gate. **default**
- **C · Aprovar tudo** — nenhum gate automático (preferência explícita do humano).

## Mapeamento (motor) — um nível, duas engrenagens
- `agent.tools.approvalPolicy`: A→`always`, B→`non_readonly`, C→`never` (já existe).
- `exec.command` — **novo param** `approvalLevel`:
  - `ask_all`: abre gate **mesmo** para comando na allowlist.
  - `non_readonly`: comportamento atual (comando na allowlist roda livre; fora dela /
    caminho mutante / recusa abre gate).
  - `approve_all`: **não** abre gate; executa como aprovado (`validateCommand(..., {approved:true})`).
    As barreiras de conteúdo/allowlist são dispensadas — é a decisão explícita do nível C
    (a UI avisa). Comando vazio/parse inválido continua erro.
- **`human.approve` explícito não é governado** — pede aprovação sempre (nó colocado de propósito).

## Onde fica
- Campo de fluxo `approvalLevel: 'ask_all' | 'non_readonly' | 'approve_all'` (default `non_readonly`).
- Seletor **"Aprovação: A / B / C"** na barra do Runner (edita o campo do fluxo).
- O **runner** (`run-flow.mjs`) aplica o nível aos nós no Run (não altera o grafo salvo),
  como os perfis.

## Não-objetivos
- Não mudar a allowlist/denylist em si — só **quem decide pedir aprovação**.
- Não governar `human.approve`.
- Não criar nível por nó.

## Anti-objetivos
- Level C executar comando vazio/inválido (continua erro, não executa).
- `human.approve` virar no-op silencioso.

## Verificação
- Testes do nó `exec.command` por nível; `agent.tools` (já coberto) + rótulos.
- Runner: nível do fluxo → params dos nós (teste).
- UI: seletor persiste e o payload do run leva o nível; `tsc`/`vite build`/Playwright.
