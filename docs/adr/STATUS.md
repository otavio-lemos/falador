# Status dos ADRs — o que está implementado, o que falta, qual é a prova

> Atualizado em **2026-11-22**. Fontes: código no repo, suítes de teste e `AGENTS.md` §4/§6. Quando este quadro divergir do código, o código vence — e este arquivo deve ser corrigido.

Legenda: ✅ implementado e verificado por teste/medição · 🟡 implementado, falta verificação no ambiente real · ⬜ não implementado / histórico.

| ADR | Status | Implementado | Pendente / NÃO VERIFICADO | Evidência |
|---|---|---|---|---|
| 001 arquitetura | ⬜ histórico | Desenho original que originou o projeto | Contém erros já documentados; não é fonte de verdade | [`ADR-001-arquitetura.md`](ADR-001-arquitetura.md) |
| 002 revisão multiagente | ✅ | Runtime `omlx` para texto; LFM3-Audio-2B ×2 (escuta/fala); decisões D1–D10 | — | [`ADR-002-revisao-multiagente.md`](ADR-002-revisao-multiagente.md), `AGENTS.md` §2 |
| 003 workflow engine | ✅ | Motor de grafo + TUI + React Flow/Carbon; emendas W7–W10 (teste por nó, binding no Run, idiomas por nó, device picker) | — | [`ADR-003-workflow-engine.md`](ADR-003-workflow-engine.md), `packages/falador-graph` |
| 004 núcleo mlx-audio | ✅ | `mlx-audio` como núcleo; registro local de modelos; download é decisão do usuário | — | [`ADR-004-nucleo-mlx-audio.md`](ADR-004-nucleo-mlx-audio.md), `services/*.py` |
| 005 cenário 2 só-texto + SCK | ✅ | Captura por app (SCK), sugestão na tela, sem TTS/eco no fluxo padrão; TTS segue no catálogo | Confirmação em **call real** com áudio de terceiros | [`ADR-005-cenario2-sotexto-sck.md`](ADR-005-cenario2-sotexto-sck.md), `services/capture-sck.swift`, `AGENTS.md` §4 (E2E 372 chunks/30 s) |
| 006 streaming tempo real | 🟡 | `turn.detector` (d1), `interrupt`/barge-in no motor, anti-drift `drop_oldest`, contexto deslizante + reset, `trace` ponta-a-ponta, export `.md`/webhook | E2E ao vivo com SCK/mídia real após a implementação | [`ADR-006...`](ADR-006-padroes-streaming-tempo-real.md), `packages/falador-graph/test/interrupt.test.ts`, `packages/falador-nodes/test/streaming.test.ts` |
| 007 RAG + exec.command | 🟡 | RAG BM25 multi-formato por nó; `exec.command` local/SSH com 4 camadas (d1 + gate + validador anti-injeção + dryRun/audit) | **SSH em host remoto real** (só `localhost`/alvos de teste) | [`ADR-007...`](ADR-007-rag-runbooks-conector-exec.md), `packages/falador-nodes/test/rag-exec.test.ts` |
| 008 agente + tools + MCP | 🟡 | `agent.tools` (loop `tool_calls`), porta `tool` bidirecional, `tool.mcp` stdio/HTTP, `exec_local`/`rag.search` como tools, auditoria | **MCP server externo real**; SSH remoto; E2E do agente em call | [`ADR-008...`](ADR-008-agente-tools-mcp.md), `packages/falador-nodes/test/agent-tools.test.ts`, `tools-mcp.test.ts` |
| 009 captura voz/chat + mic | 🟡 | Aplicações (SCK) vs Microfone (PortAudio) no mesmo nó; `/api/mics`; botão voz↔chat; `input.chat` no flow de entrevista | E2E com fala real/TCC/eco; Playwright (binário ausente); SCK `.microphone` | [`ADR-009...`](ADR-009-captura-entrada-dupla.md), [`input-modes-test-plan.md`](../input-modes-test-plan.md), `packages/falador-nodes/test/capture-input-modes.test.ts` |
| F0 POC protocolo | ✅ fechada | Gates G1 (captura), G2, G3 (streaming, com modificação) | — | [`F0-poc-protocolo.md`](F0-poc-protocolo.md), [`research/F0-resultados.md`](research/F0-resultados.md) |
| Spec v1.1 do motor | ✅ | Validação V0–V7, backpressure, cancel por seq/porta, ciclo de vida de `start()`, `stopWhenSourcesDone` | — | [`spec-falador-graph.md`](spec-falador-graph.md), `packages/falador-graph/test/` (41 testes, `spec.ts` 100% linhas) |

## Lacunas de qualidade registradas pela suíte (2026-11-21)

| Achado | Impacto | Onde | Status |
|---|---|---|---|
| `validateFlow` aceitava `ttlMs: NaN` | Mensagem com TTL `NaN` nunca expirava (comparações sempre falsas) | `packages/falador-graph/src/spec.ts` | **CORRIGIDO 2026-11-21** (`Number.isFinite`) — coberto em `validation-matrix.test.ts` |
| `edge.from`/`to` não-string → `TypeError` | Flow editado à mão derrubava o host com 500 em vez de erro de validação | `packages/falador-graph/src/spec.ts` | **CORRIGIDO 2026-11-21** (`typeof` antes do `split`, incl. filtro de desabilitados) — coberto em `fuzz-graph.test.ts` |
| `registry.ts` com 79% de linhas | Caminhos de erro do registry não exercitados | `packages/falador-graph/src/registry.ts` | Cobertura conhecida, sem teste dedicado |
| ~~Host HTTP: 5 testes~~ | **RESOLVIDO 2026-11-21**: 14 testes cobrindo rotas + adversariais | `apps/web-server.routes.test.mjs` | ✅ |
| ~~Runner CLI sem teste próprio~~ | **RESOLVIDO 2026-11-21**: 9 testes de contrato (NDJSON, exit codes, stdin, SIGTERM) | `packages/falador-cli/test/run-flow.test.mjs` | ✅ |
| ~~Playwright exige servidor manual~~ | **RESOLVIDO 2026-11-21**: `webServer` sobe o host; 4/4 verde | `apps/web/playwright.config.ts` | ✅ |
| Path traversal em `POST /api/flows` | Escrita fora de `FLOWS_DIR` via `name` cru | `apps/web-server.mjs` | **CORRIGIDO 2026-11-21** (`safeFlowPath`) |

## O que nunca foi provado (marcado NÃO VERIFICADO de propósito)

- Chamada real de conferência (Teams/Zoom/Meet) de ponta a ponta com o dono respondendo.
- Confirmação visual do dono no browser para a UI atual (Live em chat, painel de logs, gate).
- Servidor MCP externo real e host SSH remoto real.
- `audio.cpp` (GGUF) como runtime alternativo para STT+tradução streaming nativa.
