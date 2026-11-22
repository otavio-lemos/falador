# Testes do Falador — guia e estado medido

> Última medição: **2026-11-21**, Node **v26.13.1**, MacBook Pro M4 Pro. Todo número aqui foi medido no repo; nada estimado.
> Regra de ouro: teste que passa sem provar comportamento é pior que teste ausente — ele mente.

## 1. Por que a suíte é assim

O sistema é um grafo assíncrono com áudio em tempo real, chamadas HTTP/WS e processos externos. Testar tudo por E2E seria lento e instável; testar tudo com mocks não provaria nada sobre o motor. A pirâmide adotada:

```
        E2E / Playwright            (poucos, caros, exigem serviços)
      ────────────────────────
      integração com fakes        (host HTTP, runner, WS/SSE, sidecars fake)
    ──────────────────────────
    contrato / propriedades       (matriz de validação, fuzz determinístico)
  ────────────────────────────
  unitários de nó e de motor     (rápidos, sem rede, sem modelo)
```

Duas regras derivadas de falhas reais do projeto:

1. **Não carregar modelo em teste junto de E2E de áudio** — contenção de GPU/memória unificada já produziu "silêncio transitório" no pipeline (AGENTS.md §6).
2. **Isolar antes de acusar o protocolo** — um bug do motor foi encontrado só depois de um cliente WS standalone mínimo funcionar perfeitamente (AGENTS.md §4).

## 2. Comandos (exatos)

```bash
# motor — rápido, zero deps, sem rede
cd packages/falador-graph && node --test test/

# nós — force-exit é OBRIGATÓRIO (sockets keep-alive do undici seguram o processo)
cd packages/falador-nodes && node --test --test-force-exit test/

# host HTTP
node --test apps/web-server.test.mjs

# microfone real (gate; sem a env o teste é skip)
FALADOR_MIC_TEST=1 node --test --test-force-exit packages/falador-nodes/test/nodes.test.ts

# cobertura (experimental, nativa do Node 26)
cd packages/falador-graph && node --test --experimental-test-coverage --test-coverage-include='src/**' test/
cd packages/falador-nodes && node --test --test-force-exit --experimental-test-coverage --test-coverage-include='src/**' test/

# UI: typecheck + build + E2E (Playwright precisa do host em :8787)
cd apps/web && npx tsc --noEmit && npm run build
cd apps/web && npx playwright test
```

## 3. Estado medido (2026-11-21)

| Suíte | Testes | Pass | Skip | Cobertura linhas | branches | funções |
|---|---|---|---|---|---|---|
| `falador-graph` | 41 | 41 | 0 | **94,42%** | **89,18%** | 88,43% |
| `falador-nodes` | 141 | 139 | 2 (N7 mic + gate) | **86,55%** | **70,81%** | 84,88% |
| `apps/web-server.test.mjs` + `web-server.routes.test.mjs` | 14 | 14 | 0 | não medido | — | — |
| `packages/falador-cli` (`run-flow.test.mjs`) | 9 | 9 | 0 | não medido | — | — |
| Playwright (`ui-smoke.spec.ts`) | 4 | 4 | 0 | — | — | — |

Evolução desde o baseline de 2026-11-21 (antes desta rodada):

| Pacote | Antes | Depois |
|---|---|---|
| `falador-graph` | 23 testes · 92,69 / 83,38 / 87,60 | **41 testes · 94,42 / 89,18 / 88,43** |
| `falador-nodes` | 84 testes · 83,46 / 63,85 / 82,02 | **141 testes · 86,55 / 70,81 / 84,88** |

Maiores saltos por arquivo (nós): `sinks.ts` 53,13% → **97,32%**; `capture-ffmpeg.ts` 78,05% → **96,34%**; `asr-lfm3.ts` → 96,77%; `llm-omlx.ts` → 96,15%; `decision-llm.ts` → 99,33%. `spec.ts` do motor chegou a **100% de linhas / 97,71% de branches**.

## 4. O que cada suíte prova

### `packages/falador-graph`

| Arquivo | Prova |
|---|---|
| `engine.test.ts` | Critérios C1–C9 da spec: ordem, `drop_oldest` vs `block`, TTL, cancel por seq, drain reverso idempotente, parada natural |
| `enabled.test.ts` | Nó desabilitado sai do grafo com suas edges |
| `interrupt.test.ts` | `interrupt`/barge-in propaga BFS, sem duplicar em diamante, descarta filas de texto, isola erro em `onControl` |
| `tools-port.test.ts` | Porta `tool` aceita in-degree > 1 sem criar ciclo; `ctx.getTools` |
| `validation-matrix.test.ts` | **Todos** os códigos de erro (V0–V7) com code/path/message; defaults de aresta; exceção da porta `tool`; `outputsFor` dinâmico |
| `fuzz-graph.test.ts` | 400 specs mutados com PRNG de semente fixa: só `GraphError`, invariantes de topo/arestas, idempotência; 12 pipelines aleatórios entregam tudo em ordem |

### `packages/falador-nodes`

| Arquivo | Prova |
|---|---|
| `nodes.test.ts` | N1–N11: LLM SSE, TTS, ASR realtime, captura, sinks, gate, decisão (incl. d1 ao vivo quando há serviço) |
| `streaming.test.ts` | S1–S9: anti-drift, `maxPendingMs`, barge-in debounce, `turn.detector`, `trace` monotônica |
| `translate-and-approve.test.ts` | `translate.llm`, `human.approve` auto/manual, `asr.lfm3` por idioma |
| `asr-and-llm-paths.test.ts` | Caminhos de erro/reconexão do ASR e do `llm.omlx` (SSE quebrado, abort, histórico) |
| `decision-turn-translate.test.ts` | `decision.llm` (chat e systemone), `turn.detector`, `translate.llm`, `asr.lfm3` |
| `sinks-and-capture.test.ts` | `sink.captions` com stdout mockado, `sink.playback` com player inofensivo, backends de captura |
| `rag-exec.test.ts` | RAG BM25 + `exec.command` com validador anti-injeção e denylist |
| `agent-tools.test.ts` / `workflow-agent.test.ts` | Loop de `tool_calls`, gate fail-closed, limites de passo, `tool.workflow` |
| `tools-mcp.test.ts` / `crawler.test.ts` | JSON-RPC/stdio/HTTP, anti-SSRF, limites de crawl |
| `input-chat.test.ts` / `capture-cleanup.test.ts` | Fonte de chat e limpeza de processos de captura |

### Host, CLI e UI

- `apps/web-server.test.mjs`: RAG/contexto, export `.md`, reset-history, 409/parada por desconexão SSE, `/api/logs`, `/api/stop`+`/api/run`.
- `apps/web-server.routes.test.mjs`: catálogo (23 nós), CRUD de flows com rename, path traversal em POST/GET/DELETE, JSON inválido = 400, `/api/models` sem omlx, `/api/apps`, allowlist/clamp de logs, gate/chat/stop sem run, 404 JSON para `/api/*` desconhecida.
- `packages/falador-cli/test/run-flow.test.mjs`: catálogo, NDJSON puro, summary/ordem/truncamento, flow inválido, exit codes, `--run-seconds`, stdin (`reset_history`/`chat_input`) e SIGTERM < 3 s.
- `apps/web/tests/ui-smoke.spec.ts`: 4 testes de fumaça no Chromium; o `webServer` do Playwright sobe o host (reaproveita um já ativo fora de CI).

## 5. Técnicas usadas (e por quê)

- **`node:test` nativo** (Node 26, estável) — zero dependências, `--test-force-exit`, `--experimental-test-coverage`, `mock.timers`, `test.skip` com motivo.
- **Fakes em vez de rede**: `__fetcher`, `__gate`, `__registerChatInput`, `__collect`, `player` inofensivo, `__collect` para sinks. Bindings são o ponto de injeção oficial do motor — testes não precisam de patch de módulo.
- **Fuzz com PRNG semeado** (`mulberry32`): falha reproduzível; o teste exige que a validação cubra ≥ 5 códigos de erro, senão acusa fuzz inútil.
- **`structuredClone` para mutar specs** sem alterar a fixture base (exceto `Symbol`, que não clona — usar `bigint` quando precisar de tipo exótico).
- **Cobertura com `--test-coverage-include='src/**'`** para não contar testes/fixtures no denominador.

## 6. Lacunas conscientes

| Lacuna | Por quê | Como fechar |
|---|---|---|
| ~~`validateFlow` aceita `ttlMs: NaN`~~ | **CORRIGIDO 2026-11-21**: `Number.isFinite` no check de TTL | Coberto em `validation-matrix.test.ts` (`INVALID_TTL` para NaN/±Infinity) |
| ~~`edge.from`/`to` não-string → `TypeError`~~ | **CORRIGIDO 2026-11-21**: checagem de `typeof` antes do `split`, inclusive no filtro de nós desabilitados | Coberto em `validation-matrix.test.ts` e `fuzz-graph.test.ts` (`INVALID_EDGE_REF`) |
| ~~Host HTTP com 5 testes~~ | **RESOLVIDO 2026-11-21**: 14 testes (rotas + adversariais) | `web-server.routes.test.mjs` |
| ~~Runner CLI sem teste~~ | **RESOLVIDO 2026-11-21**: 9 testes de contrato | `packages/falador-cli/test/run-flow.test.mjs` |
| ~~Playwright sem `webServer`~~ | **RESOLVIDO 2026-11-21**: E2E sobe o host sozinho | `playwright.config.ts` |
| Sidecars Python não testados aqui | Worktree sem `.venv` | Rodar no checkout principal (`~/ml/falador`) ou CI com venv |
| `faladorctl` sem teste | Shell de operação | Teste de `status`/`stop` com portas fake |

## 7. Antes de commitar

```bash
(cd packages/falador-graph && node --test test/) || exit 1
(cd packages/falador-nodes && node --test --test-force-exit test/) || exit 1
node --test apps/web-server.test.mjs || exit 1
(cd apps/web && npx tsc --noEmit && npm run build) || exit 1
# só com o host no ar:
(cd apps/web && npx playwright test) || exit 1
```

Suítes verdes não provam comportamento novo: se o diff muda um nó, o teste correspondente precisa falhar antes da correção e passar depois.
