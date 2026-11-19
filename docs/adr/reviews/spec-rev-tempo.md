# Revisão adversarial da Spec falador-graph v1.0 — revisor "tempo real & backpressure"

## FALHAS BLOQUEANTES

**B1 — `emit(): void` com fila `block` é incapaz de aplicar backpressure sem congelar o event loop.** `emit` é síncrono (§4), mas a política `block` (§5) exige *esperar* espaço na fila. Em Node single-thread, uma fila sincronamente bloqueante inevitavelmente trava o loop, torna o nó incapaz de processar `stop()`/cancelamento (freeze). `emit` precisa ser async (`await emit(...)`), mudando a assinatura do contrato.

**B2 — Deadlock circular não tratado.** Cadeia `mic → asr` (drop_oldest) e `asr → trad` (block): se `trad` está lento (LLM), sua fila enche, `asr` bloqueia no emit — exatamente quando precisaria emitir supersession. Sem detecção de deadlock/timeout/bloqueio interrompível.

**B3 — `seq` é por porta de saída, mas `isCancelled(seq)`/`uptoSeq` são por nó.** Com fan-out, `isCancelled(5)` é ambíguo. Precisa de `(port, seq)` ou seq global do run.

## AMBIGUIDADES

- **A1** — Semântica de TTL (check no enqueue ou dequeue? interação com drop_oldest; tokens_parcial sobre `block` sem mecanismo).
- **A2** — Relógio virtual vs real misturados; não há conceito de tick/timer no NodeCtx.
- **A3** — Cancelamento "entregue com flag OU não entregue" — onde se registra a política? tokens_parcial: cumulativo ou delta? Sem contrato, tradução sai inconsistente.
- **A4** — Drain no stop() com filas block: contradiz "phrase: nada se perde".

## MENORIAS

- `emit` deveria retornar `seq` (não adivinhar via isCancelled).
- `edge_overflow` sob storm pode inundar o log de eventos (sem coalescing).
- p95 de rota sobre sobreviventes de drop_oldest = survivor bias; SLO <500ms não-verificável sem contadores de drop.

## Veredito

B1–B3 reais e bloqueantes; resolver emit async e escopo de seq antes da implementação.

*→ Incorporado na Spec v1.1 (emit async + `{seq}`, `isCancelled(port, seq)`, `blockTimeoutMs`, TTL em enqueue+dequeue, tokens_parcial cumulativo, survivor bias documentado, drain com perda contada como último recurso).*
