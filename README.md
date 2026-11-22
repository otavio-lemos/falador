# Falador

Tradutor de conferências em tempo real, **100% on-device**, num Mac Apple Silicon. Nada de áudio, texto ou prompt sai da máquina: o LLM, o ASR, o TTS e a decisão rodam em modelos locais servidos por processos residentes em `127.0.0.1`.

> Esta é a porta de entrada. A memória viva do projeto (fatos medidos, armadilhas, decisões e estado atual) é o **[`AGENTS.md`](AGENTS.md)**; a operação no dia a dia está no **[`run.md`](run.md)**. Leia os dois antes de mexer em qualquer coisa.

## Os dois cenários

| Cenário | O que acontece |
|---|---|
| **1 — Legendas** | Fala EN da conferência → legenda PT instantânea na tela. |
| **2 — Entrevista técnica** | Além da legenda, um LLM sugere a resposta em PT enquanto o entrevistador fala; você edita/aprova e, se quiser, a resposta vira voz EN (TTS segue no catálogo, fora do fluxo padrão desde o ADR-005). |

## Princípio de desenho: nada fixo

Não existe pipeline hardcoded. Um **canvas de nós** (React Flow + Carbon) monta o fluxo: cada etapa é um nó arrastável, conectável e configurável — modelo, idioma e parâmetros são escolhidos por nó. O mesmo motor roda o grafo no browser, no CLI e nos testes.

## Arquitetura em uma tela

```
captura (SCK por app)  →  ASR streaming  →  [turn.detector]  →  LLM/agente  →  decisão d1  →  gate humano  →  saída (legenda / tela / TTS / exec)
        services/            :8090              :8080           :8080        :8080      human.approve      sinks, exec.command
             └──────────────────── packages/falador-graph (motor) + packages/falador-nodes (23 nós) ───────────────────┘
                                             apps/web-server.mjs (:8787) + apps/web (UI)
```

- **`packages/falador-graph`** — motor de grafo headless, zero dependências: filas por aresta com `drop_oldest`/`block`/TTL, cancelamento por porta, `interrupt` (barge-in), validação V0–V7, métricas por nó.
- **`packages/falador-nodes`** — 23 nós reais: captura (SCK/PortAudio/ffmpeg), ASR streaming e por janela, `llm.omlx`, `agent.tools` (loop de tools), `decision.llm` (d1), `turn.detector`, `human.approve`, `tts.sts`, `exec.command`, `rag.search`, `tool.mcp`, `tool.workflow`, `tool.web_search`, `tool.crawler`, `input.chat`, sinks.
- **`packages/falador-cli`** — runner headless (`run-flow.mjs`): catálogo, eventos NDJSON, gates por stdin.
- **`apps/web-server.mjs`** — host zero-dep: catálogo, flows, run (NDJSON→SSE), gates, logs, RAG, export de sessão.
- **`apps/web`** — UI (Vite + React + Carbon + React Flow): Builder e Live.
- **`services/`** — sidecars Python (`sts-sidecar.py` TTS + tradução nativa, `capture-sidecar.py` PortAudio, `playback-sidecar.py`) e o helper Swift de captura por app (`capture-sck.swift`).

## Subir

```bash
./faladorctl start     # omlx :8080 · ASR :8090 · TTS :8091 · host/UI :8787
./faladorctl status    # sempre lista os 4
open http://127.0.0.1:8787
./faladorctl stop
```

O `start` depende de modelos já baixados no cache do HF e de um `.venv` com `mlx-audio` (ver `run.md` §3 para os comandos exatos e as armadilhas). Modelos são **residentes**: a carga fria custa 1,5–1,8 s, então nunca recarregue por utterance.

## Testes

```bash
cd packages/falador-graph && node --test test/                      # 41 testes
cd packages/falador-nodes && node --test --test-force-exit test/    # 141 testes (2 skip)
node --test apps/web-server.test.mjs apps/web-server.routes.test.mjs  # host: 14 testes
cd packages/falador-cli && node --test --test-force-exit test/        # runner CLI: 9 testes
cd apps/web && npx tsc --noEmit && npm run build && npx playwright test  # E2E sobe o host sozinho
```

Guia completo (pirâmide, o que cada suíte prova, cobertura medida e lacunas) em **[`docs/testing.md`](docs/testing.md)**. Cobertura medida em 2026-11-21: motor **94,4% linhas / 89,0% branches**; nós **86,6% / 70,8%**.

## Mapa do conhecimento

- **[`AGENTS.md`](AGENTS.md)** — memória viva: inventário do que já existe, ADRs, fatos medidos, armadilhas, estado atual.
- **[`docs/README.md`](docs/README.md)** — índice de ADRs, specs e research, com o mapa "afirmação → arquivo de prova".
- **[`docs/adr/STATUS.md`](docs/adr/STATUS.md)** — o que está implementado, o que falta e o que ainda é NÃO VERIFICADO.
- **[`docs/adr/spec-falador-graph.md`](docs/adr/spec-falador-graph.md)** — spec fina do motor.
- **[`run.md`](run.md)** — subir, usar, verificar saúde e derrubar.

## O que é 100% local e o que depende de download

Tudo o que processa áudio/texto é local. O que **não** existe sem download prévio: os pesos dos modelos (LFM3-1.7B, LFM3-Audio-2B, Voxtral Realtime, d1-2B/d1-Omni), o binário `omlx` e o `.venv` Python. O download é decisão do dono — o app nunca baixa modelo sozinho.

## Limites conhecidos (NÃO VERIFICADO)

- Chamada real de conferência com áudio de terceiros: o laço foi provado com mídia real e SCK, mas a confirmação final em call do dono é dele.
- MCP externo real e SSH em host remoto real: implementados e testados com alvos locais/fakes; falta alvo externo verdadeiro.
- Nenhum bug de validação em aberto: `ttlMs` não-finito e `edge.from`/`to` não-string agora viram `GraphError` (`INVALID_TTL` / `INVALID_EDGE_REF`), cobertos pela matriz e pelo fuzz (corrigidos em 2026-11-21).
