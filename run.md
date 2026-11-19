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

### 4a. UI web (duas telas — rebuild do layout do dono, 2026-11-19)

- **Abrir:** <http://127.0.0.1:8787>
- **Tela 1 — Criação (Builder):** barra superior (título + seletor de flow + salvar + pill `Live Latency` + **Testar Fluxo** / **Iniciar Live**). Paleta à esquerda com busca e 6 categorias coloridas (Captura/Transcrição/Pensar/Decidir/Falar/Saída) + grupo Teste recolhível; arraste um nó pro canvas (ou duplo clique). Canvas React Flow com cards de header colorido por categoria, conexões tracejadas + ramos coloridos rotulados (auto/humano), minimap e zoom.
- **Edição INLINE:** clique num nó → o editor abre **ancorado no próprio nó** (acompanha pan/zoom/drag; flipa pro lado se não couber; fecha clicando no canvas ou no ×). Abas **Configuração / Regras / Logs**; campos reais de cada nó com o controle certo (dropdown/slider/toggle/textarea/JSON) + texto de ajuda e **default real**. Não há painel direito fixo.
- **Tela 2 — Execução (Live):** header **LIVE MODE** + cenário + pill **Latência** + **Pausar/Retomar** + **Encerrar Sessão**. Transcrição ao vivo do entrevistador; **dropdown por etapa do workflow** (Captura=app, ASR=modelo, LLM=modelo, Gate=Manual/Auto, Voz=voz quando o flow tem TTS) — trocar uma etapa atualiza o param REAL do nó e reinicia a sessão (motor não faz hot-swap). Sugestão **HERO verde** (o que você lê pra falar) + **Regerar / Editar / Aprovar & Falar** (gate humano). Sidebar **Contexto & Cheatsheet**: dicas STAR/atenção (reais); RAG de documentos + tópicos automáticos ainda NÃO conectados; status real de captura (app + atividade).
- **Testar Fluxo** roda o flow na própria tela de criação (métricas/latência ao vivo nos nós e no pill).
- Salvar/carregar flows: `apps/tui/flows/*.json` (host lista via `/api/flows`; descrição dentro do flow).

### 4b. Fluxos prontos

| Flow | O que é |
|---|---|
| `cenario1-pt.json` | Cenário 1 estrutura: captura SCK do app da call → Voxtral streaming → tradução via omlx → legendas (~1,1 s) |
| `cenario1-lfm3.json` | Cenário 1 nativo: captura SCK → `asr.lfm3` (janela 12 s) → legendas PT (~15× rt, NÃO streaming) |
| `cenario2-auto.json` | **Cenário 2 SÓ-TEXTO (ADR-005)**: captura SCK → ASR → assistente LLM → votação d1 auto/humano → sugestão na tela (auto) ou card editável (humano). **Você fala.** Sem TTS = sem eco |
| `demo-engine` / `demo-live` | smoke sintético / integração omlx+sidecar |

> Captura nos flows: `backend: 'sck'`, `input: 'Teams'` — **troque pro seu app da call** no Inspector (zoom.us, Chrome p/ Meet…). SCK ouve SÓ esse app; precisa de permissão de Gravação de Tela (Ajustes → Privacidade e Segurança). O app pode ser aberto DEPOIS do run (o helper espera 30 s).

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

## 6. Entrada de áudio (captura)

- **Oficial (ADR-005): ScreenCaptureKit por app** — `backend: 'sck'`, input = nome do app da call. Sem Multi-Output, sem BlackHole, sem mudar routing; o dono apagou o Multi-Output em 2026-11-19. Permissão: **Gravação de Tela** (TCC) pro processo que roda o helper. Binário `services/capture-sck` compilado sob demanda do `.swift` (swiftc/CLT).
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

## 8. Armadilhas (resumo — detalhes em AGENTS.md §4/§5)

- LLM no omlx **SEMPRE** com `chat_template_kwargs: {"enable_thinking": false}` (senão `content` vem vazio; só `reasoning_content`). Nós `llm.omlx`/`decision.llm` já mandam por default (`enableThinking`).
- TTS sidecar sai em 24 kHz mesmo pedindo 16 k — para `/asr-translate`, o `sample_rate` do body deve ser o **real do WAV**.
- WS `/v1/realtime` só aceita modelo com `StreamingSession` (Voxtral). LFM3-Audio não.
- Porta ocupada por processo zumbi: `lsof -ti :PORTA | xargs kill`.
- Run do host "já em andamento" (409): use `POST /api/stop` (runner child morre 300 ms pós summary).
- N7 precisa de `FALADOR_MIC_TEST=1` e ffmpeg do homebrew; ruido no diagnóstico do ASR ao vivo → isole com cliente standalone puro antes de suspeitar do protocolo.
