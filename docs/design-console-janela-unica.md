# Console = janela única de browser (A+E)

Escolha do dono (2026-11-24): opção A+E. **IMPLEMENTADO** no mesmo dia.

## Problema
Hoje existem dois consoles grudados: o modal Carbon "Execuções do run" (com stdout/stderr, preso na aba da conversa) e um popup `about:blank` que reescreve `document.body.innerHTML` a cada 500 ms, sem saída real e que morre quando o modal fecha. Abrir do rodapé ou do passo de execução faz as duas coisas aparecerem.

## Desenho
- **Uma janela de browser real**, rota `/console`, mesma origem, nome `falador-console`. Abre uma vez; cliques seguintes só dão `focus()`. Nunca `about:blank`, nunca `innerHTML`.
- A janela carrega o app React/Carbon normal (Vite + fallback do host), com um componente `ConsoleView` que consome o **mesmo stream SSE do host** por `GET /api/events` (anexa ao `currentRun.clients`). Não inicia run, não depende da aba principal.
- Mostra todas as execuções em ordem cronológica: comando, host, status, stdout/stderr (com filtro), e os gates pendentes com **Aprovar e executar / Negar** chamando `/api/gate` direto.
- `BroadcastChannel('falador-console')` sincroniza a aprovação: o console avisa a aba, que registra o mesmo item no histórico de gates sem reenviar o POST. O host transmite `gate_cancelled` (`reason: answered`) para as duas janelas limparem o card pendente.
- O modal da aba principal é **removido**; os dois botões ("Console" no rodapé e "Abrir no Console" no passo) passam a abrir/focar a janela.
- `Window Management API` não entra: arrastar a janela para o outro monitor é trabalho do macOS.

## Fora de escopo
Terminal xterm.js/WebSocket (opção C), portal React (opção B), aprovação "sempre".

## Verificação
`tsc --noEmit`, `vite build`,Playwright (janela única, saída visível, aprovação no console), teste do host para `/api/events`.
