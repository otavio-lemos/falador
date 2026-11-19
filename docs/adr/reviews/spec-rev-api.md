# Revisão adversarial da Spec falador-graph v1.0 — revisor "API & ciclo de vida"

## FALHAS BLOQUEANTES

**B1 — `overflow: 'block'` é inimplementável com `emit(): void` síncrono.** Backpressure por bloqueio exige produtor aguardando espaço; emit precisa ser awaitable, ou `block` redefinido. Critério 10.2 não implementável como escrito.

**B2 — Erro (ou pendência) em `start()` sem semântica.** `start()` rejeitando: vira node_error com qual política? isolate em nó que nunca iniciou é incoerente. `stop()` durante `start()` pendente → ordem `stop → start` viola "uma vez por Run".

**B3 — Cancelamento "em curso" contradiz o modelo sequencial.** `uptoSeq` ("processamento em curso") não é coberto pelo modelo; única saída é verificação cooperativa (`ctx.isCancelled`/AbortSignal) — os dois mecanismos se sobrepõem e a spec os trata como distintos.

## AMBIGUIDADES

- Cancel em voo vs enfileirado: control viaja pela mesma edge? Quem descarta os já enfileirados?
- `emitControl` para porta sem destino/edge isolada: drop, erro ou evento?
- `scope: 'node'` + `uptoSeq`: seq de qual porta quando há fan-out?
- `signal` vs drain: nós que escutam signal podem abortar antes do drainTimeoutMs.
- Eventos: attach após runGraph perder `run_started`? log bounded? stop resolve antes/depois de run_stopped?
- `stop()` idempotente: no-op, mesma promise ou rejeita? emitir durante stop/drain?
- TTL: vencimento no enqueue ou dequeue? Interação com drop_oldest.

## MENORIAS

- Direção das portas não declarada em lugar nenhum do registro de tipo.
- Quem injeta `seq/ts/t_run` (motor) — implícito.
- Emit em porta inexistente: erro de montagem seria melhor que silêncio.

## Veredito

Não vai a implementação sem resolver B1–B3.

*→ Incorporado na Spec v1.1 (emit async, ciclo de start() definido, cancel cooperativo documentado, control marca filas imediatamente, log unbounded com replay, stop idempotente = mesma promise, emit pós-stop = throw com exceção do drain).*
