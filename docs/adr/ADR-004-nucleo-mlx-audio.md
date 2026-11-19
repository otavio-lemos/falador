# ADR-004 — Núcleo de áudio = mlx-audio; Registro de modelos e seleção

**Status:** ACEITO 2026-11-18 (direção ditada pelo usuário; seletores/downloads/"?"/recomendado exigidos por ele)
**Depende de:** ADR-002 (runtimes), ADR-003 (workflow engine)
**Evidência:** [research/mlx-audio-analise.md](research/mlx-audio-analise.md) (fonte primária, verificada 2026-11-18)

## Decisões

| # | Decisão | Detalhe |
|---|---|---|
| E1 | **Integração primária de áudio/ML = `mlx-audio` (Neywa-Labs, MIT)** | Hospeda o LFM3-Audio-2B (D6 intacto) com API unificada asr/tts/sts + servidor OpenAI-compat c/ `/v1/realtime` (WS) + VAD de servidor + `InferenceBroker`. Medido no M4 Pro: ASR RTF 0,05; TTS EN 3,6× rt; TTS PT 4,9× rt |
| E2 | **Contrato da porta de áudio do motor = `StreamingSession`** (`feed`/`step`/`close`/`done`/`input_sample_rate` + `transcription_delay_ms`) | Protocol já existe na lib; nós do grafo falamm esse idioma: porta `pcm16k` → `feed`; parciais → `step` |
| E3 | **Seleção de modelo por nó (dropdown) — download é por conta do usuário** | O dropdown lista SOMENTE modelos instalados localmente (registro local via `registry.py` do mlx-audio + modelos do omlx). Sem loja de download no Falador v1 |
| E4 | **Sempre um modelo marcado como "recomendado"** por papel (STT/LLM/TTS) | Badge no dropdown; default do perfil |
| E5 | **Botão "?" em cada seletor → abre a página GitHub do modelo** | Link direto ao README/prints/especificação — usuário verifica antes de baixar |

## Consequências

- v1 usa a **Python API in-process** do mlx-audio nos serviços residentes (escuta/fala); o servidor WS (`/v1/realtime`) fica como deploy alternativo — não bloqueante.
- O registro local de modelos é alimentado por duas fontes: modelos do mlx-audio (HF cache) e modelos do omlx (model dir) — mapeados por papel.
- O bridge de streaming de fala (G3) continua sendo código nosso sobre `stream_slots` (G3b valida qualidade incremental depois de G1/G2).
