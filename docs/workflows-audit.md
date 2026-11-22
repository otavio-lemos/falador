# Auditoria dos workflows do Falador

Data: 2026-11-22. Escopo: `apps/tui/flows/*.json`, motor `falador-graph`, nós `falador-nodes`, runner/headless e padrões de mercado observados em fontes públicas.

## Resumo executivo

- Encontrei **9 workflows ativos** e **1 arquivo temporário** (`.web-run.tmp.json`).
- **Todos os 9 validavam** no `validateFlow` com bindings injetados. Ou seja: o problema não era sintaxe de grafo; era **redundância, modelo errado no nó e desenho de fluxo desatualizado**.
- **Removidos 3 arquivos**: `legendas-traducao-direta.json`, `chat-agente-suporte.json`, `.web-run.tmp.json`.
- **Corrigidos 5 fluxos**: `assistente-entrevista.json`, `tradutor-voz-en.json`, `agente-suporte-ops.json`, `revisao-servidor-ops.json`, `agente-workflows.json`.
- **Catálogo final: 7 workflows**, com papéis ortogonais: transcrição, legendas, interpretação de voz, entrevista, agente de suporte/ops, agente de workflows e revisão de servidor com risco.

## O que o mercado mostrou

1. **Copiloto de entrevista é um caminho rápido e especializado, não um único LLM.** O padrão local-first publicado é `áudio → STT → detecção rápida de fronteira de pergunta → classificador de tópico/padrão → dica curta → cartão flutuante`, com execução local para privacidade e latência[1]. Isso confirma que `turn.detector` deve ficar **entre** ASR e assistente, e que a sugestão não deve passar por TTS.
2. **Tradução em tempo real é cascata por padrão.** `ASR → MT → TTS` continua sendo o padrão de produção para many-to-many, enquanto modelos diretos ganham em casos específicos e exigem arquitetura própria[2][3]. O Google descreve a cascata clássica e seus problemas de atraso/erro acumulado, e seu modelo fim-a-fim dedicado chega a ~2 s[2]. O Deepgram destaca que a arquitetura de streaming é a decisão mais importante e que TTS domina o orçamento de latência[3].
3. **HITL deve ser seletivo e colocado em ações de risco.** O padrão recomendado é deixar o caminho de alta confiança seguir sozinho e enviar apenas casos-limite/low-confidence para revisão humana[4]; em fluxos estadoful, o gate precisa ser um nó explícito, com rota, trilha e retomada[5].
4. **Menos fluxos, papéis mais claros.** Um catálogo com quatro agentes quase idênticos não ajuda o usuário: ele multiplica manutenção e aumenta a chance de executar o fluxo errado.

## Inventário e decisões

| Workflow | Estado anterior | Decisão | Resultado |
|---|---|---|---|
| `transcricao-ao-vivo.json` | STT puro, correto | **Manter** | Único fluxo de transcrição sem tradução/LLM. |
| `legendas-traducao-pt.json` | `asr.realtime → translate.llm → sink.captions`, correto | **Manter** | Cascata canônica EN→PT para legendas; alinhada ao padrão ASR→MT[3]. |
| `tradutor-voz-en.json` | Usava `llm.omlx` com `targetLanguage: English` para traduzir | **Corrigir** | Trocado para `translate.llm`, o nó dedicado de tradução; mantido `tts.sts → sink.playback`. Agora o fluxo é explicitamente `ASR → MT → TTS`[2][3]. |
| `assistente-entrevista.json` | `asr.final → llm.omlx`, sem detecção semântica de turno | **Corrigir** | Inserido `turn.detector` (d1-2B/systemone) entre `asr.out` e `assistente.parcs`; removida a aresta direta `asr.final → assistente.in`. O gate humano e as duas rotas (`auto`/`humano`) foram preservados. |
| `agente-suporte-ops.json` | Voz + SCK + turn detector + agente + RAG + exec | **Refatorar e manter como canônico** | Convertido para **chat-only**, fundindo o que havia de útil em `chat-agente-suporte.json`: `input.chat → agent.tools` com `rag.search`, `exec.command` readonly/dryRun e `approvalPolicy: always`. Sem captura de áudio no fluxo padrão (ADR-005). |
| `chat-agente-suporte.json` | Chat idêntico ao agente de suporte | **Apagar** | Duplicata do novo `agente-suporte-ops.json`. |
| `revisao-servidor-ops.json` | Voz + SCK + turn detector + classificação de risco + gates | **Corrigir e manter** | Convertido para **chat-only**; preservadas as três rotas de risco (`leitura_segura`, `sensivel`, `bloqueado`), os dois gates humanos e `dryRun: true`. É o fluxo HITL com decisão explícita[4][5]. |
| `agente-workflows.json` | Chat + SCK/Voxtral alimentando o mesmo agente | **Corrigir e manter** | Removidos `capture.ffmpeg` e `asr.realtime`; o meta-agente agora é chat-only. Mantidos `tool.workflow` e `tool.web_search` com anti-SSRF. |
| `legendas-traducao-direta.json` | `asr.lfm3` fazendo tradução nativa por janela de áudio | **Apagar** | Não é streaming, sofre com janela cortada no meio da frase e duplica `legendas-traducao-pt.json`. Tradução direta real exige modelo fim-a-fim próprio[2]. |
| `.web-run.tmp.json` | Resíduo temporário do host | **Apagar** | Não é workflow. |

## Correções aplicadas em detalhe

1. **`tradutor-voz-en.json`** — `tradutor`: `llm.omlx` → `translate.llm`; removidos `historyMax` e `template`; mantidos `targetLanguage: "English"`, `enableThinking: false`, legendas e TTS.
2. **`assistente-entrevista.json`** — novo nó `turno` (`turn.detector`, `mode: systemone`, `minWords: 3`, `completeThreshold: 0.6`, `maxWaitMs: 1200`, `maxMergedTurns: 3`); aresta `asr.out → turno.in → assistente.parcs`. A transcrição continua em `asr.out → transcricao.in`.
3. **`agente-suporte-ops.json`** — reescrito como chat-only; `input.chat` com placeholder real; `agent.tools` com `approvalPolicy: always`; `exec.command` readonly/dryRun; `rag.search` com `toolName: search_docs`.
4. **`revisao-servidor-ops.json`** — `input.chat → planejador.in`; nó de captura/ASR/turno removido; roteamento de risco e gates preservados.
5. **`agente-workflows.json`** — captura e ASR removidos; descrição atualizada para chat-only/ADR-005.

## Validação pós-correção

Script headless com `createRegistry + registerFaladorNodes + validateFlow`, injetando os bindings que o runner cria:

```text
agente-suporte-ops.json     valid=true  nodes=5  edges=4
agente-workflows.json       valid=true  nodes=5  edges=4
assistente-entrevista.json  valid=true  nodes=9  edges=8
legendas-traducao-pt.json   valid=true  nodes=4  edges=3
revisao-servidor-ops.json   valid=true  nodes=11 edges=10
tradutor-voz-en.json        valid=true  nodes=6  edges=5
transcricao-ao-vivo.json    valid=true  nodes=3  edges=2
```

`orphans` reportados pelo script são apenas fontes (`capture`, `chat`, tools) e `dead` apenas sinks — comportamento esperado.

## Não verificado

- Não rodei E2E com modelo/áudio reais nesta auditoria: o omlx estava sendo compilado/reiniciado pelo dono. A validação foi estática + headless.
- A lista do catálogo na UI deve ser conferida no browser após o próximo build; os arquivos foram renomeados/removidos diretamente em `apps/tui/flows/`.

## Sources

[1] https://huggingface.co/blog/build-small-hackathon/local-interview-copilot — Local interview copilot architecture
[2] https://research.google/blog/real-time-speech-to-speech-translation — Google real-time S2ST
[3] https://deepgram.com/blog/real-time-speech-to-speech-translation — Deepgram cascaded translation
[4] https://blog.n8n.io/human-in-the-loop-automation — n8n HITL
[5] https://arxiv.org/html/2607.19297v1 — LangGraph agentic workflows
