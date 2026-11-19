# ADR-005 — Cenário 2 só-texto + captura ScreenCaptureKit por app

**Status:** ACEITO — 2026-11-19 (decisão do dono: "a fala não é preciso, quem vai falar sou eu… capturar, jogar pra llm, fazer a votação e eu mesmo responder")
**Depende de:** ADR-002 (runtime), ADR-003 (canvas/nada fixo), ADR-004 (mlx-audio)

## Contexto

O Cenário 2 original terminava em TTS EN + playback. Com a captura via BlackHole
(Multi-Output), o playback realimentava a captura: o ASR transcrevia a própria voz
TTS e disparava novo ciclo decisão→TTS — **eco estrutural, medido em 2 runs**
(AGENTS.md §4). As soluções de injeção (2º device virtual, half-duplex) foram
pesquisadas e até prototipadas (playback-sidecar.py com device alvo, VERIFICADO),
mas o dono redefiniu o produto:

> "quem vai falar sou eu… a ideia é capturar, jogar pra llm, fazer a votação e eu
> mesmo responder"

Isso é exatamente o **padrão 1 da indústria** (copilots de entrevista só-texto:
interview-copilot, OpenCluely, meeting-copilot, openinterview — fontes em
AGENTS.md §4): sem TTS na call, o problema de eco deixa de existir.

## Decisões

| # | Decisão | Escolha |
|---|---|---|
| P1 | Cenário 2 padrão | **Só-texto**: captura → ASR streaming → assistente LLM (sugestão PT) → **votação d1** (decision.llm systemone, auto/humano) → auto: sugestão direto na tela; humano: card editável (gate) → tela. **O dono fala com a própria voz.** |
| P2 | TTS/playback | Nós `tts.sts`/`sink.playback` **continuam no catálogo** (nada fixo — ADR-003); saem apenas do fluxo padrão. `services/playback-sidecar.py` (device alvo via PortAudio) fica pronto e verificado, NÃO fiado ao nó — religar se um dia a voz na call for desejada. |
| P3 | Captura oficial | **ScreenCaptureKit por app** (`backend: 'sck'`, services/capture-sck.swift): ouve só o app da call (input = nome), sem Multi-Output/BlackHole/routing. O dono **apagou o Multi-Output**. Filtro por app = áudio de outros processos (ex. TTS) não entra → sem eco digital mesmo se a voz voltar. |
| P4 | UI | Caixa de **sugestão** (verde, fixa até a próxima) separada da **transcrição** (azul, ao vivo). RunPanel classifica pelos edges do grafo: sink.captions ligado direto a nó asr.* = transcrição; demais = sugestão. |

## Evidência (medido 2026-11-19, pós-pivô)

- SCK: 16 kHz mono honrado (~32000 B/s), frase completa capturada do QuickTime
  (app-scoped), tradução direta PT perfeita; espera o app aparecer (30 s).
- E2E cenário 1 (sck): 307 chunks/25 s contínuos, legendas PT reais.
- E2E cenário 2 só-texto (sck): 372 chunks/30 s, 3 turns ASR = só a mídia injetada
  (**sem turn de eco**), assistente ttft méd 65 ms, **votação d1 auto×3**,
  3 sugestões no sink `sugestao`. Browser: transcrição EN na caixa azul +
  sugestão PT na caixa verde, badges de métricas nos 8 nós.
- TCC: permissão de Gravação de Tela concedida pelo dono (sem ela o helper sai com erro).

## Consequências

- Eco digital e acústico: **eliminados por design** (sem TTS; captura por app).
- `faladorctl` inalterado (sidecars de captura/playback são filhos do run, não residentes).
- Pendências de qualidade (não bloqueiam): janela do asr.lfm3 corta utterance
  (upgrade = corte por VAD); flush de silêncio alucina texto curto (upgrade = gate
  de energia); votação poderia exibir as probabilidades na UI (meta já existe no envelope).
- Meet no Chrome: filtro por app captura TODO o áudio do Chrome (por app, não por aba).