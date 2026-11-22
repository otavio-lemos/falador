# run.md — Guia de operação do Falador (subir · usar · derrubar)

> Como subir todos os serviços, acessar a UI, rodar testes e desligar tudo.
> Última atualização: 2026-11-21. Hardware de referência: MacBook Pro M4 Pro 48 GB.
> Regra de ouro: **modelos são RESIDENTES** (carga fria 1,5–1,8 s — nunca recarregar por utterance, AGENTS.md §4/L2).

---

## 1. Mapa dos serviços

| Porta | Serviço | O que faz | Modelo residente |
|---|---|---|---|
| **8080** | `omlx-server` (brew, Apache-2.0) | LLM texto, OpenAI-compat (SSE) | LFM3-1.7B-MLX-4bit (tradução, decisão, assistente) |
| **8090** | `python -m mlx_audio.server` | ASR **streaming** OpenAI Realtime subset (`/v1/realtime`) | Voxtral-Mini-4B-Realtime-2602-4bit |
| **8091** | `services/sts-sidecar.py` (nosso) | `POST /tts` (voz EN/PT) + `POST /asr-translate` (tradução nativa por janela) | LFM3-Audio-2B-MLX-8bit |
| **8787** | `apps/web-server.mjs` (nosso, zero-dep) | UI web + host: catálogo, flows, run NDJSON/SSE, gates | — (spawn do runner) |

Nenhum serviço sai para a rede — tudo bind em `127.0.0.1`.

---

## 2. Subir tudo — `faladorctl` (jeito fácil): start · stop · restart · status

```bash
cd "$(git rev-parse --show-toplevel)"   # raiz do checkout (no Mac do dono: ~/ml/falador)
./faladorctl status      # lista TODOS os serviços: omlx asr tts web (pid + o que é + PARADO/✔)
./faladorctl start       # sobe os 4 (espera carga dos modelos; logs em logs/<nome>.log)
./faladorctl stop        # derruba TODOS (SIGTERM; SIGKILL só no teimoso)
./faladorctl restart     # stop → espera porta liberar → start
```

Todos os comandos sempre listam os 4 serviços individualmente. O `status` mostra pid e o comando real de cada um. Sob o capô, o `start` é exatamente os comandos da §3 — os logs caem em `logs/omlx.log`, `logs/asr.log`, `logs/tts.log`, `logs/web.log`.

> Se portas estiverem ocupadas por processos zumbis antigos, o `stop` cuida deles antes do `start`.

---

## 3. Subir manualmente, um a um (ordem importa: LLM → ASR → TTS → host)

Abra um **terminal para cada serviço** (ou use `nohup … &`). Não iniciar dentro do shell agent comum — o processo morre quando o comando termina.

**1) LLM (omlx, :8080)**

```bash
cd "$(git rev-parse --show-toplevel)"
omlx serve --model-dir ~/.omlx/models --host 127.0.0.1 --port 8080
```

> `~/.omlx/models` precisa conter o symlink pro snapshot do HF (`LiquidAI--LFM3-1.7B-MLX-4bit`).
> omlx 0.8.0 NÃO aceita modelo na linha do `serve` — só `--model-dir` (AGENTS.md §4).

**2) ASR streaming (mlx-audio server, :8090)**

```bash
cd "$(git rev-parse --show-toplevel)"
.venv/bin/python .venv/lib/python3.12/site-packages/mlx_audio/server.py \
  --host 127.0.0.1 --port 8090 \
  --realtime-model "$HOME/.cache/huggingface/hub/models--mlx-community--Voxtral-Mini-4B-Realtime-2602-4bit/snapshots/fdebf7b2af834a1db4b8a3c99ab7480b333adf9e"
```

> Só modelos com contrato `StreamingSession` (feed/step/close) funcionam no `/v1/realtime`: **Voxtral** e `voxtral_realtime`. LFM3-Audio NÃO — o WS rejeita com "does not support streaming" (AGENTS.md §4).

**3) TTS + tradução nativa (sidecar, :8091)**

```bash
cd "$(git rev-parse --show-toplevel)"
.venv/bin/python services/sts-sidecar.py \
  --model "$HOME/.cache/huggingface/hub/models--LiquidAI--LFM3-Audio-2B-MLX-8bit/snapshots/000ea4f93adbfdabd4b24295b5e838f6a1f0ffa8" \
  --port 8091
```

Espera ~1,5–1,8 s de carga e imprime `[sts-sidecar] PRONTO`.

**4) Host web + UI (:8787)**

```bash
cd "$(git rev-parse --show-toplevel)"/apps
node web-server.mjs
```

> Antes de subir, se a UI mudou: `cd apps/web && npx vite build` (o host serve `apps/web/dist`).
> O host spawn o runner oficial (`packages/falador-cli/run-flow.mjs`) para cada run.

---

## 4. Verificar que está tudo no ar (saúde)

```bash
curl -s http://127.0.0.1:8080/v1/models | head -c 120   # lista LFM3-1.7B
curl -s http://127.0.0.1:8090/v1/models | head -c 120   # lista Voxtral
curl -s http://127.0.0.1:8091/health                    # {"model": "...", "ready": true}
curl -s http://127.0.0.1:8787/api/catalog | head -c 120 # catálogo de nós
```

Check positivo rápido, ponta a ponta (fala EN → tradução nativa PT, ~1 s):

```bash
curl -s -X POST http://127.0.0.1:8091/tts -H 'Content-Type: application/json' \
  -d '{"text":"Hello, this is a smoke test.","language":"English","voice":"female","sample_rate":24000}' \
  -o /tmp/smoke.wav
python3 - <<'EOF'
import base64, json, urllib.request
wav = open('/tmp/smoke.wav','rb').read()
req = urllib.request.Request('http://127.0.0.1:8091/asr-translate',
  data=json.dumps({'audioB64': base64.b64encode(wav).decode(),
    'instruction': 'Transcribe the audio and translate it to Brazilian Portuguese. Output only the translation, nothing else.',
    'sample_rate': 24000}).encode(), headers={'Content-Type':'application/json'})
print(json.loads(urllib.request.urlopen(req, timeout=60).read()))
EOF
```

---

## 5. Como usar

### 4a. UI web (duas telas — Carbon Design, 2026-11-21)

- **Abrir:** <http://127.0.0.1:8787>
- **Tela 1 — Criação (Builder):** barra superior 100% Carbon (`Dropdown` de workflow + botões `Novo`, `Editar`, `Salvar`, `Modelos`, `Testar Fluxo`, `Iniciar Live` + pill `Live Latency`). Faixa no topo do canvas com nome e descrição completa do workflow (edição via `<Modal>` Carbon). Paleta à esquerda com busca e 7 categorias coloridas (Captura / Transcrição / Pensar / Decidir — inclui `turn.detector` / Falar / Ações & Conectores — `exec.command` / Saída) + grupo Teste recolhível. Cards com seção dedicada de portas alinhadas aos handles e auto-layout sem cruzamentos.
- **Edição INLINE:** clique num nó → o editor abre **ancorado no próprio nó** (acompanha pan/zoom/drag; flipa pro lado se não couber). Abas **Configuração / Regras / Logs**; campos reais com controle certo (dropdown/slider/toggle/textarea/JSON) + helper + default real (incl. `useContext`/BM25 no `llm.omlx`, `emitInterruptOnSpeech`/`maxPendingMs` no `asr.realtime`, `dryRun`/`allowedHosts`/`allowedPrefixes` no `exec.command`).
- **Tela 2 — Execução (Live):** header **LIVE MODE** + cenário + pill **Latência** com breakdown ponta-a-ponta (`trace`: ASR / Turn / LLM TTFT / Decisão / Total) + badge `DRY-RUN` / `EXEC ATIVO` (quando há `exec.command`) + **Limpar contexto** (`POST /api/run/reset-history`) + **Exportar sessão** (`POST /api/session/export` → `.md` em `sessions/` + webhook opt-in) + **Pausar/Retomar** + **Encerrar Sessão**. Card de aprovação (`human.approve`) suporta texto simples e comando estruturado (badges de Host + Risco `d1` + comando monospaced editável). Sidebar **Contexto / Documentos** com **RAG BM25 local** (`.md`, `.pdf`, `.txt`, `.yaml`, `.json` + tags).
- Salvar/carregar flows: `apps/tui/flows/*.json` (host lista via `/api/flows`; descrição dentro do flow).
- **Chatbox (`input.chat`)**: novo nó de entrada por TEXTO (além da voz) — aparece no `LiveView` e no `BuilderView`; envie prompt com Enter → `POST /api/run/chat` → `chat_input` no runner → nós `input.chat` emitem `out`/`parcs`. O botão **«Agente Workflows»** (TopBar) abre o workflow `agente-workflows` com chat+voz+seletor de modelo.

### 4b. Fluxos prontos

| Flow | O que é |
|---|---|
| `assistente-entrevista.json` | **Default (ADR-005/006):** captura SCK (`drop_oldest`, `ttlMs: 1500`) → Voxtral streaming → transcrição → `turn.detector` (`d1`,systemone, fronteira de turno) → assistente LLM → votação `d1` auto/humano → sugestão na tela (auto) ou card editável (humano). Sem TTS = sem eco |
| `legendas-traducao-pt.json` | Tradução simultânea EN → PT em tempo real (~1,1 s): captura SCK → Voxtral streaming → LLM tradutor → legendas PT |
| `transcricao-ao-vivo.json` | Transcrição pura em tempo real (captura SCK → Voxtral streaming → legendas, menor latência) |
| `tradutor-voz-en.json` | Pipeline completo de interpretação por voz: STT → `translate.llm` (PT→EN) → Legenda + TTS EN → Alto-falante |
| `revisao-servidor-ops.json` | **Ops / SRE com risco e HITL (ADR-007, chat-only):** pedido digitado → planejador LLM (`useContext: true`, RAG BM25) → triagem `d1` (`leitura_segura` / `sensivel` / `bloqueado`) → `human.approve` → `exec.command` (`dryRun: true`) → analista LLM → diagnóstico |
| `agente-suporte-ops.json` | **Agente de Suporte multi-step (ADR-008, chat-only):** `input.chat` → `agent.tools` (loop `tool_calls`, `approvalPolicy: "always"`) conectado via porta `tool` a `exec.command` (`dryRun: true`) e `rag.search` (BM25) → diagnóstico. Substitui o antigo `chat-agente-suporte.json` |
| `agente-workflows.json` | **Agente Especialista em Workflows (chat-only):** `input.chat` → `agent.tools` com `tool.workflow` (valida/salva workflows e auto-atualiza o AGENTS.md) + `tool.web_search` (anti-SSRF) → legendas. Botão «Agente Workflows» na TopBar |
| `test/demo-engine` / `test/demo-live` | fixtures de smoke (sintético / integração omlx+sidecar) — em `flows/test/`, fora do dropdown |

> Captura nos flows: `backend: 'sck'`, `input: ''` — **escolha o app da call** no Inspector (Teams, zoom.us, Google Chrome…). SCK ouve SÓ esse app; precisa de permissão de Gravação de Tela (Ajustes → Privacidade e Segurança).

### 4c. Runner headless (sem UI)

```bash
cd "$(git rev-parse --show-toplevel)"
node packages/falador-cli/run-flow.mjs apps/tui/flows/legendas-traducao-pt.json --run-seconds 30
node packages/falador-cli/run-flow.mjs --catalog            # catálogo JSON (23 nós)
```

Eventos saem em NDJSON (`caption` com `trace`, `gate` com metadados estruturados, `run_stopped`, …). Comandos via stdin: `{"type":"gate_action","nodeId":"...","text":"editado ou null"}` e `{"type":"reset_history","nodeId":"*"}`.

### 4d. Testes

```bash
node --test --test-force-exit packages/falador-graph/test/*.test.ts   # motor: 41 testes (1 skip = bug conhecido)
node --test --test-force-exit packages/falador-nodes/test/*.test.ts   # nós: 141 testes (2 skip: N7 mic + gate)
node --test apps/web-server.test.mjs apps/web-server.routes.test.mjs  # host HTTP: 14/14
(cd packages/falador-cli && node --test --test-force-exit test/)       # runner CLI: 9/9
FALADOR_MIC_TEST=1 node --test --test-force-exit packages/falador-nodes/test/nodes.test.ts  # + N7 mic real
cd apps/web && npx tsc --noEmit && npm run build                      # typecheck + build UI
cd apps/web && npx playwright test                                    # E2E (webServer sobe o host)
```

Cobertura (Node 26, nativa):

```bash
(cd packages/falador-graph && node --test --experimental-test-coverage --test-coverage-include='src/**' test/)
(cd packages/falador-nodes && node --test --test-force-exit --experimental-test-coverage --test-coverage-include='src/**' test/)
```

Medido em 2026-11-21: motor **94,4% linhas / 89,0% branches**; nós **86,6% / 70,8%**. Detalhes, mapa do que cada suíte prova e lacunas conscientes em [`docs/testing.md`](docs/testing.md).

---

## 6. Entrada de áudio (captura)

- **Oficial (ADR-005): ScreenCaptureKit por app** — `backend: 'sck'`, input = nome do app da call. Sem Multi-Output, sem BlackHole, sem mudar routing; o dono apagou o Multi-Output em 2026-11-19. Permissão: **Gravação de Tela** (TCC) pro processo que roda o helper. Binário `services/capture-sck` compilado sob demanda do `.swift` (swiftc/CLT).
- **Duas origens no mesmo nó (ADR-009, 2026-11-22):** no Live, a etapa Captura oferece **Aplicações** (`backend:'sck'`) ou **Microfone** (`backend:'sounddevice'`). O device é listado por `GET /api/mics` (`services/capture-sidecar.py --list`); a escolha fica em `localStorage.falador.captureSource`.
- **Botão do microfone:** em fluxos com `input.chat` (ex.: `assistente-entrevista.json`) ele alterna **voz↔chat** — no modo chat, captura/ASR/turn/sink de STT são desabilitados e o `input.chat` alimenta o assistente. Em fluxos sem chat, ele alterna apenas Aplicações↔Microfone.
- Alternativas no mesmo nó: `backend: 'sounddevice'` (PortAudio; input = nome do device, ex. 'BlackHole', 'Microfone' — precisa de algo tocando NO device, ex. Multi-Output) e `backend: 'ffmpeg'` (avfoundation :N — **ffmpeg 9.0.2 perde ~75% dos samples nesta máquina**, AGENTS §4).
- BlackHole 2ch continua instalado — útil p/ injeção de teste ou se a voz na call voltar (playback-sidecar.py pronto, não fiado).
- Cenário 2 em call real: o áudio do entrevistador entra pelo SCK direto do app da call; você lê a sugestão e responde com sua voz.

---

## 7. Derrubar tudo

```bash
./faladorctl stop                # derruba TODOS os 4 (SIGTERM, com SIGKILL de reserva)
# ou manual, porta por porta:
kill $(lsof -ti :8080 :8090 :8091 :8787)
```

Porta por porta (com missão específica):

```bash
kill $(lsof -ti :8091)   # sidecar TTS/tradução
kill $(lsof -ti :8090)   # ASR streaming
kill $(lsof -ti :8080)   # omlx
kill $(lsof -ti :8787)   # host web
```

> Se um run estiver em andamento, é educado primeiro `POST /api/stop` no host (resolve gates pendentes como rejeição e manda SIGKILL no runner) e depois derrubar os serviços.

---

## 8. Verificação antes de commit

```bash
(cd packages/falador-graph && node --test test/) || exit 1
(cd packages/falador-nodes && node --test --test-force-exit test/) || exit 1
node --test apps/web-server.test.mjs || exit 1
(cd packages/falador-cli && node --test --test-force-exit test/) || exit 1
node --test apps/web-server.routes.test.mjs || exit 1
(cd apps/web && npx tsc --noEmit && npm run build) || exit 1
(cd apps/web && npx playwright test) || exit 1
```

Se o diff toca um nó, o teste correspondente deve falhar antes da correção e passar depois. Suíte verde sem esse ciclo não prova comportamento novo.

## 9. Armadilhas (resumo — detalhes em AGENTS.md §4/§5)

- LLM no omlx **SEMPRE** com `chat_template_kwargs: {"enable_thinking": false}` (senão `content` vem vazio; só `reasoning_content`). Nós `llm.omlx`/`decision.llm` já mandam por default (`enableThinking`).
- TTS sidecar sai em 24 kHz mesmo pedindo 16 k — para `/asr-translate`, o `sample_rate` do body deve ser o **real do WAV**.
- WS `/v1/realtime` só aceita modelo com `StreamingSession` (Voxtral). LFM3-Audio não.
- Porta ocupada por processo zumbi: `lsof -ti :PORTA | xargs kill`.
- Run do host "já em andamento" (409): use `POST /api/stop` (runner child morre 300 ms pós summary).
- N7 precisa de `FALADOR_MIC_TEST=1` e ffmpeg do homebrew; ruido no diagnóstico do ASR ao vivo → isole com cliente standalone puro antes de suspeitar do protocolo.
