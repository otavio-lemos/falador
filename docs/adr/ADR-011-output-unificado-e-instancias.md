# ADR-011 — Output unificado (`Escrever`/`Falar`), instâncias por componente e nó Padrão

- **Status**: IMPLEMENTADO (2026-11-22; E2E ao vivo com TTS/fala real no browser: NÃO VERIFICADO)
- **Contexto**: Após unificar a entrada em um único nó `Input` (`capture.ffmpeg` com modos `sck` | `sounddevice` | `chat`), a saída ainda estava fragmentada entre `sink.captions` (Exibir), `tts.sts` (Voz TTS) e `sink.playback` (Áudio) em duas categorias distintas da paleta (`Falar` e `Saída`). Além disso, workflows com múltiplos nós do mesmo tipo (ex.: 3 `Output` em `assistente-entrevista` ou `revisao-servidor-ops`) repetiam múltiplos dropdowns iguais na barra de etapas do Executor.

## Decisões

1. **Nó único `Output` (`sink.captions`)**:
   - `sink.captions` absorve o comportamento de escrita e fala via `outputMode`:
     - `'write'` (**Escrever**): apenas exibe o texto na conversa/terminal/arquivo, sem chamadas HTTP ao sidecar `:8091` nem spawn do player.
     - `'speak'` (**Falar**): exibe o texto **e**, em mensagens finais (`final: true`), sintetiza via `POST ${ttsUrl}/tts` (sidecar residente `:8091`, LFM3-Audio) e reproduz via `player` (`/usr/bin/afplay`), com fila serializada (`maxQueue`), limpeza de diretório temporário e suporte a *barge-in* (`onControl('interrupt')`).
   - A tradução **não** fica dentro do `Output`: o texto já chega no idioma final (via `translate.llm` / `llm.omlx`), garantindo coerência entre o que é escrito na tela e o que é falado, sem duplicar LLM nem latência. Quando `outputMode` muda para `'speak'` sem `language` explícito, `inferOutputLanguage` herda automaticamente o `targetLanguage` do nó tradutor/LLM upstream (fallback `'Portuguese'`).
   - Na paleta do Builder, as categorias `Falar` e `Saída` foram unificadas em **`Output`** (`sink.captions`). `tts.sts` e `sink.playback` permanecem registrados no catálogo do backend por compatibilidade de testes/fluxos legados.

2. **Agrupamento por componente com seletor de instância no Executor (`deriveStageGroups`)**:
   - Todos os componentes da barra de etapas (`Input`, `Transcrição`, `Assistente`, `Traduzir`, `Decisão`, `Aprovação`, `Output`, etc.) são agrupados uma única vez por tipo.
   - Cada etapa possui um dropdown de **instância** seguido do dropdown de configuração da instância selecionada (e idioma, quando aplicável). **Emenda 2026-11-22 (pedido do dono):** o dropdown de instância mostra **apenas o número** (`1`, `2`, `3`…, com `★` na padrão) — o nome do componente já está no rótulo da etapa; e o nome exibido em **todo** lugar (canvas do Builder, mini-mapa do Executor, conversa e logs) é `Nome N` (`Input 1`, `Transcrição 1`, `Output 1`, `Turno 1`, `Assistente 1`, `Decisão 1`, `Output 2`, `Aprovação 1`, `Output 3`…), com `N` na ordem topológica. Fonte única: `nodeDisplayNames()` em `apps/web/src/live-utils.ts` — nada de nome genérico de tipo no card e nada de numeração divergente entre telas.

3. **Seletor de `Padrão` (`isDefault`) para `Input` e `Output` + reset pelo botão da topbar**:
   - No Builder (`capture.ffmpeg` e `sink.captions`), a propriedade booleana `isDefault` marca qual instância é a padrão (exclusiva por tipo no canvas, com tag visual `Padrão` no card).
   - Na topbar do Executor:
     - O botão de microfone (`Microphone` / `MicrophoneOff`) controla a instância padrão de `Input`.
     - O botão de alto-falante foi substituído pelo ícone de cabeça falando **`UserSpeaker`**, controlando `Falar` ↔ `Escrever` na instância padrão de `Output`.
     - Clicar em qualquer um dos dois botões da topbar **reseta o dropdown de instância** da respectiva etapa para a instância padrão (`★`) e sincroniza o modo em `localStorage` (`falador.inputMode` / `falador.outputMode`).

4. **Nota técnica verificada sobre captura `Aplicações` (SCK)**:
   - Confirmado em `services/capture-sck.swift`: o ScreenCaptureKit (`cfg.capturesAudio = true`) captura **apenas áudio de aplicações**, nunca o microfone físico.
   - Quando usado sem filtro de app (`input: ""`), `excludesCurrentProcessAudio = true` exclui o próprio `capture-sck`, mas não exclui o processo externo `/usr/bin/afplay`. O usuário controla livremente quais `Output` falam ou escrevem (nenhuma regra bloqueia um `Output` de falar).

## Evidências

- `packages/falador-graph/test/*.test.ts`: **41/41 passam**.
- `packages/falador-nodes/test/*.test.ts` (com `.env.falador` carregado): **157/158 passam**, 1 skip (`N7: capture.ffmpeg backend sounddevice — mic real`).
- `packages/falador-cli/test/*.test.mjs`: **11/11 passam**.
- `apps/web-server.test.mjs` + `apps/web-server.routes.test.mjs`: **15/15 passam**.
- `apps/web`: `tsc --noEmit` e `vite build` (1012 módulos) sem erros; Playwright E2E **6/6 passam** (`ui-smoke.spec.ts`).
- `validateFlow`: **7/7 workflows** em `apps/tui/flows/*.json` válidos em todas as combinações de `Input` (`sck`/`sounddevice`/`chat`) e `Output` (`write`/`speak`).
