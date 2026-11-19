# run.md — Guia de operação do Falador (subir · usar · derrubar)

> Como subir todos os serviços, acessar a UI, rodar testes e desligar tudo.
> Última atualização: 2026-11-19. Hardware de referência: MacBook Pro M4 Pro 48 GB.
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
cd /Users/otaviolemos/ml/falador
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
cd /Users/otaviolemos/ml/falador
omlx serve --model-dir ~/.omlx/models --host 127.0.0.1 --port 8080
```

> `~/.omlx/models` precisa conter o symlink pro snapshot do HF (`LiquidAI--LFM3-1.7B-MLX-4bit`).
> omlx 0.8.0 NÃO aceita modelo na linha do `serve` — só `--model-dir` (AGENTS.md §4).

**2) ASR streaming (mlx-audio server, :8090)**

```bash
cd /Users/otaviolemos/ml/falador
.venv/bin/python .venv/lib/python3.12/site-packages/mlx_audio/server.py \
  --host 127.0.0.1 --port 8090 \
  --realtime-model "$HOME/.cache/huggingface/hub/models--mlx-community--Voxtral-Mini-4B-Realtime-2602-4bit/snapshots/fdebf7b2af834a1db4b8a3c99ab7480b333adf9e"
```

> Só modelos com contrato `StreamingSession` (feed/step/close) funcionam no `/v1/realtime`: **Voxtral** e `voxtral_realtime`. LFM3-Audio NÃO — o WS rejeita com "does not support streaming" (AGENTS.md §4).

**3) TTS + tradução nativa (sidecar, :8091)**

```bash
cd /Users/otaviolemos/ml/falador
.venv/bin/python services/sts-sidecar.py \
  --model "$HOME/.cache/huggingface/hub/models--LiquidAI--LFM3-Audio-2B-MLX-8bit/snapshots/000ea4f93adbfdabd4b24295b5e838f6a1f0ffa8" \
  --port 8091
```

Espera ~1,5–1,8 s de carga e imprime `[sts-sidecar] PRONTO`.

**4) Host web + UI (:8787)**

```bash
cd /Users/otaviolemos/ml/falador/apps
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

### 4a. UI web (canvas — o jeito principal)

- **Abrir:** <http://127.0.0.1:8787>
- Paleta à esquerda: arraste os nós para o canvas (catálogo dinâmico — sempre reflete os nós registrados, incluindo `asr.lfm3` e `decision.llm`).
- Clique num nó → **Inspector**: `enabled`, params (promopts em textarea, `template`/`options` como JSON), dropdown de modelos do registro (★ RECOMENDADO = medido; "?" abre o GitHub/HF do modelo selecionado).
- **Run** → eventos ao vivo (legendas parciais/finais). Gate `human.approve` abre card com sugestão editável → Aprovar/Rejeitar.
- **Métricas por nó ao vivo (fase 3)**: durante o run, cada nó mostra badge `↓in ↑out · p50ms` (azul, monospace); clique no nó → Inspector → "Métricas do run" com timers/counters nomeados (`llm.omlx.ttftMs`, `tts.sts.ms`, `decision.llm.<opção>`…). Snapshot final também vai no `summary`.
- **Perfis de Run (W8)**: seletor `perfil:` acima do ▶ Capturar. `✚` fotografa os params atuais de todos os nós como perfil nomeado (persiste em `profiles:` no flow JSON). Ao rodar com perfil, os overrides são aplicados SÓ naquela execução — o grafo salvo não muda. `(padrão do grafo)` = sem override.
- Salvar/carregar flows: `apps/tui/flows/*.json` (o host lista via `/api/flows`).

### 4b. Fluxos prontos

| Flow | O que é |
|---|---|
| `cenario1-pt.json` | Cenário 1 estrutura: BlackHole → Voxtral streaming → tradução via omlx → legendas (~1,1 s) |
| `cenario1-lfm3.json` | Cenário 1 nativo: BlackHole → `asr.lfm3` (janela 12 s) → legendas PT (~15× rt, NÃO streaming) |
| `cenario2-auto.json` | Cenário 2: ASR → assistente LLM → decisão auto/humano → TTS EN → playback; gate humano na UI |
| `demo-engine` / `demo-live` | smoke sintético / integração omlx+sidecar |

### 4c. Runner headless (sem UI)

```bash
cd /Users/otaviolemos/ml/falador
node packages/falador-cli/run-flow.mjs apps/tui/flows/cenario1-lfm3.json --run-seconds 30
node packages/falador-cli/run-flow.mjs --catalog            # catálogo JSON
```

Eventos saem em NDJSON (`caption`, `run_stopped`, …). `sink.captions` sem binding ganha `__onCaption` automático. Gates recebem JSON via stdin: `{"type":"gate_action","nodeId":"...","text":"editado ou null"}` — no stop, gates pendentes viram rejeição.

### 4d. Testes

```bash
cd packages/falador-graph && npm test            # motor: 12/12
cd packages/falador-nodes && npm test            # nós: 9/9 (N10 das lives usa :8091 real)
FALADOR_MIC_TEST=1 npm test                      # + N7 com mic real (avfoundation :1)
cd apps/tui && ../../.venv/bin/python smoke.py   # TUI (Textual) smoke
```

---

## 6. Entrada de áudio (BlackHole)

- Saída do sistema deve ser o **"Dispositivo com Saída Múltipla"** (Alto-falantes + BlackHole, clock = Alto-falantes) — configurado no Audio MIDI Setup (provado com mídia real, AGENTS.md §2/§4). **ATENÇÃO (2026-11-19): o output default driftou p/ "Alto-falantes (MacBook Pro)"** — Multi-Output existe mas está só como "Default System Output"; assim o BlackHole fica mudo e a captura não recebe a conferência. Restaurar em Ajustes → Som → Saída (ou Audio MIDI Setup). Conferir: `system_profiler SPAudioDataType | grep -B1 "Default Output Device: Yes"`.
- Índice AVFoundation em uso: **`:0` = BlackHole 2ch**, `:1` = mic MBP. Para conferir os índices atuais: `ffmpeg -f avfoundation -list_devices true -i ""`.
- Cenário 2 em call real: o áudio do entrevistador entra pelo BlackHole (laço do sistema), igual ao Cenário 1.

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

## 8. Armadilhas (resumo — detalhes em AGENTS.md §4/§5)

- LLM no omlx **SEMPRE** com `chat_template_kwargs: {"enable_thinking": false}` (senão `content` vem vazio; só `reasoning_content`). Nós `llm.omlx`/`decision.llm` já mandam por default (`enableThinking`).
- TTS sidecar sai em 24 kHz mesmo pedindo 16 k — para `/asr-translate`, o `sample_rate` do body deve ser o **real do WAV**.
- WS `/v1/realtime` só aceita modelo com `StreamingSession` (Voxtral). LFM3-Audio não.
- Porta ocupada por processo zumbi: `lsof -ti :PORTA | xargs kill`.
- Run do host "já em andamento" (409): use `POST /api/stop` (runner child morre 300 ms pós summary).
- N7 precisa de `FALADOR_MIC_TEST=1` e ffmpeg do homebrew; ruido no diagnóstico do ASR ao vivo → isole com cliente standalone puro antes de suspeitar do protocolo.
