# ADR-003 — Motor de Workflow e UI (Falador)

**Status:** ACEITO — 2026-11-18 (aprovado pelo usuário; canvas = React Flow + Carbon; **princípio: nada fixo**)
**Depende de:** ADR-002 (arquitetura de runtime revisada)
**Evidência:** [research/workflow-engines-2026-11.md](research/workflow-engines-2026-11.md) (coletada 2026-11-18, fontes primárias)

## Contexto

O usuário definiu o princípio central da UI do Falador: **é um canvas de nós estilo n8n/ComfyUI onde NADA é fixo.** Tudo é nós arrastáveis, conectáveis, duplicáveis e editáveis: captura de microfone, captura do sistema (BlackHole), ASR, tradução, LLM técnico, TTS, legendas, playback — e até o painel de conversa/assistente (Carbon AI Chat) é apenas **mais um tipo de nó** que o usuário instancia quantas vezes quiser e liga onde quiser. O fluxo é criado pelo usuário conforme a necessidade dele.

Primeiro TUI (habilitar/ordenar), depois UI web com canvas. Design system: **Carbon** (skill `carbon-builder` + MCP `mcp.carbondesignsystem.com` com sessão válida + doc completa).

## Constatações (verificadas em fonte oficial, 2026-11-18)

1. **Carbon não tem editor de grafo/nós.** O mais próximo ("Network diagram", "Alluvial diagram" em Data Visualization, https://carbondesignsystem.com/building-blocks/data-visualization/overview/) é gráfico de visualização somente-leitura.
2. **IBM tem @elyra/canvas** (Apache-2.0, v13.53.0, 2026-11-16) — editor de nós que segue Carbon; porém palette JSON rígida, herança Jupyter, comunidade pequena (52★ GitHub).
3. **Canvas React dominante: `@xyflow/react` (React Flow) v13, MIT** — usado por Langflow, Flowise e (via Vue Flow) n8n. Nodes são componentes React livres → recebem componentes Carbon dentro.
4. **Padrão dos 4 motores grandes (n8n, Langflow, Flowise, Dify): canvas é só renderer; motor é pacote headless separado** (Langflow extraiu `lfx`; Dify extraiu `graphon` — execução por filas, event-driven, canais de comando).
5. **`@carbon/ai-chat` 1.24.0** (Apache-2.0, ativa) — streaming nativo (`customSendMessage` + `StreamChunk`), backend próprio (LLM local via omlx) e `serviceDeskFactory`. Projeto cedo (churn 1.x) → pin de versão. **Adotado como um tipo de NÓ disponível na paleta do canvas, não como painel fixo.**
6. **TUI: Textual (MIT, v8.2.8, ativa)** — habilitar/ordenar por teclado (ListView/Tree/DataTable); drag nativo não existe no core (issue 1650 fechada).

## Decisões (ACEITAS — W1..W6)

| # | Decisão | Escolha | Motivo |
|---|---|---|---|
| W1 | Motor de grafo | **Próprio, headless, TypeScript (`falador-graph`)** — nós tipados, portas contratuais (`pcm16k`, `tokens_parcial`, `phrase`, `audio_chunk`), backpressure com buffer limitado, drop-policy, cancelamento por seq#, YAML/JSON como única fonte da verdade | Licenças dos motores prontos não-MIT (n8n Sustainable Use) e peso desnecessário; a lição dos 4 motores é "motor mínimo próprio, desacoplado da UI" |
| W2 | Canvas web (fase 2) | **`@xyflow/react` v13 + componentes `@carbon/react` dentro dos custom nodes** (CSS default do React Flow desligado; tokens Carbon aplicados aos nós; link de atribuição do xyflow mantido — cortesia) | Aprovado pelo usuário entre React Flow+Carbon e @elyra/canvas |
| W3 | Design system | **`@carbon/react`** para todo o chrome da UI (UIShell, Tabs, Dropdown/ComboBox, Tag, Notification, Slider, Toggle). Geração de código SEMPRE via MCP Carbon (`code_search`/`docs_search`) com sessão válida; auditoria com `code_audit` | Direção do usuário; doc completa + tools oficiais |
| W4 | Painel de conversa/assistente | **`@carbon/ai-chat` como TIPO DE NÓ na paleta do canvas** (instantanciável, duplicável, conectável como qualquer outro) apontando pro LLM local via omlx. **Nada de painel fixo** — princípio aprovado pelo usuário: o usuário monta o fluxo como quiser | Re-escopo do original: não há widget fixo em nenhuma tela |
| W5 | TUI (fase 1, antes da web) | **Textual** — nós listados (Tree), toggle de habilitação, reorder por teclado, status por porta | TUI valida o motor headless sem custo de UI |
| W6 | Métricas | **Carbon Charts** para painel de latência/throughput por nó (também instanciável como nó de métricas no canvas, fase posterior) | Nativo Carbon; `get_charts` do MCP dá código verbatim |

## Visão do canvas (princípio "nada fixo")

- **Paleta de nós disponíveis** (todos opcionais, replicáveis, conectáveis): `MicCapture`, `SysAudioCapture` (BlackHole), `ASR`, `Translate`, `LLM técnico`, `TTS`, `SinkCaptions`, `SinkPlayback`, `ChatPanel` (Carbon AI Chat), `Metrics` (Carbon Charts), nós de iteração/teste.
- Portas tipadas com **validação na montagem**: ligar `pcm16k` em porta de `phrase` é erro explícito.
- Cada nó de modelo mantém **Dropdown/ComboBox para troca de modelo/plugin** (ADR-002 D7: STT/LLM/TTS sempre plugáveis).
- Fluxos salvos como YAML/JSON — compartilháveis, versionáveis, fonte da única verdade; canvas e TUI são apenas views.
- Duplicação: instâncias independentes (ex.: 2 nós ASR com modelos diferentes A/B testando).

## Emendas W7..W10 (propostas pelo usuário, ACEITAS — 2026-11-18)

| # | Decisão | Design |
|---|---|---|
| W7 | **Botão de teste em cada stage** | Propriedade de todo nó: diagnóstico isolado — o motor executa um sub-grafo de 1 nó com input sintético (ASR recebe WAV de referência; Translate traduz frase fixa; TTS fala frase de teste; nós de captura mostram nível/VAD). Não existe "caixa preta" no fluxo. |
| W8 | **STT/TTS escolhidos no momento de executar (Run)** | Camada de **profile de execução** separada do grafo (mesmo modelo mental n8n: workflow ≠ parâmetros de execução). O nó declara o PAPEL (um ASR, um TTS); ao apertar Run o usuário binda modelo concreto por nó — persistido como seção `bindings:` no mesmo YAML/JSON. |
| W9 | **Idiomas independentes por nó** | Globalnão existe: cada nó carrega o NOSSO (ASR: idioma de escuta; Translate: par; TTS: idioma + voz). Fluxos assimétricos permitidos (legenda PT, voz EN). Idiomas são parâmetros de binding, não do grafo. |
| W10 | **Seleção de interface de input e output** | Nós de áudio têm device picker nativo macOS: `MicCapture` (mic / BlackHole / Aggregate) e `SinkPlayback` (BlackHole 2ch p/ injetar na conferência / saída física p/ teste). Ligado ao G1 e às aggregate devices da fase 2 (ADR-002). |

## Consequências

- O motor `falador-graph` é o artefato central: nasce headless e sem UI, consumível por TUI, web e testes de latência.
- A simulação de eventos discretos (topologias de cenário 1 e 2) usa o próprio motor para medir latências end-to-end antes de qualquer hardware.
- Carbon entra com papel claro: design system + painéis + nós de chat/métricas; **canvas nunca é Carbon** — é React Flow.

## Pendências

- [x] W1..W6 aprovados (2026-11-18)
- [x] Simulação de eventos discretos (C1/C2/C3) antes da especificação fina do motor
- [x] Especificação fina do motor: **spec v1.1** (`spec-falador-graph.md`) — 3 revisões adversariais incorporadas; **implementada e testada** (`packages/falador-graph/`, 8/8 testes verdes, 2026-11-18)
- [x] Adaptadores de nós reais (asr/tts/translate/capture/sink) + TUI Textual — **r3/r4 (2026-11-19)**: 6/6 testes falador-nodes (N6 ASR ao vivo passando) + TUI Textual smoke verde (`apps/tui/`, runner NDJSON `packages/falador-cli/run-flow.mjs`). Revisor externo dos adaptadores continua pendente.
