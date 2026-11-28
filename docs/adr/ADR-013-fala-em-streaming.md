# ADR-013 — Fala em streaming (PCM por frame) e player `ffplay`

Data: 2026-11-27 · Status: ACEITO (implementado) · Pedido do dono: "corrija tanto o tradutor omni como o sem omni"

## Problema

O `sink.captions` no modo `speak` pedia a frase inteira ao sidecar (`POST /tts`) e só tocava
depois: a fala EN→PT saía com **1,2–1,5 s de silêncio** depois da tradução, porque o
`generate()` acumula todos os frames antes de devolver o WAV. O modelo, porém, já emitia
áudio por frame (`stream_slots` → 12 codec tokens a cada 80 ms = 1920 amostras a 24 kHz).

## Decisão

1. **`POST /tts-stream` nos dois sidecars** (`services/sts-sidecar.py` :8091 via `mlx_audio`,
   `services/omni-sidecar.py` :8092 via `mlx_vlm`): responde **PCM s16le mono 24 kHz cru**,
   sem `Content-Length` (corpo delimitado pelo fechamento, HTTP/1.0 do `BaseHTTPRequestHandler`),
   com headers `X-Sample-Rate` e `X-Sample-Format`. Decodifica em lotes de **4 frames (320 ms)**
   para amortizar o codec sem perder latência. `POST /tts` (WAV inteiro) **continua** — é o
   contrato do nó `tts.sts`.
2. **O nó toca em paralelo**: `fetch` do stream e `ffplay -f s16le -ar <sr> -ch_layout mono
   -nodisp -autoexit -loglevel error -` recebendo os chunks no stdin (`-af atempo=<playbackRate>`
   para velocidade, que preserva o pitch). `player` default do `sink.captions` passa a ser
   `/opt/homebrew/bin/ffplay`; `sink.playback` segue `afplay` (recebe WAV pronto).
3. **Escrever no stdin sem esperar `drain`**: o buffer do pipe absorve a frase inteira (centenas
   de KB). Se o sink respeitasse o ritmo do player, o sidecar ficaria bloqueado no `wfile.write`
   segurando o `LOCK` do modelo por toda a reprodução — e no :8092 isso travaria o
   `/asr-translate` (mesmo processo) por ~7 s. Assim a geração termina em ~1,2 s e o lock cai.
4. **`timeoutMs` cobre só a espera pelo 1º chunk** (`AbortSignal.any([ctrl.signal,
   AbortSignal.timeout(timeoutMs)])`); o corpo flui até o fim da fala.
5. **`capture.ffmpeg` (SCK) passa a excluir `ffplay`** por nome (`excludeNames` default
   `afplay,ffplay,omlx`) e por PID (`/ffplay ` no `pgrep`), junto de `afplay`.

## Medições (M4 Pro, 2026-11-27)

| Serviço | 1º chunk | Áudio gerado | Total |
|---|---|---|---|
| :8091 LFM3-Audio-2B-MLX-8bit | **247 ms** (protótipo 262 ms) | 6,08 s | 1,26 s |
| :8092 LFM3-Omni-2B-MLX-8bit | **145 ms** (protótipo 112 ms) | 5,76 s | 1,03 s |

E2E pelo runner (`input.chat` → `sink.captions` speak) nos dois: `fala: "…" (streaming 24000 Hz)`
+ `playback ok (2,3 s, 128 KB)`.

## Alternativas descartadas

- **`afplay` com arquivo WAV crescendo**: afplay espera o arquivo completo (e não faz sentido com
  FIFO); não há garantia de tocar antes do EOF.
- **PortAudio (`playback-sidecar.py`) como player de stream**: exigiria resample manual para o
  clock do device e um novo protocolo residente; o `ffplay` já resolve SRC e velocidade.
- **Fatiar o texto por sentença e sintetizar cada uma**: reduz latência, mas quebra a prosódia e
  não usa o streaming que o modelo já oferece.

## Não verificado

- Latência até o **primeiro som audível** (o ffplay bufferiza; medimos só o lado da geração).
- E2E ao vivo com SCK/Chrome em conferência real.

## Armadilha registrada

Trocar o binário do player **sem** atualizar a exclusão do SCK reintroduz o eco (o áudio da
própria tradução volta a ser capturado e traduzido de novo). O acoplamento é por nome de
processo — ver `AGENTS.md` §5 L27.
