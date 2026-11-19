# Análise profunda — mlx-audio (Neywa-Labs) — 2026-11-18

**Fonte:** https://github.com/Neywa-Labs/mlx-audio (verificada hoje via API GitHub + código-fonte)
**Licença:** MIT · **Stars:** 8.301 · Push: 2026-11-18 · Releases regulares (v0.6.6, 2026-11-16) · Criado 2024-11

## Veredicto executivo

O usuário está certo: **o mlx-audio já entrega quase todo o substrato de áudio/ML do Falador.** Ele é a integração primária da v1. O que sobra para o Falador é exatamente o que não é motor de áudio: **grafo de workflow, captura de dispositivo, legendas, LLM técnico no meio, gerência de modelos e UI.**

## O que o mlx-audio TEM (por camada)

### 1. Núcleo do Falador (D6 intacto)
- **LFM3-Audio-2B** oficialmente suportado (`sts/models/lfm3_audio/`) — asr/tts/sts/chat com API simples (`model.generate(..., task=...)`). Checkpoints bf16/8bit/4bit da LiquidAI.
- Medido HOJE no M4 Pro (8-bit): ASR RTF 0,05 · TTS EN 3,6× rt · **TTS PT 4,9× rt** · carga 1,5 s.
- `stream_slots` no model deles também rende frame a frame (mesma base do port mlx-vlm).

### 2. Servidor de áudio pronto (`mlx_audio/server.py`)
- FastAPI com API **compatível OpenAI**: `POST /v1/audio/speech` (TTS), `POST /v1/audio/transcriptions` (STT), `GET /v1/audio/voices`, **CRUD `/v1/models`** (carregar/descarregar/listar — base pronta p/ o seletor!), `POST /v1/audio/separations`.
- **`WS /v1/realtime` — compatível com o OpenAI Realtime API (subset)**: `session.update`, `input_audio_buffer.append/commit`, eventos `transcription.delta/.completed`, **VAD de servidor (Silero) com auto-commit de turnos** (`turn_detection: server_vad`) — i.e., o servidor DETECTA sozinho fim de fala e emite transcrição.
- `InferenceBroker` — broker de inferência para múltiplos modelos (base p/ multi-instância).
- `tts/continuous.py` — batching contínuo de TTS.

### 3. Protocolo de streaming (o contrato das nossas portas)
- `mlx_audio/stt/streaming.py`: `StreamingSession` = `feed(samples: float32 ndarray)` / `step(max_decode_tokens) -> list[str]` (parciais!) / `close()` / `done` / `input_sample_rate` (+ `transcription_delay_ms` ajustável).
- Serve **qualquer** modelo STT que exponha esse protocolo (Voxtral Realtime nativo; VibeVoice-ASR chunk streaming; Nemotron RNNT 80–560 ms; Parakeet/Canary — Atlas 25 línguas EU incl. PT).
- **Este Protocol é exatamente o formato da porta `pcm16k` do motor de grafo do ADR-003.** Adotar como contrato do nó de captura→STT.

### 4. Extras já resolvidos
- `realtime_vad.py` — VAD de streaming no servidor (Silero) — o Falador não precisa importar Silero.
- `lid/` — identificação de idioma.
- `registry.py` — classificação de modelos (tts/stt/sts) sem importar MLX.
- `audio_io` — leitura/escrita/resample integrado.
- `ui/` — playground Next.js demo (TTS/STT/separação) — **não** é workflow configurável; serve de referência, não de produto.

## O que SOBRA para o Falador (nosso esCopos — nada muda no desenho)

| Gap | Onde está coberto no desenho |
|---|---|
| Captura de áudio real (mic + BlackHole/Multi-Output, 16 kHz) | Nós `MicCapture`/`SysAudioCapture` (G1 em validação) |
| Grafo de workflow editável ("nada fixo") + TUI + UI React Flow/Carbon | ADR-003 (ACEITO) |
| Legendas em tempo real (painel/camada de exibição) | Nós `SinkCaptions` |
| LLM técnico no meio (cenário 2) + streaming de tokens | Nós `LLM` via omlx (G2 pendente) |
| Gerência de modelos: dropdown local + **badge "recomendado"** + botão **"?"→GitHub do modelo** + download por conta do usuário | Registro local alimentado pelo que está instalado (mlx-audio + omlx); nossa UI com Carbon |
| Perfis de execução (binding STT/LLM/TTS no Run) | ADR-003 W8 |
| 2 instâncias Audio-2B (escuta/fala) residentes | D8 + L2 (serviço residente) |

## Riscos / não verificados

- `/v1/audio/speech` com streaming real de chunks de áudio: NÃO VERIFICADO (checar `StreamingResponse` no server.py durante G4).
- LFM3-Audio-2B não expõe StreamingSession nativa p/ `/v1/realtime` (nossos parciais de script dependem do bridge `stream_slots` — G3b valida qualidade incremental).
- `webrtcvad` no server (pip legado) — verificar compat macOS/Python 3.12 no deploy.

## Nota de decisão (para ADR-004)
- Integração primária de áudio = **mlx-audio** (MIT) — v1 usa Python API in-process nos nós residentes; modo servidor (`WS /v1/realtime`) como deploy alternativo (não bloqueante).
- Seletor de modelo = registro local; download é responsabilidade do usuário; **recomendado sempre marcado**; **"?" abre a página GitHub do modelo**.
