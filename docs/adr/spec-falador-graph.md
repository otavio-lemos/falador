# Spec — Motor de Grafo `falador-graph` v1.1

**Status:** ACEITA para implementação — incorpara as 3 revisões adversariais (tempo real, API, validação); changelog na §11.
**Base:** ADR-003 W1 (motor headless TS), ADR-004 E2 (contrato `StreamingSession`), simulação de eventos F0 (1ª legenda parcial ~370–450 ms; LLM no meio não é gargalo).
**Runtime:** Node ≥ 26, ESM, TypeScript com type-stripping nativo (sem build step), **zero dependências** no núcleo.

---

## 1. Propósito

Motor headless que executa um grafo acíclico (DAG) de nós de processamento de áudio/texto em tempo real. O canvas (React Flow, fase 2) e a TUI (Textual, fase 1) são **apenas views**; o fluxo salvo em YAML/JSON é a fonte da verdade.

Não faz: UI, rede, acesso a devices, chamadas a modelos. **Adaptadores de nós** (ASR, TTS, omlx, captura) são pacotes separados que se registram no motor — o motor conhece apenas as portas.

## 2. Conceitos

| Conceito | Definição |
|---|---|
| **Porta** | Ponto tipado de entrada/saída de um nó, **declarado no tipo de nó** (`NodeTypeDef.inputs/outputs: {name, type, required?}`) — o motor não adivinha portas (rev-validação B1). |
| **Tipo de porta** | `pcm16k` (Float32 frames 16 kHz) · `pcm48k` · `audio_chunk` (codec, ex. slots LFM) · `tokens_parcial` (streaming de texto **cumulativo** — payload `{ text: string, final?: boolean }`; cada snapshot substitui o anterior, ver rev-tempo A3) · `phrase` (texto final) · `control`. |
| **Mensagem** | Envelope `{ seq, ts, ttl?, meta?, payload, cancelled? }`. `seq` é monotônico **por porta de saída**. `ttl` (ms, opcional) expira no **enqueue e no dequeue** (rev-tempo A1). `seq/ts/t_run` são injetados pelo motor, nunca pelo nó. |
| **Edge** | Conexão `nó.porta → nó.porta`. Referência é sempre `"<nodeId>.<portName>"`; **nodeId não pode conter `.`** (charset `[A-Za-z0-9_-]+`). Fila limitada + política de overflow + `blockTimeoutMs` opcional (v1.1). |
| **Nó** | Tipo registrado no registry + instância no grafo com `params` e `bindings`. |
| **Binding de run** | Escolha concreta de modelo/dispositivoidioma por nó no momento do Run (ADR-003 W8/W9), persistida na seção `bindings:` do YAML. |
| **Run** | Uma execução do grafo: instancia runtimes, conecta edges, roda até `stop()` ou fonte esgotar. |

## 3. Especificação de fluxo (JSON; YAML é aceito se parseado fora do motor)

```jsonc
{
  "version": 1,
  "nodes": [
    { "id": "mic", "type": "capture.mic", "params": { "device": "BlackHole 2ch" } },
    { "id": "asr", "type": "asr.lfm3", "params": {} },
    { "id": "trad", "type": "translate.llm", "params": { "prompt": "traduz EN->PT" } },
    { "id": "cap", "type": "sink.captions", "params": {} }
  ],
  "edges": [
    { "from": "mic.out",    "to": "asr.audio",  "capacity": 64,  "overflow": "drop_oldest" },
    { "from": "asr.parcs",  "to": "trad.parcs", "capacity": 32,  "overflow": "block", "ttlMs": 2000 },
    { "from": "trad.phrase","to": "cap.phrase", "capacity": 32,  "overflow": "block" }
  ],
  "bindings": {
    "asr":  { "model": "LFM3-Audio-2B-MLX-8bit", "lang": "en" },
    "trad": { "model": "LFM3-1.7B-MLX-4bit", "lang_src": "en", "lang_tgt": "pt-BR" }
  },
  // opcional: run termina sozinho quando fontes esgotam e filas drenam (testes/batch)
  "stopWhenSourcesDone": false
}
```

Regras de validação (erro na montagem com `{code, path, message}`, nunca em runtime):
- V0 `id` de nó único; charset `[A-Za-z0-9_-]+` (sem `.`); `version` só `1` suportado (senão `SPEC_VERSION_UNSUPPORTED`).
- V1 `capacity` inteiro ∈ [1, 4096]; `overflow` ∈ {`drop_oldest`, `drop_newest`, `block`}; `ttlMs` ≥ 0; `blockTimeoutMs` > 0 (opcional, default 30000); `capacity: "64"` (string) = erro — sem coerção.
- V2 porta de entrada recebe **no máximo 1** edge (merge é nó explícito `merge.*`, futuro). Fan-out de saída livre (fila própria por edge).
- V3 grafo **é DAG** (ordenação de Kahn; erro `CYCLE` com caminho do ciclo na mensagem).
- V4 tipo/direção: `from` deve ser porta de **saída** do nó de origem e `to` porta de **entrada** do destino, ambas **existentes na declaração do tipo** (senão `UNKNOWN_NODE`/`UNKNOWN_PORT`), e tipos iguais (senão `PORT_TYPE_MISMATCH`).
- V5 todo `type` registrado no registry; params validados pela função do tipo; **param desconhecido = erro** (estrito); erros no formato `{path, code, message}`.
- V6 nó sem edge de entrada deve declarar `sourceOnly` (ou ser `sink`); nó `sink` tem `outputs: []`; porta de saída declarada sem nenhuma edge = erro se `required !== false` (fluxo morto não passa silencioso).
- V7 `bindings` só referencia nós existentes e com campos conhecidos; campos `requiredBindings` do tipo ausentes = erro.

**Controle (`emitControl`) viaja pelas MESMAS edges conectadas à porta de saída de origem**, marcando em fila as mensagens (`seq <= uptoSeq`) como `cancelled` imediatamente ao emitir (não espera a frente chegar). `emitControl` para porta sem edge = drop silencioso + contador `control_dropped` (frequente com isolate — decisão rev-api). Cancelamento de run inteiro: API `RunningGraph.cancelByNode(nodeId, uptoSeqByPort?)` atua sobre todas as edges do nó sem depender de grafo (rev-tempo B3/A).

## 4. API do motor

```ts
interface NodeRuntime {
  start(ctx: NodeCtx): Promise<void>;                 // uma vez por Run, em ordem topológica
  onInput(port: string, msg: Envelope): Promise<void>;// sequential por nó (lock do motor, não concorrente)
  stop(reason: string): Promise<void>;                // drain + cleanup; idempotente
  onControl?(c: ControlMsg): void;                    // control entregue pela edge; default: motor registra cancelled
}
interface NodeCtx {
  id: string;
  params: Record<string, unknown>;       // instância (validados V5)
  bindings: Record<string, unknown>;
  /** ASYNC (rev B1): await espace/resolução; retorna { seq } emitido. */
  emit(port: string, payload: unknown, opts?): Promise<{ seq: number }>;
  emitControl(port: string, c: ControlMsg): void;     // sincrônico, sem esperar espaço
  isCancelled(port: string, seq: number): boolean;    // escopo: porta (rev-tempo B3)
  metrics: MetricsSink;                               // counters + timers por nó/porta
  log: (level, msg) => void;
  signal: AbortSignal;                                // abortado no stop() do Run
}
```

**Semântica de ciclo de vida (rev-api B2/A):**
- erro em `start()` → `node_error` + política `onError` do tipo; `stop()` do runtime **só é chamado se start() resolveu**; se `RunningGraph.stop()` chega com `start()` pendente, o motor aguarda ele com race de abort e chama `stop()` **exatamente uma vez** depois que assentar (nunca `stop` antes de `start` completar).
- `emit()` durante a fase de **drain do stop** é permitido (nó em processamento termina de re-emitir; edges já fechadas engolem com `EDGE_CLOSED`); após `run_stopped` → **throw `GraphError('RUN_STOPPED')`** (determinístico, rev-api); emit em porta inexistente do nó → throw `GraphError('UNKNOWN_PORT')`.
- `RunningGraph.stop()` é idempotente: segunda chamada devolve a MESMA promise.
- Eventos: log **unbounded** + AsyncIterable; `stop()` só resolve **depois** de enfileirar `run_stopped` no canal (rev-api).
- Recusa de emit bloqueado: quando edge fecha (isolate/stop/drain timeout), os awaiters recebem rejeição `EDGE_CLOSED` (rev-tempo B2/B: bloqueio é interrompível por cancel/stop — nunca freeze).

- `runGraph(spec, registry, opts?)` → `RunningGraph`:
  - `events`: AsyncIterable de eventos de ciclo de vida (`node_started`, `node_stopped`, `node_error`, `edge_overflow`, `run_stopped`) + métricas periódicas.
  - `stop(reason)`: aborta signal, drena filas (respeitando overflow), chama `stop()` de cada runtime em ordem reversa topológica; timeout de drain (`drainTimeoutMs`, default 2000).
  - `snapshot()`: métricas atuais (fila por edge, msgs in/out/dropped por nó, tempo de processamento p50/p95 por nó — janela deslizante de 256 amostras por nó).
- Erros: erro em `onInput` → evento `node_error`; política default: nó entra em `errored`, edge é isolada, run continua (política `onError: 'isolate' | 'stop_run'` por nó, default `isolate`).

## 5. Backpressure, tempo real e cancelamento

- Cada edge é uma fila de capacidade fixa (`capacity`). Overflows seguem a política (V1).
- Padrões para as portas do Falador:
  - áudio (`pcm16k`/`pcm48k`/`audio_chunk`): `overflow: drop_oldest` **+ `ttlMs` 300** (frame velho não interessa; latência > qualidade).
  - `tokens_parcial`: `overflow: block` + `ttlMs` 2000 (cumulativo — pular snapshot vencido não abre buraco).
  - `phrase`: `block` (nada se perde sem evento; se `drainTimeoutMs` cortar, perda é contada+eventuada como `edge_closed` — último recurso, rev-tempo A4).
- `emit` async aplica backpressure real: com `block`, o produtor **awaita** até espaço (rev B1 — os dois revisores apontaram que emit sync é inimplementável). Com `blockTimeoutMs` vencido: mensagem descartada + `edge_overflow` (anti-deadlock, rev-tempo B2; em DAG com sink vivo isso não ocorre).
- `onInput` é **sequencial por nó** (lock por instância). **Não há interrupção de onInput em curso** (rev-api B3): o processamento de uma seq é cooperativo — nó longos (ASR/LLM) checam `ctx.isCancelled(port, seq)` nos seus pontos de await; cancelamento de mensagens na fila é feito pelo motor (flag `cancelled`), entrega é **sempre com flag** (decisão v1.1, rev-tempo A3: critério determinístico).
- TTL: checado no **enqueue** (antes de aplicar overflow) e no **dequeue**; vencidas = não entregues + `edge_expired` + contador (rev-tempo A1).
- **Supersession**: nós de geração incremental guardam `latestSeq = (await emit(...)).seq` (emit retorna seq — rev-tempo menoria) e checam `isCancelled` cooperativamente.
- Relógio: `clock` injetável usado SOMENTE para ttl/métricas dentro do motor; jitter buffer de playback é responsabilidade do adaptador (fora do motor) — rev-tempo A2.
- Limitação documentada: métricas de latência medem apenas mensagens **entregues** (survivor bias sob drop_oldest); contadores de drop/expired compõem o diagnóstico (rev-tempo menoria).

## 6. Contrato com mlx-audio (ADR-004 E2) — adaptador de áudio

O runtime de áudio do usuário (TTS/ASR) envolve a `StreamingSession` do mlx-audio:
- `session.feed(pcm)` ← mensagens `pcm16k/48k` recebidas; `session.step()` no tick do nó; `session.close()` + `done` no `stop()`.
- Saída de TTS em `audio_chunk` (slots de 80 ms) com `seq` crescente; nó `sink.playback` decodifica (LiquidCodec RTF 0,002) e escreve no device — manter fila curta de jitter (200 ms), drop_oldest.
- `input_sample_rate` da session define se há converter antes de `feed` (resampler mínimo no adaptador).

## 7. Determinismo e testabilidade

- Relógio injetável (`clock: { now(): number }`) — métricas e `ttl` usam o clock do Run; testes usam clock virtual.
- Scheduler cooperativo: uma fila de tick por node; `await` nos pontos de fila. Teste com nós sintéticos (`source.tone`, `latencyInjector`, `sink.collect`) cobre: ordem de seq, backpressure (drop_oldest/block), TTL, cancel por seq#, DAG-erro, PORT_TYPE_MISMATCH, drain no stop.
- Latência end-to-end: cada mensagem carrega `meta.t_run` (timestamp de origem); o motor calcula p50/p95 por rota na saída do run (`snapshot()`).

## 8. Fora de escopo (v1)

Persistência de estado entre runs, retrês/checkpoint, execução distribuída, paralelismo dentro do nó, canvas, TUI, protocolo de rede entre processos. (Placement: um processo,uma instância por Run.)

## 9. Estrutura de arquivos

```
packages/falador-graph/
  package.json          (ESM, zero deps; scripts: test)
  tsconfig.json
  src/
    types.ts            (Envelope, ControlMsg, port types, NodeRuntime, NodeCtx)
    registry.ts         (registra/busca tipos de nó; valida params)
    spec.ts             (parse + validação V1..V7, DAG check)
    queue.ts            (bounded queue + políticas de overflow)
    runtime.ts          (runGraph, RunningGraph, scheduler, eventos, métricas)
    nodes/synthetic.ts  (source.tone, latencyInjector, sink.collect — p/ testes e W7)
  test/
    engine.test.ts      (suítes do §7)
```

## 10. Critérios de aceite da implementação

1. Pipeline sintético Cenário 1 (`source.tone → transform → sink.collect`) roda e entrega seq em ordem.
2. Backpressure drop_oldest descarta e emite `edge_overflow`; `block` nunca perde emite bloco e aplica backpressure em cascata.
3. `ttl` vencido = mensagem não entregue + contador.
4. Cancel por seq#: seq canceladas entregues com `cancelled: true` (ou não entregues) e `ctx.isCancelled` consistente.
5. Ciclo e mismatch de porta rejeitados na montagem com mensagem contendo ids dos nós.
6. `stop()` drena (ordem reversa topológica) dentro de `drainTimeoutMs` e é idempotente.
7. Métricas: snapshot com contadores e p50/p95 verificáveis num run determinístico.
8. Zero dependências externas; testes rodam com `node --test` (nativo).
9. Eventos incluem `run_started` antes de qualquer `node_started`.

## 11. Changelog v1.1 (revisões adversariais incorporadas)

- **emit é async/awaitable e retorna `{seq}`** (B1 rev-tempo + rev-api; backpressure `block` real e interrompível por EDGE_CLOSED).
- **Anti-deadlock**: `blockTimeoutMs` por edge; lock por nó; DAG documentado como pré-condição (B2 rev-tempo, B1 rev-validação).
- **Cancel por seq com escopo de PORTA**: `isCancelled(port, seq)`; entrega sempre com flag `cancelled` (sem "ou"); control marca filas imediatamente ao emitir; `RunningGraph.cancelByNode` para cancel fora do grafo (B3 de ambos revs).
- **Ciclo de vida de start() definido** (erro tratado como node_error; stop() uma única vez; stop() com start() pendente = race com abort) (B2 rev-api).
- **Valores explícitos**: emit pós-stop = throw RUN_STOPPED; emitControl sem destino = drop + contador; TTL checado no enqueue E no dequeue; stop() idempotente devolve a mesma promise; log de eventos unbounded, stop() resolve após enfileirar run_stopped (rev-api).
- **tokens_parcial é cumulativo** `{text, final?}` (rev-tempo A3).
- **Validação ampliada**: V0 (id único/charset/versão), V1 sem coerção, V4 com existência de porta e direção, V6 com `sink`/`sourceOnly` e porta de saída morta, V7 com `requiredBindings`; erros `{path, code, message}` (rev-validação B1/B2/A, A3/A4/A5).
- **Versionamento**: só `version: 1`; unsupported = erro nomeado (rev-validação A2).
- Métricas: limitação de survivor bias documentada (rev-tempo menoria).
