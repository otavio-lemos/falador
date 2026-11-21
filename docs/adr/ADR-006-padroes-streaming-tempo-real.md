# ADR-006 — Padrões de Streaming em Tempo Real (Pipecat / LiveKit / GStreamer / n8n) no Motor Falador

**Status:** IMPLEMENTADO — 2026-11-21 (Fases 1–6 implementadas e testadas: 57/57 testes verdes, `turn.detector` ao vivo 87 ms com `d1-2B-MLX-4bit`; E2E SCK com call real: `NÃO VERIFICADO`)
**Depende de:** ADR-002 (runtime MLX/omlx), ADR-003 (canvas/nada fixo), ADR-004 (mlx-audio), ADR-005 (cenário 2 só-texto + SCK), `spec-falador-graph.md` v1.1

---

## 1. Contexto e Motivação

Ao avaliar ferramentas de mercado para fluxos de IA e mídia (**n8n**, **ComfyUI**, **Pipecat**, **LiveKit Agents** e **GStreamer**), concluiu-se que:

- **n8n** (automação event/item-driven) e **ComfyUI** (pipeline DAG por job/batch sobre PyTorch) **não substituem** o motor de streaming contínuo de baixa latência do Falador (áudio PCM 16 kHz via ScreenCaptureKit → WebSocket ASR → tokens LLM em ~65 ms → decisão `d1` em ~40 ms → UI Live Mode).
- **Pipecat** (BSD-2-Clause), **LiveKit Agents** (Apache-2.0, exceto modelos proprietários sob *LiveKit Model License*) e **GStreamer** (LGPL v2.1+) são frameworks de código (sem canvas visual n8n/ComfyUI) cujo núcleo resolve problemas clássicos de voz em tempo real.
- Em vez de migrar de motor ou adicionar dependências pesadas (WebRTC, PyTorch, C/GLib), **absorvemos os melhores padrões arquiteturais dessas ferramentas diretamente no `falador-graph`, `falador-nodes` e `apps/web-server.mjs`**, reutilizando 100% da stack local já medida (`omlx` :8080, `d1-2B-MLX-4bit`, `mlx-audio` :8090, SCK).

### 1.1 Diagnóstico do código atual (evidências verificadas em 2026-11-21)

Inspeção direta do repositório revelou **6 lacunas concretas** que esses padrões fecham:

| # | Arquivo / Linha | Situação atual | Impacto em call/entrevista real |
|---|---|---|---|
| G1 | `apps/tui/flows/assistente-entrevista.json:86-90` | Aresta `captura.out -> asr.in` usa `capacity: 128, overflow: "block"` (~10,2 s de buffer a 80 ms/chunk). | Se o ASR oscilar, a fila bloqueia a captura e acumula atraso crescente (*latency drift*) em vez de priorizar o áudio atual. |
| G2 | `packages/falador-nodes/src/asr-realtime.ts:58,166` | `PENDING_MAX_FRAMES = 192` (~19 s de buffer pré-conexão/reconexão); eventos `input_audio_buffer.speech_started` e `speech_stopped` são ignorados. | Reconexão despeja até 19 s de áudio velho no ASR; falta gatilho nativo de início/fim de fala para *barge-in*. |
| G3 | `packages/falador-graph/src/runtime.ts:190-204` e `llm-omlx.ts:137` | `emitControl()` só marca envelopes na fila (`q.markCancelled`) e **não chama `target.runtime.onControl(c)`** nem propaga downstream; `llm.omlx.onControl()` é vazio. | Quando o entrevistador emenda ou corrige a pergunta no meio, o `llm.omlx` continua gerando a resposta antiga até o fim. |
| G4 | `packages/falador-nodes/src/asr-realtime.ts` → `llm-omlx.ts` | Fechamento de turno depende apenas de `server_vad` (silêncio acústico fixo). | Pausas curtas de raciocínio (*"um… let me think…"*) cortam a pergunta ao meio e disparam sugestões prematuras; ou silêncio longo atrasa a resposta. |
| G5 | `packages/falador-nodes/src/llm-omlx.ts:60,129-131` | **Bug real encontrado:** `history.push(...)` roda sempre, mas o corte só ocorre `if (historyMax > 0 && ...)`. Com `historyMax = 0` (default), o histórico cresce sem limite! Além disso, não há orçamento de caracteres nem feedback do texto editado em `human.approve`. | Tradutores acumulam histórico infinito sem querer; assistente de entrevista não tem limite de tokens/chars nem botão de limpar contexto da sessão. |
| G6 | `packages/falador-graph/src/types.ts:26-39` e `apps/web-server.mjs` | `Envelope.meta` não carrega timestamps de trace ponta-a-ponta por turno; não há exportação estruturada nem webhook pós-sessão. | Difícil diagnosticar qual nó causou lentidão durante uma call; fim da sessão descarta transcrição/sugestões sem integração pós-call (ex.: n8n/Markdown). |

---

## 2. Decisões Arquiteturais (S1–S6)

| # | Origem do padrão | Decisão no Falador | Reutilização da stack existente |
|---|---|---|---|
| **S1** | GStreamer (*leaky queue*) | Áudio live usa `overflow: "drop_oldest"` + `ttlMs` curto na aresta `captura → asr` e buffer de reconexão limitado em ms no `asr.realtime`. | `BoundedEdge` (`queue.ts`) **já suporta** `drop_oldest` e `ttlMs` — basta configurar e endurecer `asr-realtime.ts`. |
| **S2** | Pipecat (`StartInterruptionFrame`) | Estender `ControlMsg` com `kind: 'interrupt'` e propagar `onControl(c)` downstream no `RunningGraph` (`runtime.ts`). `asr.realtime` dispara `interrupt` em `speech_started` (com debounce); `llm.omlx`, `human.approve`, `tts.sts` e `sink.playback` abortam trabalho obsoleto imediatamente. | Reaproveita o canal de controle já previsto na `spec-falador-graph.md` v1.1 (`emitControl` / `onControl`). |
| **S3** | Pipecat (*Smart Turn*) / LiveKit (*Turn Detector*) | Novo nó plugável `turn.detector` (`packages/falador-nodes/src/turn-detector.ts`) entre `asr.realtime` e `llm.omlx`, usando **`d1-2B-MLX-4bit` via `/v1/systemone`** (~40 ms warm) para decidir `complete` vs `incomplete` com fallback de timeout determinístico. | Usa o `omlx` :8080 + `d1-2B` já residentes (zero modelo novo, zero licença restrita, 100% opcional no canvas — ADR-003). |
| **S4** | Pipecat / LiveKit (*Context Aggregator*) | Corrigir bug de `historyMax === 0` em `llm.omlx`, adicionar `historyCharBudget`, impedir que turnos abortados/vazios poluam o histórico, e suportar limpeza de histórico em tempo de execução (`reset_history`). | Evolução direta de `llm-omlx.ts` sem criar nó extra obrigatório. |
| **S5** | Pipecat / LiveKit (*MetricsFrame*) | Convenção `Envelope.meta.trace` com carimbos leves por estágio (`tCapture`, `tAsrFirst`, `tAsrFinal`, `tTurn`, `tLlmTtft`, `tLlmFinal`, `tDecision`), propagada de ponta a ponta e exibida no popover de Latência do `LiveView.tsx`. | Reaproveita `Envelope.meta` já existente e o stream NDJSON → SSE do `apps/web-server.mjs`. |
| **S6** | n8n (Webhook pós-call) | Exportação pós-sessão em `apps/web-server.mjs` (`POST /api/session/export`): salva ata Markdown local (`sessions/`) e, se configurado explicitamente pelo usuário (opt-in), envia JSON estruturado via HTTP `POST` para um webhook (ex.: n8n local). | Zero dependência nova (Node `fetch` nativo); mantém 100% local/offline por padrão. |

---

## 3. Plano de Implementação Detalhado (6 Fases Incrementais)

Cada fase é **independente, testável isoladamente e não quebra fluxos existentes**.

---

### Fase 1 — Bugfix de Histórico + Anti-*Latency Drift* no Áudio (GStreamer)

**Objetivo:** eliminar crescimento silencioso de histórico em `llm.omlx` e evitar atraso acumulado na legenda durante calls longas.

#### Arquivos afetados
1. `packages/falador-nodes/src/llm-omlx.ts`
   - **Correção do bug (`L129-131`):** só inserir em `history` quando `historyMax > 0` **e** `acc.trim().length > 0` **e** o turno não tiver sido abortado/interrompido.
   - Adicionar `historyCharBudget` (param numérico opcional, default `4000`): antes de montar `messages`, podar os pares mais antigos (`user`+`assistant`) até que a soma de caracteres do histórico caiba no orçamento.
2. `packages/falador-nodes/src/asr-realtime.ts`
   - Adicionar param opcional `maxPendingMs` (default `2000`, validado `> 0`).
   - Converter `PENDING_MAX_FRAMES` fixo (`192`, ~19 s) para cálculo dinâmico baseado em `maxPendingMs` e tamanho médio de frame (ou rastrear `{ bytes, ts }` e descartar tudo com `Date.now() - ts > maxPendingMs` antes do `flush()` na reconexão).
   - Emitir métrica `asr.realtime.pendingDropped` quando descartar frames antigos.
3. Fluxos live em `apps/tui/flows/` (`assistente-entrevista.json`, `legendas-traducao-pt.json`, `legendas-traducao-direta.json`, `transcricao-ao-vivo.json`, `tradutor-voz-en.json`)
   - Na aresta `captura.out -> asr.in`: alterar de `capacity: 128, overflow: "block"` para `capacity: 32, overflow: "drop_oldest", ttlMs: 1500` (~2,5 s de teto, expirando chunks > 1,5 s).
   - Manter `overflow: "block"` apenas nas arestas de controle/decisão (`assistente -> decisao -> sugestao/revisao`), onde não se pode perder uma resposta pronta.

#### Verificação da Fase 1
- Teste unitário em `packages/falador-nodes`:
  - `llm.omlx` com `historyMax: 0` → `messages` da 2ª chamada NÃO contém a 1ª fala.
  - `llm.omlx` com `historyMax: 10, historyCharBudget: 100` → poda pares antigos respeitando o orçamento.
  - `asr.realtime` com `maxPendingMs: 300` → frames mais velhos que 300 ms são descartados antes do flush e incrementam `asr.realtime.pendingDropped`.
- Validar todos os 5 fluxos de `apps/tui/flows/` com `validateFlow`.

---

### Fase 2 — *Barge-in* / Interrupção Propagada no Grafo (Pipecat)

**Objetivo:** quando o interlocutor volta a falar e emenda a pergunta, cancelar imediatamente geração LLM em curso (e TTS/playback ou gate pendente) sem esperar o turno antigo terminar.

#### Arquivos afetados
1. `packages/falador-graph/src/types.ts`
   - Estender `ControlMsg`:
     ```ts
     export interface ControlMsg {
       kind: 'cancel' | 'interrupt';
       scope: ControlScope;
       uptoSeq?: number;
       uptoSeqByPort?: Record<string, number>;
       /** Identificador de origem para evitar loops/duplicação na propagação. */
       sourceNode?: string;
       /** Turno/item sendo interrompido (opcional). */
       turnId?: string;
       reason?: string;
     }
     ```
   - Estender `RunEvent` com `{ type: 'interrupted'; by: string; reason?: string; affectedNodes: string[] }`.
2. `packages/falador-graph/src/runtime.ts`
   - Em `emitControl(port, c)`:
     - Manter comportamento atual de `kind === 'cancel'` (marca `cancelledSeqs` e `q.markCancelled(c)`).
     - Para `kind === 'interrupt'` (e também notificando `onControl` em `cancel` quando implementado):
       1. Encontrar todas as arestas saindo de `(vn.id, port)`.
       2. Se `c.kind === 'interrupt'`, executar **BFS downstream** a partir dos destinos alcançáveis (usando `visited = new Set<string>()`), descartando/marcando mensagens pendentes nas filas intermediárias de `tokens_parcial`/`phrase` e invocando `target.runtime.onControl?.({ ...c, sourceNode: vn.id })` em cada nó alcançável.
       3. Emitir `RunEvent` `interrupted` com `affectedNodes`.
       4. Proteger cada chamada `onControl` com `try/catch` (erro em `onControl` segue política do nó, nunca derruba o runtime).
   - Nota de segurança: `emitControl` continua síncrono e não bloqueia em filas cheias.
3. `packages/falador-nodes/src/asr-realtime.ts`
   - Novos params opcionais:
     - `emitInterruptOnSpeech` (boolean, default `false` — **opt-in** por fluxo, para não interromper tradução simultânea contínua onde o falante não para!).
     - `bargeInDebounceMs` (number, default `300`): ao receber `input_audio_buffer.speech_started`, só emite `ctx.emitControl('out', { kind: 'interrupt', scope: 'port', reason: 'speech_started' })` se o usuário continuar falando por pelo menos `bargeInDebounceMs` (cancelando o timer se `speech_stopped` chegar antes — filtra tosse, clique ou ruído curto).
   - Métrica: `asr.realtime.interrupts`.
4. `packages/falador-nodes/src/llm-omlx.ts`
   - Rastrear `interruptedCurrent = false` por requisição em voo.
   - Implementar `onControl(c)`:
     - Se `c.kind === 'interrupt'` e `controller !== null`: marcar `interruptedCurrent = true`, chamar `controller.abort()`, incrementar `ctx.metrics.counter('llm.omlx.interrupted', 1)`.
   - No fechamento do stream (`L128`): se `interruptedCurrent === true`, **não emitir `final: true`** e **não salvar no `history`**.
5. `packages/falador-nodes/src/human-approve.ts`
   - Implementar `onControl(c)`: se `c.kind === 'interrupt'` e houver gate pendente, rejeitar silenciosamente o gate obsoleto (`reason: 'interrupted'`) para liberar a UI para o novo turno.
6. `packages/falador-nodes/src/tts-sts.ts` e `packages/falador-nodes/src/sinks.ts`
   - `tts.sts`: abortar `fetch` em voo em `onControl` (`interrupt`).
   - `sink.playback`: se houver reprodução ativa, encerrar/flush do processo filho de áudio em `onControl` (`interrupt`).
7. `apps/web/src/components/NodeEditor.tsx` & `apps/web/src/flow-utils.ts`
   - Expor `emitInterruptOnSpeech` (toggle) e `bargeInDebounceMs` no Inspector do nó `asr.realtime`.

#### Verificação da Fase 2
- Teste unitário em `packages/falador-graph`:
  - Grafo `A -> B -> C`: `A.emitControl('out', { kind: 'interrupt', ... })` chama `B.onControl` e `C.onControl` exatamente 1 vez cada, mesmo em diamante `A -> B, A -> C, B -> D, C -> D`.
  - Evento `interrupted` aparece em `eventsSnapshot()`.
- Teste unitário em `packages/falador-nodes`:
  - `llm.omlx` com servidor HTTP mock lento: `interrupt` durante streaming aborta o `fetch` em < 50 ms, não emite `final: true` e não grava no `history`.
  - `asr.realtime`: `speech_started` seguido de `speech_stopped` em 100 ms (< debounce 300 ms) **não** dispara `interrupt`; fala sustentada >= 300 ms dispara.

---

### Fase 3 — Detecção Semântica de Fim de Turno com `d1-2B` (Pipecat Smart Turn / LiveKit)

**Objetivo:** distinguir pausa de raciocínio (*"So for caching I would use..."*) de fim real de pergunta (*"How would you handle cache invalidation?"*) sem adicionar modelos pagos ou licenças restritas.

#### Decisão de design: por que um **nó dedicado `turn.detector`**?
- Respeita **ADR-003 ("nada fixo")**: o usuário pode arrastar `turn.detector` entre `asr.realtime` e `llm.omlx` no fluxo de entrevista, e **não** usá-lo em tradução simultânea rápida.
- Mantém `asr.realtime` simples e focado em STT.

#### Especificação do nó `turn.detector`
- **Arquivo:** `packages/falador-nodes/src/turn-detector.ts` (registrado em `packages/falador-nodes/src/index.ts`).
- **Portas:**
  - `inputs`: `[{ name: 'in', type: 'tokens_parcial' }]`
  - `outputs`: `[{ name: 'out', type: 'tokens_parcial' }]`
- **Params:**
  - `baseUrl` (string, default `http://127.0.0.1:8080`)
  - `model` (string, default `'d1-2B-MLX-4bit'`)
  - `mode` (`'systemone' | 'heuristic'`, default `'systemone'`)
  - `minWords` (number, default `3`): turnos com menos palavras que isso só fecham por timeout (evita chamar `d1` em *"uh-huh"*, *"yeah"*).
  - `completeThreshold` (number, default `0.65`): probabilidade mínima de `complete` retornada pelo `/v1/systemone` para fechar imediatamente.
  - `maxWaitMs` (number, default `2200`): tempo máximo segurando um turno `incomplete` após o último `final: true` do ASR antes de forçar fechamento (garante que nunca trava esperando indefinidamente).
  - `maxMergedTurns` (number, default `4`): máximo de segmentos ASR concatenados num único turno antes de liberar.
- **Fluxo de execução:**
  1. Recebe `{ text, final: false }` do ASR → cancela eventual timer `waitTimer` (a pessoa voltou a falar!) e repassa `{ text: buffer + ' ' + text, final: false }` se útil para preview.
  2. Recebe `{ text, final: true }` do ASR:
     - Concatena `text` ao `buffer` do turno atual.
     - Se `buffer` termina com `?` e tem `>= minWords` → **fast-path**: fecha turno imediatamente (`0 ms` de overhead!).
     - Se `mergedCount >= maxMergedTurns` → fecha turno imediatamente.
     - Caso contrário, chama `/v1/systemone` no `omlx` (~40 ms) com:
       - `state`: `buffer`
       - `questions.turn`: `{ type: 'choice', instructions: 'Determine if the speaker has finished their thought/question or paused mid-sentence.', criteria: { complete: 'Complete question, statement, or clear end of turn', incomplete: 'Cut off mid-sentence, filler pause, or clearly continuing' } }`
     - Se `choice === 'complete'` e `(confidence ?? 1) >= completeThreshold`:
       - Emite `{ text: buffer, final: true }` imediatamente, limpa `buffer`, registra métrica `turn.detector.immediate`.
     - Se `incomplete` (ou falha de rede/timeout > 300 ms no `d1`):
       - Arma `waitTimer` de `maxWaitMs`. Se não chegar nova fala até lá, emite `{ text: buffer, final: true }` e registra `turn.detector.timeoutFlush`.
  3. Em `stop()`: se houver `buffer` pendente, faz flush limpo (sem usar `ctx.signal`, respeitando lição do N10 em `AGENTS.md` §4).
  4. Em `onControl(c)`: se `c.kind === 'interrupt'`, cancela `waitTimer` sem perder o novo trecho que acabou de começar.
- **Integração UI:**
  - Adicionar `turn.detector` em `apps/web/src/flow-utils.ts`, `Palette.tsx` (categoria *Decisão / Controle*) e `NodeEditor.tsx` (filtrando dropdown de modelo para modelos `d1` / decisão).
  - Atualizar `apps/tui/flows/assistente-entrevista.json` (ou criar variante/incluir `turn.detector` opcional conforme preferência do dono).

#### Verificação da Fase 3
- Teste unitário com mock HTTP de `/v1/systemone`:
  - Frase quebrada em 2 segmentos (`"So in distributed systems..."` → `incomplete`, seguido de `"...how do you avoid split brain?"` → `complete`) emite **1 único** `final: true` concatenado.
  - Frase incompleta sem continuação dispara flush automático após `maxWaitMs`.
  - Fast-path de pontuação `?` não faz chamada HTTP.
  - Queda do `omlx` não derruba o nó (cai no fallback `maxWaitMs`).
- Medição real no M4 Pro: confirmar latência warm de `turn.detector` <= 50 ms p50 com `d1-2B-MLX-4bit`.

---

### Fase 4 — Memória Conversacional Limpa + Reset em Live (Context Aggregator)

**Objetivo:** permitir que o assistente de entrevista acompanhe perguntas encadeadas (*follow-ups*) sem misturar tópicos de perguntas anteriores quando o entrevistador muda de assunto.

#### Arquivos afetados
1. `packages/falador-nodes/src/llm-omlx.ts`
   - Suportar `onControl` com novo `kind` ou comando de host via stdin/binding: `resetHistory()` (limpa `history.length = 0`, incrementa `llm.omlx.historyResets`).
   - Registrar métrica `llm.omlx.historyTurns` (quantidade atual de turnos na memória).
   - Opcional (Fase 4b): se o fluxo tiver `human.approve`, permitir que o host envie a resposta **aprovada/editada pelo usuário** de volta como contexto oficial daquele turno (em vez da sugestão crua não editada).
2. `apps/web-server.mjs` e `packages/falador-cli` (runner NDJSON)
   - Novo comando stdin NDJSON: `{"type":"reset_history","nodeId":"assistente"}` (ou `nodeId: "*"` para todos os `llm.omlx`).
   - Novo endpoint HTTP: `POST /api/run/reset-history` no `apps/web-server.mjs`.
3. `apps/web/src/views/LiveView.tsx`
   - Botão compacto `"Limpar contexto"` no painel da sugestão (ou header do Live Mode) para resetar a memória do LLM quando o entrevistador mudar de assunto (ex.: de System Design para Behavioral), sem precisar parar e reiniciar o run.

#### Verificação da Fase 4
- Teste unitário: 3 turnos → `reset_history` → 4º turno envia `messages` apenas com `system` + pergunta atual.
- Teste E2E no browser: clicar "Limpar contexto" durante sessão ativa e verificar via evento/log que `historyTurns` volta a 0.

---

### Fase 5 — Telemetria de Latência Ponta-a-Ponta (`trace` / MetricsFrame)

**Objetivo:** visibilidade imediata do tempo gasto em cada etapa do pipeline durante uma call real, sem overhead perceptível.

#### Especificação do contrato `Envelope.meta.trace`
```ts
export interface TraceMeta {
  turnId: string;        // ex.: itemId do ASR ou uuid curto
  tCaptureMs?: number;   // epoch ms do último chunk de áudio que originou o turno
  tAsrFirstMs?: number;  // 1º delta do ASR
  tAsrFinalMs?: number;  // completed do ASR
  tTurnMs?: number;      // saída do turn.detector
  tLlmTtftMs?: number;   // 1º token do LLM
  tLlmFinalMs?: number;  // fechamento do LLM
  tDecisionMs?: number;  // saída do decision.llm
}
```

#### Arquivos afetados
1. `packages/falador-nodes/src/trace.ts` (helper mínimo ~25 linhas)
   - `inheritTrace(msg: Envelope, patch: Partial<TraceMeta>): { trace: TraceMeta }` — preserva o `trace` recebido e acrescenta o carimbo do nó atual.
2. Nós (`asr-realtime.ts`, `turn-detector.ts`, `llm-omlx.ts`, `decision-llm.ts`, `sinks.ts`)
   - Cada nó propaga `meta: { ...msg.meta, ...inheritTrace(msg, { ... }) }` ao chamar `ctx.emit(...)`.
   - `sink.captions` inclui `trace` no payload emitido ao callback (`__onCaption`), que o runner serializa no evento NDJSON `{"type":"caption", ..., "trace": {...}}`.
3. `apps/web/src/useRunner.ts` e `apps/web/src/views/LiveView.tsx`
   - Calcular deltas legíveis do último turno:
     - `ASR` (`tAsrFinalMs - tAsrFirstMs`)
     - `Turn` (`tTurnMs - tAsrFinalMs`, se presente)
     - `LLM TTFT` (`tLlmTtftMs - (tTurnMs ?? tAsrFinalMs)`)
     - `Decisão d1` (`tDecisionMs - tLlmFinalMs`)
     - `Total` (`(tDecisionMs ?? tLlmTtftMs) - tAsrFinalMs`)
   - Exibir o total no pill de Latência e o breakdown por etapa num tooltip/popover Carbon (`Toggletip` ou `Tooltip`) ao passar o mouse/clicar.

#### Verificação da Fase 5
- Teste unitário: pipeline `asr -> turn.detector -> llm.omlx -> decision.llm -> sink.captions` produz `trace` completo com todos os carimbos monotônicos (`tAsrFirstMs <= tAsrFinalMs <= tTurnMs <= tLlmTtftMs <= tDecisionMs`).
- Verificação visual no browser: pill de Latência mostra breakdown real em ms.

---

### Fase 6 — Exportação & Webhook Pós-Sessão (Padrão n8n)

**Objetivo:** fechar o ciclo pós-reunião/entrevista sem misturar automação pesada no pipeline de tempo real.

#### Arquivos afetados
1. `apps/web-server.mjs`
   - Manter buffer leve da sessão atual em memória (resetado a cada `/api/run`):
     - `startedAt`, `endedAt`, `flowName`, `captions[]` (classificadas em transcrição vs sugestão), `approved[]`, `topics[]`, `latencySummary` (p50/p95 por etapa).
   - Novo endpoint `POST /api/session/export`:
     - Body: `{ saveMarkdown?: boolean, webhookUrl?: string }`
     - **Markdown local:** grava em `sessions/YYYY-MM-DD_HH-mm-<flow>.md` (cria pasta `sessions/`, adicionada ao `.gitignore` para não vazar entrevistas privadas no git!).
     - **Webhook (opt-in):** se `webhookUrl` (ou `FALADOR_WEBHOOK_URL`) estiver definido e explicitamente acionado, envia `POST` JSON com timeout de 5 s (sem travar a UI). Retorna `{ ok, markdownPath?, webhookStatus? }`.
2. `apps/web/src/views/LiveView.tsx` (e `api.ts`)
   - Ao encerrar a sessão (ou via botão `"Exportar sessão"` no topo quando houver transcrição), oferecer:
     - Salvar resumo `.md` local (1 clique);
     - Enviar para Webhook (campo URL persistido em `localStorage`, vazio por padrão).

#### Verificação da Fase 6
- Teste automatizado em `apps/web-server.mjs`:
  - `POST /api/session/export` com `saveMarkdown: true` cria arquivo `.md` válido e retorna o caminho.
  - `POST /api/session/export` apontando para servidor HTTP mock local recebe o JSON completo com `Content-Type: application/json`.
  - Confirmar que `sessions/` está no `.gitignore`.

---

## 4. Ordem de Execução Recomendada e Estimativa de Esforço

| Ordem | Fase | Risco | Ganho percebido na call | Dependência |
|---|---|---|---|---|
| 1º | **Fase 1** (Bugfix `historyMax` + `drop_oldest` + `maxPendingMs`) | Baixo | Alto (elimina bug silencioso e *latency drift*) | Nenhuma |
| 2º | **Fase 2** (*Barge-in* / `interrupt` no grafo) | Médio | Muito alto (corta resposta obsoleta na hora) | Nenhuma |
| 3º | **Fase 3** (`turn.detector` com `d1-2B`) | Médio | Muito alto (fim de cortes no meio da pergunta) | `d1-2B-MLX-4bit` no `omlx` (já instalado) |
| 4º | **Fase 4** (Reset de contexto + `historyCharBudget`) | Baixo | Alto (follow-ups limpos por tema) | Fase 1 |
| 5º | **Fase 5** (Telemetria `trace` ponta-a-ponta) | Baixo | Médio-alto (observabilidade real em ms) | Fases 2–3 (opcional, funciona incrementalmente) |
| 6º | **Fase 6** (Exportação `.md` + Webhook pós-sessão) | Baixo | Médio (integração limpa com n8n/Notion pós-call) | Nenhuma |

---

## 5. Riscos, Armadilhas e Mitigações

| Risco | Mitigação |
|---|---|
| **Falso positivo de *barge-in*** (tosse, ruído, "uh-huh" cancelando uma ótima sugestão) | `emitInterruptOnSpeech` opt-in por fluxo + `bargeInDebounceMs` (default 300 ms) + nunca apagar da tela a última sugestão completa antes da nova começar a chegar. |
| **Latência extra do `turn.detector`** | Fast-path de pontuação `?` (0 ms); `d1-2B` warm mede ~40 ms; timeout duro de 300 ms no `fetch` do `d1` com fallback para `maxWaitMs`. |
| **Contenção de memória/GPU durante testes** (lição documentada em `AGENTS.md` §4) | Todos os testes unitários das Fases 1–6 usam mocks HTTP/WS em memória; testes E2E com mídia real rodam sequencialmente usando apenas os serviços residentes (`faladorctl status`). |
| **Vazamento de dados privados de entrevista** | `sessions/` adicionado ao `.gitignore`; webhook é estritamente opt-in (nunca dispara automaticamente sem URL configurada pelo usuário). |
| **Quebra de Node 26 type-stripping** (lição em `AGENTS.md` §4) | Proibido usar parameter properties (`constructor(public x)`) ou enums TS; apenas sintaxe erasável e `import type`. |

---

## 6. Critérios de Aceite (para marcar ADR-006 como ACEITO/IMPLEMENTADO)

1. `node --test --test-force-exit` verde em `packages/falador-graph` e `packages/falador-nodes` cobrindo todas as 6 fases.
2. `tsc --noEmit` e `vite build` verdes em `apps/web`.
3. Todos os 5 fluxos de `apps/tui/flows/` validados por `validateFlow` sem erro.
4. **Prova E2E ao vivo (SCK + mídia real, M4 Pro):**
   - Latência adicional do `turn.detector` medida <= 50 ms p50 (warm).
   - Interrupção durante geração do LLM aborta o turno anterior sem emitir `final: true` nem contaminar o histórico.
   - `LiveView` exibe breakdown real de latência por etapa e exporta sessão `.md` com sucesso.
5. `AGENTS.md` atualizado com os números medidos (frio vs quente separados — L2).
