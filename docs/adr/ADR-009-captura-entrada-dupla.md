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

Unificar a entrada de todos os workflows em **um único nó `input` (`type: "capture.ffmpeg"`)** com **três modos mutuamente exclusivos** selecionáveis via `backend`:

- `'sck'` = Aplicações via ScreenCaptureKit (`capturesAudio`), emite áudio na porta `out` (`pcm16k`).
- `'sounddevice'` = Microfone via PortAudio/sounddevice, emite áudio na porta `out` (`pcm16k`).
- `'chat'` = Chat de texto no mesmo nó `input` (usa `placeholder`), emite texto na porta `out_text` (`phrase`) sem iniciar captura de áudio.

**Não manter `input.chat` separado nos fluxos nem criar novo tipo de nó.** Na UI, a barra de etapas não exibe mais lista de apps/mics; a escolha entre Aplicações, Microfone e Chat ocorre no próprio nó único `input`.

### Contrato de parâmetros e saídas

| Campo | Tipo | Valores | Semântica |
|---|---|---|---|
| `backend` | string | `'sck'` \| `'sounddevice'` \| `'chat'` \| `'ffmpeg'` (legado) | Modo de entrada: Aplicações (SCK), Microfone (PortAudio) ou Chat de texto. |
| `input` | string | nome do app (SCK) \| nome do device (PortAudio) \| `""` | Alvo da captura de áudio quando em modo `'sck'` ou `'sounddevice'`. |
| `placeholder` | string | texto de dica | Placeholder exibido no modo `'chat'` (substitui o antigo `input.chat`). |
| `muted` | boolean | true/false | Silencia a captura (mantido por compatibilidade). |
| `enabled` | boolean | true/false | Liga/desliga o nó como source. |

- `capture.ffmpeg` é **sourceOnly** (Spec §types) e expõe duas saídas:
  - `out` (`pcm16k`): chunks PCM 16 kHz mono quando `backend` é `'sck'` ou `'sounddevice'` (conectado a `asr.in`).
  - `out_text` (`phrase`): mensagem enviada no modo `'chat'` (conectada diretamente ao nó consumidor de texto, ex.: `assistente.in`, `tradutor.in`, `agente.in`, `planejador.in` ou `legenda.phrase`).
- Quando o usuário alterna entre voz (`'sck'` / `'sounddevice'`) e texto (`'chat'`), o mesmo nó `input` permanece no grafo, preservando layout, ID e conexões sem nó `input.chat` duplicado.
- Por que `enabled` é melhor que `muted` para desligar captura: `muted` mantém o processo filho rodando e a fila alimentada (silêncio), consumindo CPU e podendo emitir chunks vazios; `enabled=false` (ou `backend: 'chat'`) não inicia processo de captura de áudio.

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
- Verificação inicial pré-unificação: 211 testes (210 pass, 1 skip), `tsc`/build verdes, `/api/mics` ao vivo com 2 devices, browser real com troca Aplicações→Microfone e persistência.

### Unificação para nó único Input (2026-11-22)

- Todos os **7/7 workflows** em `apps/tui/flows/*.json` passam a usar um único nó de entrada (`id: "input"`, `type: "capture.ffmpeg"`), removendo `input.chat` e duplicatas de entrada.
- A UI deixa de exibir lista de apps/mics na barra de etapas; a seleção entre Aplicações (`sck`), Microfone (`sounddevice`) e Chat (`chat`) pertence ao próprio nó único `input`.
- Os fluxos originalmente chat-only (`agente-suporte-ops.json`, `agente-workflows.json`, `revisao-servidor-ops.json`) receberam o nó `asr` (`asr.realtime`, Voxtral) conectado a `input.out`, mantendo `backend: "chat"` por padrão com `input.out_text` ligado ao consumidor principal.

| Workflow | Nós | Conexões | `backend` padrão |
|---|---|---|---|
| `agente-suporte-ops.json` | 6 | 6 | `chat` |
| `agente-workflows.json` | 6 | 6 | `chat` |
| `assistente-entrevista.json` | 9 | 9 | `sck` |
| `legendas-traducao-pt.json` | 4 | 4 | `sck` |
| `revisao-servidor-ops.json` | 12 | 12 | `chat` |
| `tradutor-voz-en.json` | 6 | 6 | `sck` |
| `transcricao-ao-vivo.json` | 3 | 3 | `sck` |

## NÃO VERIFICADO

- Integração de `captureMicrophone` (SCK mic) no capture-sck.swift.
- Teste ao vivo do modo mic com fala real em call (apenas N7 mic real com sinal).
- Comportamento em macOS < 15 para SCK mic (não aplicável, não usado).
- Neste worktree foi verificada apenas a integridade estrutural/JSON dos 7 workflows unificados; a validação `validateFlow` com `out_text`, `placeholder` e `backend: 'chat'` e o E2E ao vivo com mic/chat/UI dependem da integração com as alterações de engine e UI.
