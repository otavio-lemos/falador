# docs/ — índice do conhecimento do Falador

> Este diretório guarda o **porquê** e a **prova**. O **o quê / estado atual** fica no [`../AGENTS.md`](../AGENTS.md); o **como operar** no [`../run.md`](../run.md); a porta de entrada no [`../README.md`](../README.md).

## 1. Decisões (ADRs)

| ADR | Tema | Status |
|---|---|---|
| [001 — arquitetura](adr/ADR-001-arquitetura.md) | Desenho original | Histórico (contém erros documentados; não usar como fonte de verdade) |
| [002 — revisão multiagente](adr/ADR-002-revisao-multiagente.md) | Runtime: `omlx` p/ texto + LFM3-Audio-2B ×2 (D1–D10) | ACEITO |
| [003 — workflow engine](adr/ADR-003-workflow-engine.md) | Motor de grafo headless + TUI + React Flow + Carbon; emendas W7–W10 | ACEITO |
| [004 — núcleo mlx-audio](adr/ADR-004-nucleo-mlx-audio.md) | `mlx-audio` como núcleo; registro local de modelos; download é do usuário | ACEITO |
| [005 — cenário 2 só-texto + SCK](adr/ADR-005-cenario2-sotexto-sck.md) | Pivô do dono: sugestão na tela, dono fala; captura por app sem Multi-Output/eco | ACEITO |
| [006 — padrões de streaming](adr/ADR-006-padroes-streaming-tempo-real.md) | Anti-drift, barge-in, `turn.detector` d1, contexto deslizante, `trace`, export | IMPLEMENTADO (E2E ao vivo com SCK: NÃO VERIFICADO) |
| [007 — RAG + `exec.command`](adr/ADR-007-rag-runbooks-conector-exec.md) | RAG BM25 local + conector local/SSH com 4 camadas de segurança | IMPLEMENTADO (SSH em host remoto real: NÃO VERIFICADO) |
| [008 — agente + tools + MCP](adr/ADR-008-agente-tools-mcp.md) | `agent.tools` com `tool_calls` nativo, porta `tool`, `tool.mcp` | IMPLEMENTADO (MCP externo real: NÃO VERIFICADO) |
| [009 — captura voz/chat + mic](adr/ADR-009-captura-entrada-dupla.md) | Aplicações (SCK) vs Microfone (PortAudio) no mesmo nó; botão alterna voz↔chat | IMPLEMENTADO (E2E fala real: NÃO VERIFICADO) |
| [F0 — POC de protocolo](adr/F0-poc-protocolo.md) | Protocolo da fase 0 | FECHADA (ver research) |

Quadro detalhado de pendências e evidências: **[`adr/STATUS.md`](adr/STATUS.md)**.

## 2. Spec

- [`adr/spec-falador-graph.md`](adr/spec-falador-graph.md) — spec fina do motor (portas declaradas no tipo, `emit` async, cancel por seq/porta, backpressure, validação V0–V7, ciclo de vida de `start()`). Passou por três revisões adversariais antes de ser implementada.

## 3. Research (medições e comparações)

| Doc | O que prova |
|---|---|
| [`adr/research/F0-resultados.md`](adr/research/F0-resultados.md) | Gates G1/G2/G3 da fase 0 (captura, laço sistema→ASR, streaming) |
| [`adr/research/G3b-resultados.md`](adr/research/G3b-resultados.md) | Streaming vs offline do decode: mesma qualidade (EN WER 0; PT 0,087 nos dois) |
| [`adr/research/mlx-audio-analise.md`](adr/research/mlx-audio-analise.md) | Por que `mlx-audio` é o núcleo e o que ele (não) suporta |
| [`adr/research/workflow-engines-2026-11.md`](adr/research/workflow-engines-2026-11.md) | Padrões de Pipecat/LiveKit/n8n que inspiraram o motor |
| [`workflows-audit.md`](workflows-audit.md) | Auditoria dos 9 workflows em 2026-11-22: 3 remoções, 5 correções, 7 fluxos finais e fontes de mercado |
| [`input-modes-test-plan.md`](input-modes-test-plan.md) | Plano de testes da entrada dupla (unitário, headless, UI, live) com o que foi executado e o que ficou NÃO VERIFICADO |
| [`testing.md`](testing.md) §1/§5 | Pesquisa real (Node 26 `node:test`, cobertura nativa, fuzz com PRNG semeado, Playwright) que fundamentou a evolução das suítes — consolidada no guia de testes |
| [`../lfm2-runtimes-research.md`](../lfm2-runtimes-research.md) | Runtimes alternativos para LFM2 (nota de pesquisa) |

## 4. Reviews

[`adr/reviews/`](adr/reviews/) guarda as revisões adversariais do desenho e da spec (`spec-rev-tempo.md`, `spec-rev-api.md`, `spec-rev-validacao.md`) e as revisões por agente (`agy.md`, `codex.md`, `kilo.md`). São registro histórico: quando divergem do código, o código + `AGENTS.md` vencem.

## 5. Testes

[`testing.md`](testing.md) — pirâmide de testes, o que cada suíte cobre, comandos exatos, cobertura medida em 2026-11-21 e as lacunas conscientes (WhatsApp/Playwright, modelos reais, sidecars sem `.venv`).

## 5a. Operação e cadastros

- [`servidores.md`](servidores.md) — **cadastro de servidores** (alvos de `exec.command`): template com host, user, port, ambiente, tags, descrição e comando de checagem padrão; como ligar ao flow; segurança (allowlist, sshUser, denylist); onde guardar (privacidade). Sem servidores reais inventados — só template e instruções.
- [`execucoes.md`](execucoes.md) — **trilha de execução**: o que é um run, terminais (stdout vs callback), eventos NDJSON, onde ficam os logs (`logs/*.log`, `exec-audit.jsonl`, `sessions/`, `context/`), como exportar uma sessão, como um run termina, métricas por nó e variáveis de ambiente.

## 6. Mapa "afirmação → prova"

| Afirmação | Prova |
|---|---|
| ASR 8-bit: RTF 0,05; TTS 3,6×/4,9× realtime; 1º frame ~75 ms | `AGENTS.md` §4 (medido 2026-11-18) + [`adr/research/F0-resultados.md`](adr/research/F0-resultados.md) |
| Tradução nativa EN→PT em 0,31 s por utterance (não streaming) | `AGENTS.md` §4 + [`adr/research/G3b-resultados.md`](adr/research/G3b-resultados.md) |
| Decisão d1-2B: ~40 ms/decisão warm; d1-Omni ~38 ms | `AGENTS.md` §4 + `packages/falador-nodes/test/nodes.test.ts` (N11) |
| `turn.detector` fecha turno em 87 ms | `AGENTS.md` §4/§6 + `packages/falador-nodes/test/streaming.test.ts` |
| E2E ops (RAG→LLM→d1→gate→exec) em 0 erros | `AGENTS.md` §4/§6 + [`adr/ADR-007-rag-runbooks-conector-exec.md`](adr/ADR-007-rag-runbooks-conector-exec.md) |
| `agent.tools` usa `tool_calls` nativo do omlx 0.8.0 | `AGENTS.md` §4 + [`adr/ADR-008-agente-tools-mcp.md`](adr/ADR-008-agente-tools-mcp.md) + `packages/falador-nodes/test/agent-tools.test.ts` |
| Motor valida V0–V7 e nunca aceita ciclo/porta incompatível | `packages/falador-graph/test/validation-matrix.test.ts` + `spec.ts` 100% de linhas |
| Validação não explode em specs malformados | `packages/falador-graph/test/fuzz-graph.test.ts` (com 1 lacuna conhecida, marcada como skip) |
| SCK captura 16 kHz mono por app, sem eco | `AGENTS.md` §4 + [`adr/ADR-005-cenario2-sotexto-sck.md`](adr/ADR-005-cenario2-sotexto-sck.md) |
| ffmpeg 9.0.2 perde ~75% dos samples nesta máquina | `AGENTS.md` §4 (medido 2026-11-19) + `services/capture-sidecar.py` (motivo do backend PortAudio) |

## 7. Lacunas conhecidas (não escondidas)

- **Confirmação visual do dono** no browser para Live/chat/logs: pendente.
- **Call real** com áudio de terceiros via SCK: laço provado com mídia real, call do dono não.
- **MCP externo real** e **SSH em host remoto real**: só alvos locais/fakes até aqui.
- **`validateFlow`**: os dois buracos achados pelo fuzz (`ttlMs` não-finito e `edge.from`/`to` não-string) foram **corrigidos em 2026-11-21** e viraram casos da matriz de validação.
- **Sidecars Python** não rodam no worktree de desenvolvimento (sem `.venv`): testes que dependem deles são pulados com motivo.
