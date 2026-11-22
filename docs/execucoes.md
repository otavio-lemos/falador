# docs/execucoes.md — Trilha de execução, terminais e logs

> Como uma execução (run) do Falador funciona de ponta a ponta, onde a saída aparece (terminal vs UI), onde ficam os logs e como exportar uma sessão. Nada de segredo: tudo local em `127.0.0.1`.
>
> Relacionado: [`servidores.md`](servidores.md) · [`run.md`](../run.md) · [`docs/adr/ADR-006-padroes-streaming-tempo-real.md`](adr/ADR-006-padroes-streaming-tempo-real.md) · [`docs/adr/ADR-007-rag-runbooks-conector-exec.md`](adr/ADR-007-rag-runbooks-conector-exec.md).

## 1. O que é um "run"

Um run é a execução de um flow (grafo de nós) pelo runner oficial `packages/falador-cli/run-flow.mjs`. Ele pode ser disparado de três lugares, mas **sempre** pelo mesmo runner:

1. **UI web** (`http://127.0.0.1:8787`) — `POST /api/run` com `{ flow, flowName?, runSeconds? }`. O host spawn o runner e retransmite os eventos como SSE.
2. **CLI headless** — `node packages/falador-cli/run-flow.mjs <flow.json> --run-seconds N`.
3. **Testes** — `node --test` com flows de fixture em `apps/tui/flows/test/`.

Um run tem: `runId`, `flowName`, eventos NDJSON (caption, gate, node_error, run_stopped, metrics, …), buffer de sessão (transcrições, sugestões, traces) e, ao final, um `summary`.

## 2. Terminais: onde a saída aparece

O nó `sink.captions` tem dois modos (`mode` param):

| Modo | Onde aparece | Quando usar |
|---|---|---|
| `stdout` | Terminal (linha parcial com `\r` + ANSI erase; final em linha nova) | Runner headless, debug no shell |
| `callback` | Eventos NDJSON `caption` → UI (LiveView) | Web (o host força `callback` automaticamente no runner) |

Regra de ouro (AGENTS.md): **nunca** misture `stdout` com NDJSON do host — o runner força `mode: 'callback'` para `sink.captions` quando roda sob o host, senão polui o stream de eventos.

Outros "terminais":

- **`sink.playback`** — reproduz WAVs via `afplay` (serializado, fila com descarte de excesso). Saída de áudio, não de texto.
- **Card de aprovação (`human.approve`)** — na UI (LiveView) ou via stdin no headless: `{"type":"gate_action","nodeId":"...","text":"editado ou null"}`. `text: null` = rejeição.
- **Logs dos serviços** — `logs/<nome>.log` (ver §4), visualizados no painel de logs da UI (Dropdown omlx/asr/tts/web + `<pre>` estilo terminal) ou via `GET /api/logs`.

## 3. Trilha de execução (eventos)

Eventos NDJSON emitidos pelo runner (consumidos pela UI como SSE):

| Evento | Significado |
|---|---|
| `caption` | Texto parcial/final de um sink (com `trace` ponta-a-ponta quando disponível) |
| `gate` | Pedido de aprovação humana (`human.approve`) com metadados (host, risco, comando) |
| `node_error` | Erro em nó (código + mensagem) |
| `flow_invalid` | Flow não passou em `validateFlow` |
| `edge_overflow` | Aresta excedeu capacidade/TTL (drop_oldest) |
| `run_stopped` | Run encerrou (fontes esgotadas ou timeout) |
| `metrics` | Snapshot de métricas por nó (a 1 Hz + no summary) |
| `chat_input` / `chat_sent` | Entrada de texto via `input.chat` / `POST /api/run/chat` |
| `interrupted` | Barge-in propagado (`interrupt`) |
| `summary` | Resumo final com payloads truncados + métricas agregadas |

Controle via stdin do runner:

- `{"type":"gate_action","nodeId":"...","text":"..."}` — aprova/edita/rejeita.
- `{"type":"reset_history","nodeId":"*"}` — limpa histórico conversacional do `llm.omlx`.
- `{"type":"chat_input","text":"..."}` — envia prompt ao `input.chat`.

## 4. Onde ficam os logs

Diretório base: `logs/` na raiz do repo (override via `FALADOR_LOGS_DIR`). Conteúdo:

| Arquivo | Quem grava | O que tem |
|---|---|---|
| `logs/omlx.log` | `faladorctl` (omlx) | stdout/stderr do servidor LLM :8080 |
| `logs/asr.log` | `faladorctl` (mlx-audio server) | stdout/stderr do ASR :8090 |
| `logs/tts.log` | `faladorctl` (sts-sidecar) | stdout/stderr do TTS/tradução :8091 |
| `logs/web.log` | host (`apps/web-server.mjs`) | `node_error`, `flow_invalid`, `edge_overflow`, `run_stopped`, stderr do runner, chamadas `/api/run` (400/409) |
| `logs/exec-audit.jsonl` | nó `exec.command` (+ `tool.mcp`, `tool.workflow`) | 1 linha JSON por chamada: `ts`, `runId`, `nodeId`, `transport`, `host`, `command`, `dryRun`, `decision` (allowed/dry_run/denied), `reason`, `exitCode`, `durationMs`, `timedOut` |

Diretórios irmãos (também gitignored):

| Diretório | Conteúdo |
|---|---|
| `sessions/` | Atas de sessão em Markdown (exportadas via `POST /api/session/export`), nome com timestamp + flowName |
| `context/` | RAG local: `context/docs.json` (índice de chunks BM25) + documentos indexados (`.md`/`.pdf`/`.txt`/`.yaml`/`.json`) |

Flows salvos: `apps/tui/flows/*.json` (override via `FALADOR_FLOWS_DIR`). Descrição e params ficam **dentro** do flow (um arquivo, uma verdade).

## 5. Como ler os logs

Via UI: painel de logs no rodapé do Live → Dropdown dos 4 serviços → `<pre>` estilo terminal. Endpoints:

- `GET /api/logs?name=<omlx|asr|tts|web>&lines=N` (1–2000, default 200) → `{ name, path, lines, total, truncated }`.
- `POST /api/logs/clear` com `{ names: [...] }` (ou sem body = todos) → zera os arquivos.

Via shell:

```bash
tail -f logs/web.log
tail -f logs/exec-audit.jsonl | jq .
cat sessions/*.md | head -100
```

## 6. Exportar uma sessão (ata)

`POST /api/session/export` com `{ saveMarkdown?, webhookUrl?, flowName?, useEnvWebhook? }`:

- `saveMarkdown !== false` → grava `sessions/<timestamp>-<flowName>.md` com transcrições, sugestões, traces e resumo de latência.
- `webhookUrl` (ou `useEnvWebhook: true` + env `FALADOR_WEBHOOK_URL`) → POST do snapshot JSON completo com timeout de 5 s (best-effort; falha não derruba o run).
- O buffer de sessão acumula durante o run (`sessionBuffer` no host) e é limpo/resetável.

## 7. Como um run termina

- **Parada natural:** quando todas as fontes esgotaram (`stopWhenSourcesDone: true`) **e** nenhum `onInput` está em voo (contador `inFlight` por nó). O runner emite `run_stopped` + `summary`.
- **Por tempo:** `--run-seconds N` agenda o stop após N segundos.
- **Manual:** `POST /api/stop` (UI) ou SIGINT/SIGTERM no processo do runner. Gates pendentes são resolvidos como rejeição (senão o run fica pendurado).
- **Idle stop (UI):** se o último cliente SSE desconecta, o host para o run após `FALADOR_RUN_IDLE_STOP_MS` (default 5 s); reconectar cancela o stop.
- **Importante (AGENTS.md):** o runner child não sai sozinho após `run_stopped` (keep-alive do undici). O host manda SIGKILL 300 ms pós-summary; se você rodar o runner direto, use `--test-force-exit`/Ctrl+C.

## 8. Métricas por nó (ao vivo)

O motor expõe `ctx.metrics.counter/timer` por nó; o runner emite evento `metrics` a 1 Hz e no `summary`. No canvas da UI aparecem badges `↓in ↑out ·p50ms` por nó, e o Inspector tem a seção "Métricas do run" (timers/counters nomeados, ex.: `llm.omlx.ttftMs`). Timers agregam `{count, last, avg, min, max}`.

## 9. Variáveis de ambiente relevantes

| Variável | Default | Efeito |
|---|---|---|
| `FALADOR_LOGS_DIR` | `<repo>/logs` | Onde ficam os logs |
| `FALADOR_SESSIONS_DIR` | `<repo>/sessions` | Onde vão as atas `.md` |
| `FALADOR_CONTEXT_DIR` | `<repo>/context` | RAG BM25 (docs indexados) |
| `FALADOR_FLOWS_DIR` | `<repo>/apps/tui/flows` | Onde os flows são lidos/salvos |
| `FALADOR_WEB_PORT` | `8787` | Porta do host web |
| `FALADOR_OMLX_URL` | `http://127.0.0.1:8080` | URL do omlx |
| `FALADOR_ASR_URL` | `http://127.0.0.1:8090` | URL do ASR |
| `FALADOR_TTS_URL` | `http://127.0.0.1:8091` | URL do sidecar TTS |
| `FALADOR_RUN_IDLE_STOP_MS` | `5000` | Carência antes do idle stop |
| `FALADOR_WEBHOOK_URL` | — | Webhook padrão para export de sessão |
| `FALADOR_MIC_TEST` | — | Habilita teste N7 (mic real) |

## 10. Verificação

- `node --test apps/web-server.routes.test.mjs` cobre `/api/logs`, `/api/session/export`, `/api/run`.
- Smoke: `./faladorctl start` → rode um flow → `curl -s 'http://127.0.0.1:8787/api/logs?name=web&lines=20'` deve listar eventos do run.
- Confirme que `logs/exec-audit.jsonl` recebeu linhas se o flow usou `exec.command`.