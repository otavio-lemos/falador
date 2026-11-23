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

## Unificação para nó único Input (ADR-009, 2026-11-22)

Todos os **7/7 workflows** em `apps/tui/flows/*.json` foram migrados para usar **exatamente 1 único nó de entrada** (`id: "input"`, `type: "capture.ffmpeg"`), removendo `input.chat` e evitando duplicidade de nós de origem.

- **Modos no mesmo nó `input`**: `backend: 'sck' | 'sounddevice' | 'chat'`, suportando Aplicações (SCK), Microfone (PortAudio) e Chat de texto (`placeholder` + saída `input.out_text`), sem lista de apps/mics na barra de etapas da UI.
- **Fluxos originalmente de voz (`backend: "sck"`)**: `assistente-entrevista.json` (9 nós / 9 edges, removido `chat` e ligado `input.out_text → assistente.in`), `legendas-traducao-pt.json` (4/4), `tradutor-voz-en.json` (6/6) e `transcricao-ao-vivo.json` (3/3).
- **Fluxos originalmente chat-only (`backend: "chat"`)**: `agente-suporte-ops.json` (6/6), `agente-workflows.json` (6/6) e `revisao-servidor-ops.json` (12/12) ganharam nó `asr` (`asr.realtime`, Voxtral) para permitir alternar para Aplicações ou Microfone diretamente pelo nó `input`, mantendo `backend: "chat"` como padrão.

## Unificação para Output único + seletores de Padrão (ADR-011, 2026-11-22)

Todos os **7/7 workflows** foram atualizados para o nó unificado `Output` (`sink.captions` com `outputMode: "write" | "speak"`, `language`, e `isDefault: true` no `Input` e no `Output` principal):

- `tradutor-voz-en.json`: removidos `voz` (`tts.sts`) e `audio` (`sink.playback`); `legenda` (`sink.captions`) assume `outputMode: "speak"`, `language: "English"`, `voice: "female"`, `isDefault: true` (**4 nós / 4 edges**).
- Demais 6 workflows: `Output` padrão em `outputMode: "write"` (`isDefault: true`), podendo alternar para `"speak"` diretamente no Executor ou pelo botão `UserSpeaker` da topbar.
- `validateFlow` validou os **7/7 workflows** em todas as combinações de `Input` (`sck`/`sounddevice`/`chat`) × `Output` (`write`/`speak`).

## Validação pós-correção

### Contagens após unificação do nó único Input (2026-11-22)

Verificação estrutural JSON nos 7 arquivos em `apps/tui/flows/*.json` (sem `input.chat`, exatamente 1 nó `capture.ffmpeg` com `id: "input"`):

```text
apps/tui/flows/agente-suporte-ops.json: nodes=6 edges=6 backend=chat
apps/tui/flows/agente-workflows.json: nodes=6 edges=6 backend=chat
apps/tui/flows/assistente-entrevista.json: nodes=9 edges=9 backend=sck
apps/tui/flows/legendas-traducao-pt.json: nodes=4 edges=4 backend=sck
apps/tui/flows/revisao-servidor-ops.json: nodes=12 edges=12 backend=chat
apps/tui/flows/tradutor-voz-en.json: nodes=6 edges=6 backend=sck
apps/tui/flows/transcricao-ao-vivo.json: nodes=3 edges=3 backend=sck
```

### Contagens históricas (pré-unificação Input)

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

`orphans` reportados pelo script são apenas fontes (`input`/`capture`, `chat`, tools) e `dead` apenas sinks — comportamento esperado.

## Não verificado

- A validação `validateFlow` com os novos params e porta de saída de `capture.ffmpeg` (`backend: "chat"`, `placeholder`, `out_text`) depende da integração com as branches de engine (`packages/falador-nodes`) e UI (`apps/web`). Neste worktree foi verificada a integridade estrutural/JSON e de invariantes dos 7 arquivos.
- Não rodei E2E com modelo/áudio/microfone/chat reais ou verificação no browser após a migração para nó único Input.

## Consolidação (2026-11-23)

Os três fluxos da família tradução/transcrição foram **unificados em um único workflow**:

- `tradutor-voz-en.json` (STT → `translate.llm` → sink `speak`)
- `legendas-traducao-pt.json` (STT → `translate.llm` → sink `write`)
- `transcricao-ao-vivo.json` (STT → sink `write`, sem tradução)

**Motivo:** eram o mesmo grafo (`input → asr → translate.llm → sink`) com apenas `targetLanguage` e `outputMode` como variáveis. O nó `translate.llm` já suporta **passthrough** (idioma desabilitado → repassa sem LLM) e a UI já expõe seletor de idioma + toggle write/speak por runtime. Unificado em **`traducao-transcricao.json`** (4 nós / 4 edges / válido).

**Removidos (redundantes):** `tradutor-voz-en.json`, `legendas-traducao-pt.json`, `transcricao-ao-vivo.json`.

## Sources

[1] https://huggingface.co/blog/build-small-hackathon/local-interview-copilot — Local interview copilot architecture
[2] https://research.google/blog/real-time-speech-to-speech-translation — Google real-time S2ST
[3] https://deepgram.com/blog/real-time-speech-to-speech-translation — Deepgram cascaded translation
[4] https://blog.n8n.io/human-in-the-loop-automation — n8n HITL
[5] https://arxiv.org/html/2607.19297v1 — LangGraph agentic workflows
