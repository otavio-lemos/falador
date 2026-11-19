# AGENTS.md — Falador

> **MEMÓRIA VIVA DO PROJETO. Toda sessão de agente deve ler este arquivo primeiro e ATUALIZÁ-LO ao final de cada conquista.** Última atualização: 2026-11-18.

## 1. O que é o Falador

App local (macOS, Apple Silicon M4 Pro 48 GB) que traduz conversas de conferência (Teams/Zoom/Meet) em tempo real, 100% on-device:

- **Cenário 1:** A fala EN → legenda PT instantânea para B; B escreve PT → voz EN em tempo real.
- **Cenário 2 (entrevista técnica):** além disso, um **LLM técnico NO MEIO** sugere resposta em PT (streaming), B edita/aprova → TTS EN.
- **Princípio da UI: NADA FIXO** — canvas de nós estilo n8n/ComfyUI onde o usuário monta o fluxo: cada etapa é um nó arrastável/duplicável/conectável; seleção de modelo por nó no momento de executar (Run), idiomas independentes por nó.
- Regras do dono (Otávio): 100% verdadeiro; marcar NÃO VERIFICADO quando parecer; fontes reais sempre; nada de código/instalação sem aprovação; não construir o que já existe; não fugir do desenho; conhecimento sempre documentado.

## 2. Inventário: o que JÁ EXISTE e VAMOS USAR (não reconstruir!)

| Ativo | O que é | Como usamos |
|---|---|---|
| **mlx-audio** (Neywa-Labs, MIT, v0.6.6, 8.3k★) | TTS+STT+STS+VAD em MLX; hospeda LFM3-Audio-2B; server OpenAI-compat c/ `/v1/realtime`; `StreamingSession` (feed/step/close) | **Núcleo de áudio da v1** (ADR-004 E1-E2). Instalado no `.venv` |
| **LFM3-Audio-2B-MLX-8bit** (HF, oficial LiquidAI) | Modelo any-to-any: ASR + TTS (EN e **PT ok**, medido 4,9× rt) | Duas instâncias residentes: escuta + fala (D6) |
| **omlx** 0.8.0 (brew, Apache-2.0) | Servidor LLM Apple Silicon, OpenAI-compat | LLM técnico + tradução, porta 8080; `chat_template_kwargs:{"enable_thinking": false}` OBRIGATÓRIO (medido, ver §4) |
| **LFM3-1.7B-MLX-4bit** (HF) | LLM texto (PT oficial entre 16 idiomas) | Nó LLM do cenário 2; servido via omlx (`~/.omlx/models` symlink → snapshot HF) |
| **BlackHole 2ch** (já existia na máquina) | Driver de áudio virtual | Laço sistema→captura; Multi-Output configurado e testado (G1 PASS) |
| **Dispositivo com Saída Múltipla** (Speakers+BlackHole, clock=Speakers) | Configuração do usuário no Audio MIDI Setup | Saída do sistema ativa; captura sem ficar surdo — PROVADO com mídia real |
| **SokujiVirtualAudio** (device remanescente) | Driver do app Sokuji (tradução live em calls, open-source) | Referência de prior art; driver pode reutilizar/estudar. App não está mais em /Applications |
| **Ollama.app** | Runtime LLM alternativo | Alternativa pluggable (D7); não é o primário |
| **$HOME/ml/mlx-vlm** (clone) | Port alternativo do LFM3-Audio (Blaizzy) | Origem de `stream_slots` (bridge de streaming da G3); manter por referência |
| **$HOME/ml/falador/.venv** | Python 3.12 + mlx-audio + mlx-vlm + huggingface_hub | Ambiente de execução da fase F0/engine |

**Modelos no HF cache local:** LFM3-Audio-2B-MLX-8bit · LFM3-1.7B-MLX-4bit (`~/.cache/huggingface/hub`; `HF_HOME=~/.hf_home` observado também).

## 3. Decisões (índice de ADRs — doc viva em docs/adr/)

| ADR | Tema | Status |
|---|---|---|
| 001-arquitetura | Desenho original | Histórico (contém erros documentados) |
| 002-revisao-multiagente | Runtime: omlx p/ texto + LFM3-Audio-2B ×2 (D1–D10) | ACEITO |
| 003-workflow-engine | Motor de grafo headless + TUI Textual + React Flow + Carbon; emendas W7–W10 (teste por nó, binding no Run, idiomas por nó, device picker) | ACEITO |
| 004-nucleo-mlx-audio | mlx-audio = núcleo; registro local de modelos; **recomendado sempre marcado**; **"?" abre GitHub do modelo**; download é do usuário | ACEITO |
| **spec-falador-graph v1.1** | Spec fina do motor (portas declaradas no tipo, emit async, cancel por seq por porta, backpressure block+timeout, V0–V7) — endorsements de 3 revisões adversariais | ACEITA (implementada) |

## 4. Fatos MEDIDOS (M4 Pro, 2026-11-18 — não estimar de novo sem re-medir)

| Fato | Número |
|---|---|
| ASR (Audio-2B 8-bit) | RTF 0,05 (0,22–0,23 s p/ 4,09 s de fala) |
| TTS EN / TTS PT | 3,6× / 4,9× realtime |
| 1º frame de fala no streaming | ~75 ms (frames de 80 ms via `stream_slots`) |
| Tradução NATIVA LFM3-Audio (task=chat + áudio tipado, sidecar `/asr-translate`) | 4,64 s de fala EN → PT em **0,31 s** (~15× realtime; NÃO streaming — por janela de utterance/flush) |
| Slots/s no streaming | 77–78 (6,2× realtime; realtime = 12,5) |
| Codec decode | RTF 0,002 |
| TTFT omlx solo / 2 concorrentes | 30 / 60 ms (p50, warm) |
| Carga fria de modelo | 1,5–1,8 s → **serviços residentes obrigatórios** |
| Captura BlackHole (G1) | max_volume −1,8 dB; laço sistema→ASR provado com mídia real |
| G3b: streaming vs offline (mesmo modelo/áudio) | texto IDÊNTICO (WER 0 EN e 0,087 PT nos DOIS caminhos — erros são do TTS de referência); 1º delta ~1,1 s; `completed` < duração do áudio (7,8 s < 8,5 s) |

**Armadilhas descobertas na prática:**
- LFM3-1.7B pensa por padrão → usar `enable_thinking: false` (`chat_template_kwargs`) — descoberto porque o `content` vinha vazio e só saía `reasoning_content`.
- omlx 0.8.0 não aceita modelo na linha do `serve`; usar `--model-dir` (+ symlink pro snapshot do HF).
- cinzas de comparação cold vs warm sempre separadas em tabela de latência.
- Chamadas PARALELAS ao MCP do Carbon via run_typescript falham; usar curl sequential com header `X-MCP-Session` (ver scratchpad falador-carbon-mcp.md).
- Node 26 type-stripping: NÃO aceita parameter properties (`constructor(public x)`) — campo explícito + atribuição; nem `import()` dinâmico no sandbox do agente.
- Motor de grafo: durante drain do `stop()`, `emit()` precisa ser permitido, senão um nó em processamento dá throw, mata o pump e PERDE mensagem (bug apanhado no teste C4).
- **BUG DO MOTOR CORRIGIDO (2026-11-19)**: `stopWhenSourcesDone` olhava só profundidade de fila — um `onInput` EM VOO (ex.: LLM aguardando fetch de ~300 ms) parecia "nada pendente" e o run abortava o nó no meio, engolindo a saída. Correção: contador `inFlight` por nó em `runtime.ts`; `maybeNaturalStop` só termina com filas vazias **e** nenhum onInput em voo. Aprendizado: "fila vazia" e "nó ocioso" são coisas diferentes.
- **BUG DO MOTOR CORRIGIDO #2 (2026-11-19, mesma família)**: `start()` dos nós era CONSUMIDO sequencialmente (`await st.runtime.start()` um por um) — uma fonte cujo `start()` demora (ex.: produtor que alimenta o grafo a partir do próprio start) Bloqueava o start dos nós downstream; quando todos assentavam, `maybeNaturalStop` matava o run com filas vazias **antes do WS do downstream nem abrir** (o `stop()` fechava o ws antes de `onopen` — nenhuma mensagem, nenhum log, run "completo" com 0 envelopes). Correção: starts são INVOCADOS em ordem topológica mas sem await de conclusão (Spec §68 fala de ordem de invocação; §88 já previa "stop() com start() pendente"); `allStarted` = todos os start() assentados; `maybeNaturalStop` exige allStarted. Erro em start() continua virando node_error + política. **Aprendizado dobrado**: (a) "fonte esgotada" ≠ "fila vazia e nodeName ocioso" — a fonte ainda nem começou a produzir; (b) debugar E2E de WS com delete do lado client antes de suspeitar do protocolo: isole com um cliente standalone mínimo (o nosso caso: cliente puro funcionava perfeitamente → bug estava no engine).
- **LFM3-Audio NÃO suporta streaming STT** (sem `create_streaming_session`) — a nota anterior de que o WS `/v1/realtime` funcionaria com ele estava ERRADA. No mlx-audio instalado, só `voxtral_realtime` e `nemotron_asr` implementam o contrato de `StreamingSession` (feed/step/close/done/input_sample_rate). WS `/v1/realtime` rejeita com "does not support streaming".
- Node fetch (undici) mantém sockets keep-alive: runner de teste fica preso no fim do arquivo — usar `--test-force-exit`.
- O server do mlx-audio aceita carregar snapshot LOCAL por PATH (evita HFValidationError de `--` no repo_id), mas o modelo carregado precisa implementar o contrato de streaming para o WS realtime.

**Tradução EN→PT (2026-11-19, PROVADO com código+execução):**
- LFM3-Audio-2B `task='asr'` + `language='pt'` → NÃO traduz (sai EN, 0,39–0,53s). `language` aqui é só hint.
- Voxtral Realtime `generate(language='pt')` → texto idêntico em EN (5,3s offline). Language = idioma de origem.
- Server mlx-audio `/v1/realtime` nem aceita `language` (código: só temperature/delay no streaming session).
- **LFM3-Audio TRADUZ nativamente via `messages` com bloco `{"type":"audio"}` TIPADO + instrução no texto do user** (task='chat') → "Até caching e engines de inferência eficazes dependem do comprimento do prefill…" — mas NÃO-streaming (sem create_streaming_session; contrato só em voxtral_realtime/nemotron_asr).
- LFM3 `system_prompt` SUBSTITUINDO o prompt default do task → resultado VAZIO (2 testes). Não usar para tradução.
- Fluxo E2E `apps/tui/flows/cenario1-pt.json` (capture → asr.realtime → llm.omlx tradutor → sink.captions) PASSOU com mídia real: afplay EN → legenda PT streaming ao vivo (parciais com \r+erase).
- **Prior art entrevista técnica (referência UX, NÃO copiar código)**: interview-coder (~4,4k★), SevaSk/ecoute, natively-cluely, elias-soykat/interview-copilot, ericwang915/interview-copilot — TODOS dependem de API em nuvem (OpenAI/Deepgram/GPT-4o); nosso diferencial = 100% on-device. Ideias a beber na fase de UI: janela discreta/stealth (interview-coder), gatilho por pausa de fala=VAD (elias-soykat), separação mic×áudio do sistema (ericwang915), RAG de documentos (natively).
- `audio.cpp` (0xShug0) tem LFM3-Audio em GGUF com streaming — runtime alternativo NÃO VERIFICADO, anotado como ponte futura caso precisemos de STT+tradução streaming nativa.

- **UI web fase 2 INICIADA E E2E VERDE (2026-11-19)**: `apps/web` (Vite+React+@xyflow/react+@carbon/react) + **host zero-dep `apps/web-server.mjs`** (:8787) — `/api/catalog` (spawn run-flow --catalog), `/api/flows` (save/load JSON), `/api/run` (spawn runner + NDJSON→SSE), `/api/stop`. Canvas React Flow com nós custom do catálogo, paleta drag&drop, param editor + registro de modelos (RECOMENDADO + "?"→HF) + enabled, salvar/carregar flows (mesmo schema do runner). **Legendas do runner agora saem como eventos NDJSON `caption`** (auto-binding `__onCaption` para sink.captions sem binding; flow PT usa mode callback). E2E via SSE com mídia real: parciais + final PT chegando. **Pendente**: verificação visual no browser pelo usuário (`node apps/web-server.mjs` → http://127.0.0.1:8787).
- **Silêncio transitório do pipeline (2026-11-19)**: 2-3 E2E seguidos saíram sem nenhum delta do ASR/legenda (ASR saudável, omlx saudável, captura com sinal): causa provável = contenção de GPU/unified memory com testes Python que carregavam LFM3-Audio/Voxtral ao mesmo tempo. Recuperou sozinho. **Lição: não rodar testes .py que carregam modelo junto de E2E de áudio.**

- **Cenário 2 completo INTEGRAÇÃO AO VIVO (2026-11-19, cenario2-auto.json)**: pipasist → asr → **assistente (llm.omlx, sistema "sugira a resposta PT em 1ª pessoa")** → **porta (decision.llm, options auto/humano, porta POR opção)** → auto → tts.sts(EN) → sink.playback; humano lane → human.approve (gate) → tts → playback (dedicado, Spec V2 in-degree=1). E2E com mídia real: **2× fala EN sintetizada + playback ok (9-10s), decisão escolheu 'auto' (gate nem abriu)**. Roda limpo, sem erros.
- **Nós novos: `human.approve` e `decision.llm`** — falador-nodes **8/8 testes** (N8: gate segura/aprova com edição/rejeita + MISSING_BINDING; N9: roteamento por porta). Motor ganhou **`outputsFor(params)`** (saídas dinâmicas por instância, Spec §types) — decision.llm emite uma porta por opção.
- ansible **Gate UI**: eventos NDJSON `{"type":"gate","nodeId","text"}` + stdin `{"type":"gate_action","nodeId","text|null"}`; web `/api/gate`; **stop do run resolve gates pendentes como rejeição** (sem isso o rg.done pende para sempre — gate pendurado = run morto silencioso).
- **Laya VERIFICADA (2026-11-19)**: `huggingface.co/convaiinnovations/laya` EXISTE — Apache-2.0, ~0.3-0.4B, decisões System 1 com probabilidade calibrada; variantes `laya-multilingual`, `laya-typed-decisions`. Precisa sidecar Python (como o de TTS) + fine-tuning; zero-shot dos artigos: NÃO VERIFICADO. Primeira implementação é `decision.llm` (LFM3-1.7B omlx residente, zero deps novas). Anotada no registro de modelos como alternativa futura.
- **Cars de TTS no fluxo**: nó `tts.sts` **acrescenta `/tts` ao baseUrl** — passar `http://127.0.0.1:8091` (não `/tts`) senão 404 /tts/tts. TTS e playback agora emitem log_info (evidência em event-sourcing: "fala: … (N KB)", "playback ok (Ns)").
- **Runner child + undici**: o processo child do runner não sai sozinho após run_stopped (keep-alive do fetch/undici) — o host matar SIGKILL 300 ms após `summary`/`run_stopped`, senão **o próximo run recebe "run já em andamento"** (409).

## 5. Lições de processo (não repetir o mesmo erro)

- **L1** — pegada de instalação/dependências de runtime auditar na arquitetura ANTES (omlx: brew tap 254 MB + LLVM >300 MB).
- **L2** — frio vs quente sempre separados; nenhum modelo recarregado por utterance.
- **L3** — ler CÓDIGO do port/lib, não só README/issues (streaming parcial existia escondido).
- **L4** — não expandir catálogo de alternativas sem aprovação do dono; foco no desenho.
- **L5** — inventário antes de construir: checar o que já existe no repo/máquina/ecossistema e REUTILIZAR (ver §2).

## 6. Estado atual (atualizar SEMPRE)

- F0 **FECHADA** (2026-11-18): G1 PASS · G2 PASS · G3 PASS-COM-MODIFICAÇÃO — detalhes em `docs/adr/research/F0-resultados.md`.
- Servidor omlx no ar: porta 8080, modelo LFM3-1.7B-MLX-4bit (processo de fundo da sessão).
- Pendente menor do G1: confirmar com o usuário se ouviu a frase `afplay` durante a captura (não foi transcrita — possível corrida; midia real provou o laço).
- ~~G3b pendente~~ → FEITO 2026-11-19 (ver §7 e `docs/adr/research/G3b-resultados.md`).
- **Motor `falador-graph` IMPLEMENTADO (2026-11-18, ordem "vai até o fim")**:
  - Spec v1.1 em `docs/adr/spec-falador-graph.md` — passou por 3 revisões adversariais (salvas em `docs/adr/reviews/spec-rev-{tempo,api,validacao}.md`); achados principais: emit async (backpressure `block` real), cancel por seq com escopo de PORTA, ciclo de vida de start(), validação V0–V7 endurecida.
  - Código em `packages/falador-graph/` (Node 26, type-stripping nativo, **zero dependencies**): types/queue/spec/registry/runtime + nós sintéticos.
  - **8/8 testes passando** (`npm test` em `packages/falador-graph`; padrões de política drop_oldest/block, TTL, cancel por seq, CYCLE/PORT_TYPE_MISMATCH/DUPLICATE/UNKNOWN_PORT/MISSING_BINDING, drain reverso idempotente, p50/p95).
  - Descobertas da implementação: type-stripping do Node 26 NÃO aceita parameter properties (constructor `public x`) nem `import()` no sandbox; durante o drain do stop() o emit DEVE ser permitido (senão nó em processamento mata o pump e perde mensagem); `stopWhenSourcesDone` liga teste de fim natural.
- **Sidecar TTS `services/sts-sidecar.py` VERIFICADO AO VIVO (2026-11-19, porta 8091)**: `POST /tts {text, language, voice, sample_rate}` → WAV PCM16 mono 24 kHz. EN: 2,96 s de áudio em 0,65 s (4,55× rt, 142 KB). PT: 4,00 s em 0,75 s (5,32× rt, 192 KB). Roda com `--model <snapshot Path>` (processo residente; **iniciar via tools.process.start**, shell comum mata o processo quando o comando termina).
- **Sidecar ganhou `POST /asr-translate` (2026-11-19)**: `{audioB64: WAV PCM16 b64, instruction, sample_rate}` → `{text}` — transcrição+tradução NATIVA via `MODEL.generate(messages=[{áudio tipado}+instrução], task='chat')` (VERIFICADO no código do mlx_audio; `result.text`). Mesmo modelo residente, mesmo lock.
- **Nó `asr.lfm3` (falador-nodes) VERIFICADO AO VIVO (2026-11-19)**: acumula `audio_chunk` s16le (aceita WAV do tts.sts tb) → janela `flushSec` (default 30) → `/asr-translate` → `tokens_parcial {text, final:true}`; resto pendente traduzido no `stop()`. Teste N10 no engine: EN real do sidecar → PT, 1,2 s. Fluxo variante: `apps/tui/flows/cenario1-lfm3.json` (sem nó llm tradutor).
- **`falador-nodes` 9/9 VERDES (N1–N6, N8–N10; N7 skip por gate FALADOR_MIC_TEST)**.
- **Pacote `falador-nodes` IMPLEMENTADO (2026-11-19, r2) — 5/5 testes verdes** (`npm test` em `packages/falador-nodes`; zero dependências, imports relativos ao falador-graph):
  - `llm.omlx` — SSE OpenAI-compat em :8080, `enable_thinking:false`, parciais CUMULATIVOS `{text, final}` (TTFT medido no nó), template/multiturno (`historyMax`), age só no `final` quando recebe parciais.
  - `tts.sts` — POST /tts no sidecar :8091 → `audio_chunk` `{format:'wav', sampleRateHz, data:Uint8Array}`; aceita tokens_parcial (fala no final) ou phrase.
  - `asr.realtime` — WS :8090 `/v1/realtime` (OpenAI Realtime subset), texto cumulativo por item, server_vad Silero OU commit manual (commitEveryMs/silenceThresholdMs), reconexão com backoff. **PRECISA de modelo com streaming: Voxtral-Mini-4B-Realtime (baixando 4bit)**.
  - `capture.ffmpeg` — spawn avfoundation (`:N`), s16le mono 16k, chunks de 80 ms (2560 bytes), backpressure natural.
  - `sink.captions` — linha parcial com `\r` + ANSI erase, final em linha nova; modo `callback` via binding `__onCaption`.
  - `sink.playback` — WAVs em arquivos temporários + afplay serializado, maxQueue descarta excesso.
  - **INTEGRAÇÃO AO VIVO PASSANDO**: source → llm.omlx (omlx real) → tts.sts (sidecar real) → WAV em 551 ms end-to-end.
- **Motor `falador-graph` 12/12 verdes** (8 C-tests + 4 E-tests de enabled/disabled; edge de nó desabilitado é descartada junto, por Spec).
- **`falador-nodes` 7/7 VERDES (2026-11-19, r5)**: N1-N6 (incl. ASR ao vivo, ver r3) **+ N7 mic real**: `capture.ffmpeg` com `input: ':1'` (Microfone MacBook Pro) produz ~18-19 chunks contínuos de 2560 bytes (80 ms @16k s16le) em 2 s com SINAL (energia média 78,22). Rodar com `FALADOR_MIC_TEST=1 npm test` (gate).
- **LIMPEZA DE DISPOSITIVOS DO USUÁRIO (2026-11-19)**: antes, ffmpeg/avfoundation só enxergava `SokujiVirtualAudio [2]` (silencioso) e capturar `:0` dava zeros. Depois da limpeza, avfoundation expõe `[0] BlackHole 2ch` e `[1] Microfone (MacBook Pro)` — mic real agora FUNCIONA pro ffmpeg. Sokuji removido do caminho de áudio.
- **Stack residente re-subido via tools.process.start após a limpeza (2026-11-19)**: omlx :8080 (`omlx serve --model-dir ~/.omlx/models`), sidecar TTS :8091 (`services/sts-sidecar.py --model <LFM3-Audio snapshot> --port 8091`), server ASR :8090 (`python .venv/.../mlx_audio/server.py --host 127.0.0.1 --port 8090 --realtime-model <Voxtral snapshot>`). IDs de processo desta sessão: omlx `…de83d4d3…`, tts `…16d080e1…`, asr `…494dbd4e…`.

## 7. Próximos passos acordados (a aprovar 1 a 1)

1. ~~Especificação do motor `falador-graph`~~ → **FEITO**: spec v1.1 + 3 revisões adversariais + implementação com 8/8 testes verdes (2026-11-18).
2. ~~Adaptadores de nós reais~~ → **FEITO (r2-r5, 2026-11-19)**: `llm.omlx`, `tts.sts`, `asr.realtime`, `capture.ffmpeg`, `sink.captions`, `sink.playback` — **7/7 testes verdes, inclusive ASR ao vivo (N6) e mic real com sinal (N7, `FALADOR_MIC_TEST=1`)**.
3. ~~G3b (qualidade do decode incremental)~~ → **FEITO (2026-11-19)**: streaming == offline em qualidade (EN WER 0; PT WER 0,087 idêntico nos dois) — `docs/adr/research/G3b-resultados.md`; formato `audio_chunk` FECHADO.
4. ~~TUI Textual (r4) fase 1~~ → **FEITO (2026-11-19)**: `apps/tui/falador_tui.py` (Textual 8.2.8): DataTable de nós com toggle `enabled` (persistido no flow JSON), paleta do catálogo, reorder ↑↓, run com eventos NDJSON ao vivo; **runner headless `packages/falador-cli/run-flow.mjs`** (`--catalog` JSON + eventos NDJSON + summary com payloads truncados, binding automático para sink.collect). Smoke headless: `apps/tui/smoke.py` (textual pilot) — VERDE. Fluxos: `apps/tui/flows/demo-engine.json` (sintético) e `demo-live.json` (omlx+sidecar, e2e OK). canvas de nós = fase web.
5. **UI web fase 2**: React Flow + componentes Carbon in-node; registro de modelos (dropdown local + badge RECOMENDADO + "?"→GitHub); perfis de execução no Run. O runner NDJSON (`falador-cli`) é o host que a web vai usar.
6. Limpar server-dbg (:8092) e scripts de debug em /tmp — **FEITO (2026-11-19)**: processo parado, arquivos removidos.
7. **Git**: repositório INICIALIZADO (2026-11-19, commit inicial `62e948c` com 44 arquivos); a cada conquista, commit.
8. ~~Cenário 1 E2E~~ → **FEITO (2026-11-19)**: `cenario1-pt.json` PASSOU com mídia real (afplay → BlackHole → Voxtral ASR → omlx tradução → legenda PT streaming). Tradução nativa do STT: NÃO streaming; LFM3 `chat`+audio TIPADO traduz nado-nado (potencial nó futuro `asr.lfm3` p/ utterance).
9. **Fase 2 — UI web (React Flow + Carbon)** desenhada pelo usuário no canvas (ADR-003 "nada fixo"); + nó tradução nativa (`asr.lfm3` chat+audio) como opção do catálogo.
10. **UI web** → INICIADA (2026-11-19, ver §6). Próximas sub-etapas: (a) confirmação visual pelo usuário em http://127.0.0.1:8787; (b) refino do Inspector (textarea/params complexos, edição fino do LLM template); (c) Cenário 2 no canvas (asr → llm sujestão → tts.fala com playback gear); (d) nó `asr.lfm3` tradução nativa por utterance.
11. ~~Cenário 2~~ → **FEITO (2026-11-19)**: `cenario2-auto.json` com decisão AUTO/HUMANO roteada por porta, gate humano com edição na UI, TTS EN + playback — E2E ao vivo PASSOU (2× fala+playback, lane auto). Commit `6554a5d`.
12. **UI web refinada (2026-11-19)**: Inspector com textarea p/ prompts (`system`/`instructions`/`text`), editor **JSON** p/ params estruturados (`template` do llm.omlx é array de strings!, `options` da decisão), "?" aponta pro modelo SELECIONADO (não pro 1º da lista), placeholders com default real do nó. Build limpo (tsc+vite). FALTA: confirmação visual do dono em http://127.0.0.1:8787.
13. **Nó `asr.lfm3`** → **FEITO (2026-11-19)**: tradução nativa por janela (ver §6). Restam: `decision.laya` sidecar (precisa fine-tune; aprovação do dono) e WebUI fase 3 (metrics por nó, perfis de Run).

## 8. Protocolo de atualização deste arquivo

1. Novo fato medido → §4. Nova decisão → ADR + linha em §3. Nova lição → §5.
2. Mudança de estado (servidor, setup do usuário, gate) → §6.
3. Anotação de algo JÁ EXISTENTE que passamos a utilizar → §2.
4. Regra de ouro: se um agente do futuro precisar redesenhar o projeto só lendo este arquivo + ADRs, nós falhamos. Escreva pra esse padrão.
