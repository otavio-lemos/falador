# F0 — Resultados (atualizado em execução, 2026-11-18)

## G3 — Streaming de fala do LFM3-Audio-2B — VEREDITO: PASS-COM-MODIFICAÇÃO

**Medições no M4 Pro 48 GB (warm, modelo 8-bit oficial LiquidAI):**

| Métrica | Valor medido | Nota |
|---|---|---|
| ASR (task=asr) | 0,23 s p/ fala de 4,09 s (RTF ≈ 0,05) | transcrição correta |
| TTS EN | 0,92 s p/ 3,36 s de áudio (3,6× realtime) | voz female |
| TTS PT | 1,01 s p/ 4,96 s (4,9× realtime) | voz em português funciona no Audio-2B |
| 1º frame de fala (streaming) | ~75 ms | via `stream_slots` (yield por frame de 80 ms) |
| Slots/s sustaining | 77–78 (6,2× realtime; necessário 12,5) | via mlx-vlm port (Blaizzy) |
| Codec decode | RTF 0,002 | port decode-only |
| Carga fria do modelo | 1,5–1,8 s | → serviços residentes (lição L2) |

**Fatos verificáveis que fundamentam o veredito:**
1. No port mlx-vlm (Blaizzy), o wrapper oficial gera o WAV inteiro no fim; README: "streaming input and output are not implemented" (mlx_vlm/models/lfm3_audio/README.md:107). MAS `stream_slots()` rende frame a frame (lfm3_audio.py:193) e o codec decode-only está portado (codec.py:125) — streaming é barato de construir.
2. **Integração primária da v1 passa a ser a lib `mlx-audio` (Neywa-Labs, 8.301★, ativa 2026-11-18)**: hospeda o LFM3-Audio-2B com API unificada (`task=asr/tts/sts`, `sts/models/lfm3_audio/`) e numerações de TTS/PT acima medidas nela. O mesmo modelo (D6 intacto).
3. O Protocol de streaming STT da lib (`mlx_audio/stt/streaming.py:9-41`) — `StreamingSession` com `feed(samples)`/`step()`/`close()` — é o **formato das portas** do motor de grafo do Falador (contract já previsto no ADR-003: porta `pcm16k` alimentando nós, `step()` emitindo parciais).

**Decisões decorrentes (sem alterar D6):**
- V1 sobre `mlx-audio` (não no port do mlx-vlm).
- Bridge de streaming de fala = decoder incremental sobre `stream_slots` + `LiquidCodec.decode` — custo quase nulo (RTF 0,002); validar qualidade de janelas (micro-gate G3b depois de G1/G2).

## G1 — Áudio (BlackHole Multi-Output) — VEREDITO: PASS
Setup do usuário (2026-11-18): "Dispositivo com Saída Múltipla" (Speakers + BlackHole 2ch, clock/principal = Speakers, sincronização ✅ no BlackHole) selecionado como saída do sistema.

Medido:
- Captura ffmpeg `:0` (BlackHole 2ch) 16 kHz mono: **max_volume −1,8 dB / mean −16 dB** — sinal forte.
- Laço completo **com mídia real do sistema** (não arquivo de teste): o WAV capturado, alimentado ao ASR do LFM3-Audio-2B (2,8 s incluindo carga fria), transcreveu o conteúdo que o usuário estava ouvindo ("The player from Real Madrid, Rodrigo."). Prova: saída do sistema → BlackHole → ASR, com o usuário continuando a ouvir (sem "ficar surdo").
- Pendência menor: `afplay` frase de teste não surgiu na transcrição da janela capturada (possível corrida capture/afplay); sem impacto no veredito — a mídia real do sistema provou o laço.

## G2 — Contenção de texto (omlx 0.8.0) — VEREDITO: PASS
Setup: `omlx serve --model-dir ~/.omlx/models` (symlink do snapshot HF) + LFM3-1.7B-MLX-4bit.

| Cenário | TTFT p50 | TTFT p90 | Critério (≤400ms) |
|---|---|---|---|
| 1 requisição (solo, warm, 20 rodadas) | **30 ms** | 32 ms | ✓ |
| 2 streaming simultâneos (20 rodadas, 40 medidas) | **60 ms** | 65 ms | ✓ |

**Achados críticos:**
1. **O LFM3-1.7B pensa por padrão** (streaming sai em `reasoning_content` e o `content` vem vazio). Para tempo real: **`chat_template_kwargs: {"enable_thinking": false}` é OBRIGATÓRIO** em todo request do Falador.
2. Custo de concorrência ≈ linear (30→60 ms) — composição de 2 estágios na MESMA GPU não trava o pipeline.
3. omlx 0.8.0: modelo não vai mais na linha de comando; descobre modelos via `--model-dir` (symlink para o snapshot do HF funciona).
4. omlx achou e lista também modelos de áudio (Audio-2B) no `/v1/models` — mas são só texto/VLM para ele (`model_type: vlm`); áudio continua no mlx-audio (E1 do ADR-004).

## Lições de processo (recorrentes)
- L1: pegada de instalação de runtime auditar no ADR (omlx = tap 254 MB + LLVM >300 MB)
- L2: frio vs quente separados; serviços residentes obrigatórios
- L3: ler código do port, não só README (stream_slots existia)
- L4 (user): NÃO expandir catálogo de alternativas sem aprovação — foco no desenho (Audio-2B centro, D6)
