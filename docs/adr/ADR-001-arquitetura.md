# ADR-001 — Arquitetura · Falador (tradução simultânea em conferências)

> **Status:** Decidido (2026-11-18) · **Decisor:** Otávio Lemos · **Escopo:** v1, uso pessoal, Apple Silicon

## 1. Problema

Conversas em conferência (Teams, Zoom, Meet, WhatsApp) onde A fala um idioma e B fala outro.
O Falador transcreve, traduz em tempo real (legendas) e responde por voz no idioma do outro participante.
Cenário extra: entrevista/help — traduzir **e** dar sugestões técnicas ao usuário enquanto ele acompanha.

## 2. Decisões tomadas (ADR)

| # | Decisão |
|---|---|
| D1 | Áudio capturado/reproduzido pelos **dispositivos padrão do notebook** (mic + alto-falantes). Sem BlackHole, sem bot participante na v1 |
| D2 | Voz TTS sai pelo som do notebook (uso pessoal; não há canal de intérprete na reunião) |
| D3 | **Idiomas selecionáveis** na UI; v1 valida EN↔PT-BR |
| D4 | Hardware alvo: **M4 Pro 48 GB** |
| D5 | Licença: **LFM Open License v1.0** aceitável (uso pessoal; limite comercial = receita < US$ 10M — https://www.liquid.ai/lfm-license) |
| D6 | **LFM3-Audio-2B (MLX) para escuta e fala na v1** — STT, tradução e TTS num modelo só, rodando em **2 instâncias** (escuta + fala) |
| D8 | **Cenário 2 (entrevista) = 3 processos**: ESCUTA (Audio-2B) + **ASSISTENTE (LFM3-1.7B, texto)** + FALA (Audio-2B). O assistente é processo próprio — **a escuta é o caminho crítico de latência e nunca pode serrarse para raciocinar** |
| D7 | Cada etapa do pipeline é **plugável por interface** (STT/TRAD/TTS trocáveis por config) — o whisper.cpp volta como opção de STT se o lag do modo D6 se mostrar pior na prática |

## 3. Arquitetura

```
┌────────────────────────── FALADOR (app local, macOS, M4 Pro 48GB) ───────────────────────────┐
│                                                                                               │
│  CAPTAÇÃO (D1)                  NÚCLEO DE STREAMING                    SAÍDA                  │
│  ┌──────────────┐  PCM 16kHz   ┌───────────────────────┐                                │
│  │ mic padrão   │────────────► │ VAD (Silero v5, ONNX, │                                │
│  │ (outros      │              │ CPU — não compete GPU)│                                │
│  │  participantes│             └──────────┬────────────┘                                │
│  │  via alto-    │                       ▼  segmento de fala (utterance)                  │
│  │  falante)     │          ┌─ PROC. 1: ESCUTA (LFM3-Audio-2B) ────┐   ┌───────────────┐     │
│  └──────────────┘          │ áudio → texto PT (stream, legenda)   │   │ UI: legendas  │     │
│                            │         + áudio PT (LiquidCodec)     │──►│  por segmento │     │
│                            └──────────────┬───────────────────────┘   └───────────────┘     │
│                                           │ cada segmento confirmado                        │
│                                           ▼                                                 │
│                            ┌─ PROC. 2: ASSISTENTE (LFM3-1.7B) ────┐   ┌───────────────┐     │
│                            │ cenário 2 (entrevista):              │   │ UI: painel de │     │
│                            │ re-gera sugestão de resposta técnica │──►│  sugestão     │     │
│                            │ em PT (streaming, prompt-cache do    │   │  (B edita/    │     │
│                            │ prefixo da conversa p/ TTFT baixo)   │   │   aprova)     │     │
│                            └──────────────┬───────────────────────┘   └───────┬───────┘     │
│                                           │ texto PT escolhido/                │            │
│                                           │ digitado por B                     │            │
│                                           ▼                                    │            │
│                            ┌─ PROC. 3: FALA (LFM3-Audio-2B) ───────┐          │            │
│                            │ texto PT → fala EN (streaming,        │◄─────────┘            │
│                            │ LiquidCodec; cenário 1 usa B=ON/BD)   │                       │
│                            └───────────────────────────────────────┘                       │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Modelos (menu plugável — D6/D7)

| Papel | Padrão v1 | Alternativas plugáveis |
|---|---|---|
| STT+S2ST (Proc. 1 escuta / Proc. 3 fala) | **LiquidAI/LFM3-Audio-2B-MLX-4bit** — PT nas 2 direções, 1º áudio ~140 ms, ~280 tok/s em M4 Max; docs: https://docs.liquid.ai/lfm/models/lfm3-audio-2b · https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-bf16 | whisper.cpp large-v3-turbo (Metal, parcial de legenda): https://github.com/ggml-org/whisper.cpp · Parakeet v3/FluidAudio: https://github.com/FluidInference/FluidAudio · Qwen3-ASR MLX: https://github.com/moona3k/mlx-qwen3-asr |
| Assistente técnico (Proc. 2) | **LFM3-1.7B** (texto, 256K ctx, tool calling; ~119 tok/s decode em MLX): https://docs.liquid.ai/lfm/models/lfm3-1.7b · https://github.com/ml-explore/mlx-lm/issues/2016 | Qwen3-1.7B, cualquier servidor OpenAI-compatible local; o próprio Audio-2B em modo texto (menos indicado: ocuparia a voz do processo de escuta) |
| TTS | LiquidCodec (dentro do Audio-2B, streaming nativo) | Kokoro-82M (3 vozes pt-BR, Apache-2.0): https://github.com/hexgrad/kokoro · Chatterbox Multilingual (MIT, clone de voz; repo arquivado): https://github.com/resemble-ai/chatterbox |
| Runtime LLM | **LM Studio headless** (`lms server start`, API OpenAI /v1 + SSE) ou `mlx-openai-server` (pip) | llama.cpp `llama-server` (LFM3 precisa v0.8.0+): https://docs.liquid.ai/deployment/on-device/llama-cpp · Ollama `lfm3`: https://ollama.com/library/lfm3 |

Ports MLX da comunidade (quants 3/4/5/6/8-bit + bf16): https://huggingface.co/models?search=LiquidAI/LFM3-Audio-2B-MLX · coleção nativ-community LFM3.

### Interfaces do pipeline (garantem D7 — plugabilidade)

```
AudioSource → (PCM 16 kHz, stream) → VAD → Segment{áudio, lang}
Segment     → SttPort  → {texto, stream de tokens parciais}
Texto       → TranslatorPort → {textoTraduzido}
Traduzido   → TtsPort  → {stream de áudio}
Legendas/UI → consome os streams (1º token = 1º traço de legenda)
Cada Port = provider/modelo via config — troca de modelo nunca toca código.
```

A instância "escuta" (Proc. 1), o assistente (Proc. 2) e a instância "fala" (Proc. 3) rodam em **processos separados** com filas próprias (custo total ≈ 4–7 GB em 4-bit — folga larga nos 48 GB). O assistente usa **prompt-cache do prefixo da conversa**: a cada segmento novo do entrevistador ele só processa o sufixo (TTFT baixo) e re-streama a sugestão — B usa a v1 como WYSIWYT: edita ou aprova; aprovar envia ao Proc. 3.

## 4. Riscos registrados (aceitos na decisão)

| Risco | Mitigação |
|---|---|
| Legenda só aparece no fim da fala (Audio-2B não gera parcial em tempo real) | D7: a porta STT aceita plug de whisper.cpp/WhisperLiveKit depois (parciais: https://github.com/QuentinFuxa/WhisperLiveKit) |
| Mic captura o alto-falante (eco/ruído) degrada STT | VAD calibrado + ganho; BlackHole continua sendo upgrade plugável sem mudar o pipeline |
| Um modelo não escuta e fala ao mesmo tempo | 3 processos separados (D8): escuta nunca competindo com raciocínio/fala |
| Assistente re-gera a cada segmento — TTFT do LFM3-1.7B pode virar gargalo | Verificar prefill/KV-cache na F0; debounce + prompt-cache do prefixo; fallback: modelo menor/menor frequency de re-geração |
| S2ST EN→PT do Audio-2B sem benchmark público verificado | Teste A/B na Fase 0 antes de destravar idiomas extras; SimulEval (Average Lagging): https://github.com/facebookresearch/SimulEval |
| Streaming de áudio de saída no runtime MLX precisa ser validado | Fase 0 é justamente o POC disso |

## 5. Fases

- **F0 — POC de viabilidade (1-2 dias):** LM Studio / `mlx-openai-server` + LFM3-Audio-2B 4-bit + LFM3-1.7B 4-bit, **3 processos simultâneos**; medir no M4 Pro: lag real S2ST EN→PT, tok/s decode+prefill (critical: TTFT do assistente com prompt-cache), time-to-first-audio, RAM e contenção de GPU entre os 3. **Gargalo crítico:** confirmar que no MLX a fala realmente streama.
- **F1 — Esqueleto do pipeline** (AudioSource, VAD, Ports, orquestrador, 3 processos).
- **F2 — UI de legendas + campo de resposta** (D3: seletor de idiomas).
- **F3 — Modo entrevista (cenário 2)**: assistente LFM3-1.7B + painel de sugestão editável → aprovar envia ao proc. de fala (é o cenário mais complexo, por isso vira fase **plena**, não "extra").
- **F4 — Bench SimulEval + plug whisper.cpp no STT** (re-decidir D6/D7 com dados).

## 6. Fontes primárias

- Modelos LiquidAI LFM3: https://huggingface.co/LiquidAI · https://docs.liquid.ai/lfm/models/lfm3-audio-2b · https://docs.liquid.ai/lfm/models/lfm3-omni-2b · https://huggingface.co/blog/LiquidAI/lfm3
- Licença: https://www.liquid.ai/lfm-license
- Runtimes Apple Silicon: https://lmstudio.ai/docs/developer/openai-compat · https://github.com/ml-explore/mlx-lm/issues/2016 · https://docs.liquid.ai/deployment/on-device/llama-cpp
- Pipelines de referência: https://github.com/pipecat-ai/pipecat · https://github.com/huggingface/speech-to-speech · https://github.com/collabora/WhisperLive · https://github.com/QuentinFuxa/WhisperLiveKit · https://github.com/ufal/whisper_streaming
- Métricas: https://github.com/facebookresearch/SimulEval
