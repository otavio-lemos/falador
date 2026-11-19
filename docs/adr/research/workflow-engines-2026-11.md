# Pesquisa de Engines de Workflow (UI de nós) — Falador

**Data dos dados:** 2026-11-18 (UTC). Coletado pelo subagente `workflow-engines-2` via APIs oficiais (api.github.com, registry/api.npmjs.org) e docs primárias. Números de downloads npm centrados na data; revalidar antes de decisão final defesa.

## Veredicto

1. **Canvas web: `@xyflow/react` v13** (MIT, ativo 2026-11-18, dados serializáveis nodes/edges) + componentes `@carbon/react` DENTRO dos custom nodes (CSS default do React Flow desligado, tokens Carbon aplicados manualmente).
2. **Motor de grafo: próprio, headless, TypeScript**, separado do canvas (lição de Langflow→`lfx`, Dify→`graphon`, Flowise→`@flowiseai/agentflow`): YAML/JSON como única fonte da verdade; portas tipadas com validação na montagem; execução por filas com backpressure + canais de comando (cancelamento por seq#); streaming por filtro de resposta.
3. **TUI: Textual (MIT, 8.2.8, ativa)** — ListView/Tree/DataTable; reorder **por teclado** (drag nativo não existe no core — issue 1650 fechada; exemplo da discussion 1651 se um dia precisar).
4. **Painel assistente (cenário 2): `@carbon/ai-chat`** v1.24.0 (Apache-2.0, ativa) — `customSendMessage` com StreamChunk apontando pro LLM local (omlx localhost) + `serviceDeskFactory` para o fluxo de aprovação humano. Risco: projeto cedo, churn 1.x (Migration-1.0.0.md) → pin de versão.
5. **Alternativa Carbon-nativa ao canvas: `@elyra/canvas`** (IBM, Apache-2.0, v13.53.0, 2026-11-16) — editor de nós que segue Carbon, mas palette JSON rígida estilo Jupyter/Elyra pipelines, comunidade pequena (52★), modelo mental herdado de lakeshore — escolha apenas seCarbon nativo valer mais que flexibilidade.
6. **Evitar**: fork @comfyorg/litegraph (ARQUIVADO 2025-08), Drawflow e butterfly (dormantes), copiar código do n8n (Sustainable Use License, NÃO MIT) e do Flowise enterprise dir (não-MIT).

## Comparações principais

| Candidato | Licença | Manutenção | Adequação | Risco |
|---|---|---|---|---|
| @xyflow/react v13 | MIT (link atribuição — cortesia) | push 2026-11-18; 13.0.2 | **Alta** — usado por Langflow, Flowise, n8n (Vue Flow) | Baixo |
| Rete.js v2 | MIT | push 2026-10-25; 142k dl/sem | Alta conceitual (sockets tipados) | Médio |
| @elyra/canvas | Apache-2.0 | release 2026-11-16 | Média — Carbon nativo, palette rígida | Médio |
| LiteGraph.js | MIT | estagnado 2024-08; fork Comfy arquivado | Baixa | Alto |
| Drawflow | MIT | abandonado 2024-09 | Baixa | Alto |
| reaflow | Apache-2.0 | 2025-06 | Média | Médio-alto |
| butterfly (Alibaba) | MIT | dormante 2024-05 | Baixa | Alto |
| Carbon Charts network/tree | Apache-2.0 | ativa | n/a — visualização somente-leitura | n/a |

## Aprendizados de motores (n8n, Langflow, Flowise, Dify/Graphon)

1. **Renderer separado do motor desde o dia 1** — os 4 convergiram nisso.
2. **Grafo = dados declarativos serializáveis** (JSON/YAML); nada de lógica de execução no estado do canvas (dor histórica do Flowise).
3. **Nó = função pura + contexto injetado** (estilo NodeFactory do Dify; runtime state no "frame").
4. **Edge tipado = contrato de streaming** — validado na montagem do grafo (sockets do Rete; parsing/validation do Graphon).
5. **Execução por filas + canais de comando** — backpressure natural + cancelamento (Graphon: `CommandChannel`/`InMemoryChannel`, `ResponseStreamFilter` para stream de tokens).

## Componente graph engine mínimo para o Falador (`falador-graph`)

- Nós tipados: MicCapture | SysAudioCapture (BlackHole) | ASR | Translate | LLM técnico | TTS | SinkPlayback | SinkCaptions
- Portas tipadas: `pcm16k`, `tokens_parcial`, `phrase`, `audio_chunk`
- Contrato: backpressure por buffer limitado; drop-policy configurável por porta; cancelamento por `seq#`
- YAML/JSON única fonte da verdade; TUI Textual (fase 1) e UI React+Carbon+React Flow (fase 2) como views.

## Carbon AI Chat (painel entrevistador)

- Repo https://github.com/carbon-design-system/carbon-ai-chat — Apache-2.0, push 2026-11-18
- Streaming nativo: `customSendMessage` + `StreamChunk` (exemplo `examples/react/reasoning-with-streaming-generic-items/src/customSendMessage.ts`)
- Service desk custom: `CustomServiceDesks.md` — `serviceDeskFactory`
- Docs: https://chat.carbondesignsystem.com/tag/latest/docs/documents/Overview.html

## Textual (TUI)

- MIT, v8.2.8, push 2026-11-09 — https://github.com/Textualize/textual
- Widgets: ListView, Tree, DataTable, OptionList, SelectionList — https://textual.textualize.io/widget_gallery/
- Reorder drag: não existe no core (issue 1650 fechada) → reorder por teclado; exemplo SortableListView na discussion 1651

## Fontes principais

- React Flow: https://github.com/xyflow/xyflow · https://reactflow.dev · https://registry.npmjs.org/@xyflow/react
- Uso real: Langflow `@xyflow/react ^12.3.6` (src/frontend/package.json); Flowise `reactflow ^11.5.6` (packages/ui/package.json); n8n → Vue Flow (https://xyflow.com/blog/vue-flow-joins-xyflow)
- Motores: https://github.com/langgenius/graphon (Apache-2.0, Dify pin 0.8.0 em api/pyproject.toml) · https://github.com/langflow-ai/langflow (import from lfx.graph...) · https://github.com/FlowiseAI/Flowise (packages; arquivado `archived:true` retornado pela API em 2026-11-18 — revalidar) · n8n LICENSE.md (Sustainable Use)
- Elyra Canvas: https://github.com/elyra-ai/canvas · https://elyra-ai.github.io/canvas/
- ibm-products sem canvas: https://github.com/carbon-design-system/ibm-products (listagem API)
- Carbon sem network/editor: https://carbondesignsystem.com/building-blocks/data-visualization/overview/#network-diagram
