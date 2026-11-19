# G3b — Qualidade do decode incremental (janelas vs completo) — RESULTADOS

> Data: 2026-11-19 · M4 Pro 48 GB · server mlx-audio :8090 (Voxtral-Mini-4B-Realtime-2602-4bit), warm
> Método: `scripts/g3b-decode.mjs` — MESMO áudio de referência (gerado pelo sidecar TTS :8091, 24 kHz mono, convertido p/ 16k s16le p/ streaming), MESMO modelo, dois caminhos:
> - **Offline** (baseline): `POST /v1/audio/transcriptions` (decode completo)
> - **Streaming** (produção): WS `/v1/realtime`, frames de 100 ms @16k, `server_vad` Silero, lookahead 8

## Referência

- EN: "Effective caching in inference engines depends on prefill length, KV layout, and the residency of the model in unified memory." (8,48 s)
- PT: "Caching eficaz em engines de inferência depende do tamanho do prefill, do layout de KV e da residência do modelo na memória unificada." (9,28 s)

## Resultados (WARM, MEDIDOS — não re-estimar sem re-medir)

| | EN offline | EN streaming | PT offline | PT streaming |
|---|---|---|---|---|
| WER vs referência | **0** | **0** | 0,087 | **0,087** |
| 1º delta | — | 1.116 ms | — | 1.063 ms |
| tempo total | 4.699 ms | 7.806 ms (completed) | 4.961 ms | 9.718 ms (completed) |

### Textos produzidos

- EN (ambos idênticos): "Effective Caching in Inference Engines Depends on Prefill Length, KV Layout, and the Residency of the Model in Unified Memory."
- PT (ambos idênticos): "Clashing eficaz em engines de inferência depende do tamanho do perfil, do layout de KV e da residência do modelo na memória unificada."

## Conclusões

1. **Zero penalidade de qualidade no decode incremental**: texto streaming == texto offline, inclusive nos ERROS (os 2 erros de PT aparecem nos DOIS caminhos → são acústicos do TTS de referência, não do streaming).
2. Timing do streaming: 1º delta ~1,1 s após início da fala; `completed` chega durante/antes do fim do áudio total (7,8 s < 8,5 s de fala; o server VAD fecha o turno antes do silêncio acabar).
3. **Formato da porta `audio_chunk` PODE SER FECHADO** (W10/ADR-003): `{format:'wav', sampleRateHz, data:Uint8Array}` + PCMs crus para capture — nenhum risco adicional de qualidade escondido no caminho streaming.
4. WER 0,087 em PT do TESTE é limitação do áudio de referência (TTS PT pronuncia "Caching" de forma que o Voxtral ouve "Clashing") — NÃO VERIFICADO como qualidade ASR-PT real com voz humana; re-testar com voz humana quando houver gravação real.

## Decisão

**ACEITO**: decode incremental (streaming) como caminho único de produção; sem fallback para decode completo em produção (offline fica apenas p/ transcrição de arquivos, se necessário).
