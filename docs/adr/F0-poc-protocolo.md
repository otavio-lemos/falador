# Protocolo F0 — Prova de Conceito (Falador)

**Status:** PROPOSTO — nenhum comando abaixo executa sem aprovação prévia do usuário
**Data:** 2026-11-18
**Depende de:** ADR-002 (runtimes), ADR-003 (workflow engine ACEITO), simulação inicial (scratchpad / pesquisa docs)

## Objetivo

Fechar as 3 incógnitas que a simulação identificou como dominantes ANTES de escrever o motor de grafo e a UI:

| Gate | Incógnita | Critério de pass | Tempo |
|---|---|---|---|
| G1 | Áudio: BlackHole Multi-Output — usuário continua ouvindo E o app captura? | captura 16 kHz limpa das duas fontes + usuário escuta (drift correction OK) | ~30 min (setup manual + teste) |
| G2 | Contenção: 2 instâncias LLM (LFM3-1.7B-MLX-4bit via omlx) simultâneas — TTFT real sob concorrência | TTFT ≤ 400ms degradado (estimado 80–200ms × 1,15–1,6) | ~20 min |
| G3 | **STREAMING de fala do LFM3-Audio-2B** via `audio_streamer` (MLX-VLM): emite chunks em tempo real ou WAV completo no fim? | chunks progressivos de áudio/texto com timestamps crescentes = PASS; arquivo único no fim = FAIL (muda arquitetura: parciais de legenda saem, TTS por frase entra) | ~20 min |

## Ordem de execução

```
G1 (áudio) → G2 (contenção) → G3 (streaming de fala) → relatório go/no-go
```

G3 é o posto crítico (decide entre parciais de legenda por chunk vs. TTS por frase). O protocolo G1 usa o BlackHole já instalado do usuário.

## G1 — BlackHole Multi-Output (sem instalar nada novo)

1. Audio MIDI Setup → criar **Multi-Output Device**: (AirPods/saída atual) + (BlackHole 2ch), com **Drift Correction** na saída secundária.
2. Saída do sistema → Multi-Output Device.
3. Teste de captura (áudio tocando no YouTube):
```bash
ffmpeg -f avfoundation -i ":0" -t 5 -ar 16000 -ac 1 /tmp/g1_capture_test.wav   # captura 5s
afplay /tmp/g1_capture_test.wav                                                # Inspeção auditiva (usuário)
ffmpeg -i /tmp/g1_capture_test.wav -af volumedetect -f null - 2>&1 | grep -E 'mean_volume|max_volume'
```
   - **PASS:** usuário ouviu normal durante a captura E o WAV tem fala (max_volume > -30 dB). Índice `:0` ajustável (`ffmpeg -f avfoundation -list_devices true -i ""`).

## G2 — Contenção de 2 instâncias omlx (instala pip `omlx` — PEDIR APROVAÇÃO)

```bash
# modelo: LiquidAI/LFM3-1.7B-MLX-4bit (pesos oficiais da Liquid; NÃO usar quant do omlx — issue #5129)
omlx serve --model LiquidAI/LFM3-1.7B-MLX-4bit --port 8080   # instância A
omlx serve --model LiquidAI/LFM3-1.7B-MLX-4bit --port 8081   # instância B
```
- Script de carga (2 requisições streaming simultâneas, 20 rodadas): medir **TTFT p50/p90 por instância** e tok/s.
- **PASS:** TTFT p90 ≤ 400ms com as duas ativas. **FAIL (>800ms):** cenário 2 usa 1 instância com fila (/tasks: tradução e assistente em turnos — simulação sugere que LLM no meio adiciona pouco, fila é viable).

## G3 — Streaming de fala do LFM3-Audio-2B (clone mlx-vlm, PEDIR APROVAÇÃO)

```bash
# baseline documentado: README do port lfm3_audio no mlx-vlm diz
# "streaming input and output are not implemented" — este teste é o veredito real
python - <<'EOF'
from mlx_vlm.audio_streamer import AudioStreamer   # caminho a confirmar após clone
# correr TTS/S2ST com chunking e logar timestamps de cada chunk vs duração do áudio alvo
EOF
```
- Ajuste fino do caminho/nome após inspecionar o código do port (o protocolo exato será extraído do próprio repositório na hora).
- **PASS:** chunks/frames emitidos progressivamente (first-chunk < 500ms de áudio-alvo). **FAIL:** WAV/bytes completos só ao final → v1 usa tradução por frase com TTS por frase (aumentando o papel do gate G2/fila) e legenda final por utterance.

## Relatório de saída

`docs/adr/research/F0-resultados.md` — tabela go/no-go por gate, números medidos, decisão arquitetural decorrente (com data), e o que muda no ADR-002/003 se algum falhar.

## Lições da execução da F0 (2026-11-18) — correções de processo

| # | Lição | Correção no processo de arquitetura |
|---|---|---|
| L1 | Pegada de instalação não auditada: omlx não é pip; é tap brew (254 MB) + LLVM bottle (>300 MB) p/ kernels nativos. Descoberto durante a execução, não no ADR | Toda escolha de runtime no ADR passa a incluir: método de distribuição, dependências transitivas, tempo de setup e estabilidade da fonte — antes do veredicto |
| L2 | Carga fria vs quente: ASR 9,7 s frio vs 0,22 s quente (RTF 0,05). Qualquer modelo recarregado por utterance destrói tempo real | Regra de arquitetura: todo serviço de modelo é residente (servidor long-lived); recarga fria só em boot/falha. Tabelas de latência sempre separam frio/quente |
| L3 | "Não tem streaming" não é binário: o port do LFM3-Audio-2B diz streaming "não implementado", mas o `stream_slots` já rende frame a frame e o codec decode-only está portado (RTF 0,002 medido) | Pesquisa de arquitetura inclui leitura do código-fonte do port/community, não só README e issues |

## O que NÃO entra na F0

- Motor de grafo (implementação), TUI, UI web — só depois dos gates, quando o formato real dos dados (chunk vs frase) estiver decidido pela medição.
- Qualquer dependência além de `omlx` (pip) e clone de `mlx-vlm` — listadas acima com pedido de aprovação explícito.
