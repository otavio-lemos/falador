# ADR-009 — Captura de entrada dupla: Aplicações (SCK) vs Microfone (PortAudio)

**Status:** IMPLEMENTADO — 2026-11-22 (código em `capture.ffmpeg`/sidecar/host/UI; E2E ao vivo com microfone real NÃO VERIFICADO)
**Depende de:** ADR-003 (canvas/nada fixo), ADR-004 (mlx-audio), ADR-005 (captura SCK por app)
**Relacionado:** `docs/input-modes-test-plan.md`

## Contexto

Hoje o botão de microfone na UI aplica apenas `muted=true` no nó `capture.ffmpeg`, o que silencia a captura sem desligá-la de fato. A captura por app é feita via ScreenCaptureKit (SCK) (`backend: 'sck'`, `services/capture-sck.swift`); o microfone real já funciona via `sounddevice`/PortAudio (`backend: 'sounddevice'`, `services/capture-sidecar.py`). O SCK possui `capturesAudio` para o áudio de um app e, em macOS 15+, `captureMicrophone` como stream separada (Apple WWDC22; Apple `captureMicrophone`; Recall.ai).

Fontes:
- Apple WWDC22 — ScreenCaptureKit: https://developer.apple.com/videos/play/wwdc2022/10156/
- Apple `captureMicrophone` (macOS 15+): https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration/capturemicrophone
- Recall.ai — capturing system audio / per-app capture: https://www.recall.ai/blog/how-to-capture-system-audio-on-macos
- masrisystems/meeting-copilot — padrão de captura por app + fallback mic: https://github.com/masrisystems/meeting-copilot
- dev.to — capturing system audio on macOS: https://dev.to/... (ver AGENTS.md §4, "Prior art eco/loopback")

## Decisão

Um único nó `capture.ffmpeg` com **duas origens mutuamente exclusivas**:

- `apps` = SCK (captura por app, `capturesAudio`).
- `mic` = PortAudio/sounddevice (microfone real).

Mais `input.chat` como **alternativa de texto** quando o botão de voz for desligado. **Não criar novo tipo de nó.**

### Contrato de parâmetros

| Param | Tipo | Valores | Semântica |
|---|---|---|---|
| `backend` | string | `'sck'` \| `'sounddevice'` | Implementação de captura (SCK vs PortAudio). |
| `input` | string | nome do app (SCK) \| nome do device (PortAudio) | Alvo da captura. |
| `muted` | boolean | true/false | Silencia a captura (comportamento atual; mantido por compat). |
| `enabled` | boolean | true/false | Liga/desliga a captura como source. |

- `capture.ffmpeg` é **sourceOnly** (Spec §types): emite `audio_chunk`, não consome.
- Quem é sourceOnly: apenas `capture.ffmpeg` (e `input.chat` como fonte de texto).
- O que muda no grafo quando voz/chat alternam: quando `enabled=false` no capture, o edge `capture.out → asr.in` deixa de produzir; quando `input.chat` está habilitado, ele assume como fonte de texto (phrase/tokens_parcial) para o mesmo downstream. A alternância é feita por `enabled`, não por remoção de edge.
- Por que `enabled` é melhor que `muted` para esconder captura: `muted` mantém o processo filho rodando e a fila alimentada (silêncio), consumindo CPU e podendo emitir chunks vazios; `enabled=false` não inicia (ou para) a captura e não emite nada, preservando o grafo e os bindings.

### Regras de transição

1. Sempre **parar/reiniciar o run** ao trocar origem (apps ↔ mic).
2. Matar o child anterior (capture-sck.swift ou capture-sidecar.py) antes de subir o novo.
3. Não capturar as duas streams ao mesmo tempo na v1.
4. Preservar app/device selecionado em `localStorage` (UI) ao trocar.

### Riscos

- **TCC de Microfone**: permissão necessária para PortAudio; sem ela, RMS zero.
- **SCK por app, não por aba**: SCK filtra por processo (Apple/WWDC22); Meet no Chrome captura todo o áudio do Chrome.
- **Eco acústico no modo microfone**: se houver TTS/playback, o mic captura o playback → eco. Mitigação: modo mic é só-texto (sem TTS) ou gate de correlação de envelope (openinterview).
- **Device drift**: device PortAudio pode mudar de índice entre sessões (usar nome, não índice).
- **macOS 15+ para SCK mic**: `captureMicrophone` é macOS 15+; NÃO usado na v1 (mic via PortAudio).
- **Por que PortAudio é a escolha atual nesta máquina**: ffmpeg 9.0.2/avfoundation perde ~75% dos samples (AGENTS.md §4); PortAudio (sounddevice) captura 100%; SCK mic exige macOS 15+ e stream separada ainda não integrada.

### Alternativas consideradas (rejeitadas na v1)

| Alternativa | Motivo da rejeição |
|---|---|
| SCK `.microphone` stream (macOS 15+) | Stream separada não integrada no capture-sck.swift; exige macOS 15+; mic via PortAudio já provado (N7). |
| Dois nós capture simultâneos | Viola "não capturar as duas streams ao mesmo tempo na v1"; complexidade de sync e de eco. |
| Novo nó `input.mic` | Viola "não criar novo tipo de nó"; duplica lógica de device resolution e de sourceOnly. |

## Implantação 2026-11-22

- `capture-sidecar.py --list` + `GET /api/mics` (cache 5 s, `no-store`).
- `capture.ffmpeg`: `resolveSounddeviceInput()` — `input` vazio resolve para `Microfone`; app/device explícito preservado.
- UI: `captureSource` persistido; dropdown Captura com `Aplicações`/`Microfone`; device picker via `/api/mics`; botão do microfone alterna voz↔chat quando o flow tem `input.chat`, e origem apps↔mic quando não tem.
- `assistente-entrevista.json` ganhou `input.chat` (`chat.out → assistente.in`) para o modo texto.
- Verificado: 211 testes (210 pass, 1 skip), `tsc`/build verdes, 7/7 flows válidos, voz/chat válidos no `validateFlow`, `/api/mics` ao vivo com 2 devices, browser real com troca Aplicações→Microfone e persistência.

## NÃO VERIFICADO

- Integração de `captureMicrophone` (SCK mic) no capture-sck.swift.
- Teste ao vivo do modo mic com fala real em call (apenas N7 mic real com sinal).
- Comportamento em macOS < 15 para SCK mic (não aplicável, não usado).
