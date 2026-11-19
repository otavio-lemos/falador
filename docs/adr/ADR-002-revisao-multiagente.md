# ADR-002 — Revisão da ADR-001 após validação adversarial multi-agente

> **Status:** PROPOSTA — aguardando aprovação do dono (2026-11-18)
> **Insumos:** 7 revisões independentes (3 internas + 4 externas). Relatórios completos em `docs/adr/reviews/` (externos: codex, kilo, agy; internos: rev-latencia, rev-alternativas, rev-fatoss, rev-arquiteturai — resumidos aqui).
> Onde houve divergência entre revisores, a arbitragem foi feita com verificação direta na fonte primária (indicada).

---

## 1. Consenso dos revisores — o que caiu da ADR-001

### F1 — Números de performance do ADR-001 eram de outra fonte (CRÍTICO — refutado)
Os números "280 tok/s, 90 ms 1º token, 140 ms 1º áudio" **não são do LFM3-Audio-2B em MLX**. São de um post público do Xenova (Hugging Face) sobre **LFM3-Omni-2B rodando no navegador via WebGPU com kernels customizados**.
- Fonte: https://x.com/xenovacom/status/2115923280079286543 · análise: https://local-ai-zone.github.io/blog/lfm3-deep-dive.html
- Único número oficial verificável do Audio-2B: **LiquidCodec decodifica a ~87× tempo real em 1 thread de CPU (M4 Max), com streaming decoding** (https://huggingface.co/LiquidAI/LFM3-Audio-2B). TTFT "<50 ms" é claim do fabricante (terciário, sem especificação).
- **Não existe benchmark público de tok/s/ttft primeiro-áudio do LFM3-Audio-2B em MLX.** F0 deve medir tudo.

### F2 — LM Studio não serve modelos de áudio (CRÍTICO — bloqueante verificado)
- Endpoints do LM Studio: só texto/imagem/embeddings; `/v1/audio/speech` → "Unexpected endpoint"; issue #1715 aberta (https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1715; docs: https://lmstudio.ai/docs/developer/openai-compat).
- Catálogo LM Studio: não há LFM3-Audio ou LFM2.5-Audio (404).
- LM Studio continua útil **apenas para o assistente de texto** (Proc. ASSISTENTE).

### F3 — MLX-VLM hoje não implementa streaming de entrada/saída para LFM3-Audio
- README oficial do modelo `lfm3_audio` no MLX-VLM: *"streaming input and output are not implemented, including LiveASR"*; o server do mlx-vlm limpa o cache após cada request (mlx-vlm #999) → sem prompt-cache entre turnos.
- Consequência: o caminho MLX atual entrega **batch por utterance**, não streaming.

### F4 — S2ST áudio→áudio de uma passada não é o que a doc entrega
- A doc oficial do LFM3-Audio-2B documenta tradução **speech→text** e **text→text**; não há prompt/demonstração de speech→speech EN→PT (https://huggingface.co/LiquidAI/LFM3-Audio-2B, seção Translation).
- Voz interleaved (voice chat) documentada como **English-only** em runtime (tapioca issue #69 — NÃO VERIFICADO em versão atual).
- Caminho real: **cadeia ASR → tradução → TTS** (no mesmo modelo, em 3 passos, ou em modelos separados).

### F5 — Caminho acústico (D1+D2) é o risco mais grave (consenso de 5/7)
"Capturar a reunião pelo microfone do ar + reproduzir TTS pelo alto-falante" cria: eco/loop (o sistema traduz a própria voz traduzida), destruição de SNR, disparo falso do VAD e supressão pelo AEC/Krisp do Zoom/Teams/Meet (o Áudio remoto chega picotado ou o nosso TTS não chega ao outro lado).
- Mitigação sem mudança de hardware: **CoreAudio Process Tap** (macOS ≥14.2, captura digital do buffer do app da conferência, sem BlackHole) para entrada, e **microfone virtual (BlackHole) ou loopback** para saída; ou uso de **fones** (quebra o eco por hardware).
- AEC nativo se precisar de aberto: AVAudioEngine + `VoiceProcessingIO`.
- Fontes: relatório agy.md (seção D1/D2) · rev-arquiteturai (R2) · FluidAudio/AVAudioEngine docs.

### F6 — VAD por utterance completa = tradução consecutiva, não simultânea (CRÍTICO para o requisito)
Fala contínua de 8-12 s → legenda só ao final + hangover do VAD (~300-500 ms) → atraso percebido 8-12+ s. Requer **STT com parciais** (streaming chunked ou nativo): WhisperLiveKit (AlignAtt/LocalAgreement), whisper.cpp streaming, Parakeet (FluidAudio, CoreML/**ANE** — não disputa a GPU), Qwen3-ASR (MLX, lane de streaming), Voxtral Mini 4B Realtime (MLX comunitário — NÃO VERIFICADO perf).

### F7 — Contenção de GPU real (Metal = fila única, sem isolamento entre processos)
- Evidência: omlx issue #416 ("MLX serializa todas as operações por uma fila Metal"), omlx PR #4637 (GPU firmware lockup com múltiplos streams), mlx #3078. Processos separados garantem crash-isolation, **não** isolamento de latência.
- Mitigação de consenso: **assistente fora da GPU** (llama.cpp em CPU/AMX) ou **escuta fora da GPU** (FluidAudio/CoreML na ANE); prefetch-prefixo manual (prompt-cache não é automático no caminho MLX).

### F8 — Correções factuais menores (verificação direta)
- **Kokoro: 3 vozes pt-BR confirmadas** (1F 2M — https://huggingface.co/hexgrad/Kokoro-82M/raw/main/VOICES.md). Caveat oficial: qualidade não-EN pode ser fraca (G2P).
- **Chatterbox NÃO está arquivado** (GitHub API: `archived: false`, MIT, push 2026-11-04) — o README diz "retired research"/sem manutenção; manutenção efetiva interrompida desde set/2025 (arbitragem: usar como risco, não como fato de arquivamento).
- **SimulEval arquivado** (set/2025, read-only) — F4 deve medir Average Lagging manualmente.
- **4-bit contraindicado pelo card oficial** ("loses some accuracy, 8-bit is the recommended trade-off" — https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-4bit). Default deve ser **8-bit** (2,33 GB) até medição.
- **LFM3-1.7B "não recomendado para multi-step/complex reasoning"** (docs oficiais/Ollama) — risco de qualidade no assistente técnico; comparar com Qwen3-4B na F0.
- mlx-lm em release ainda não embarca LFM3 (PR #2016 aberto); runtime correto p/ LFM3-Audio: **MLX-VLM ≥0.8.0** ou **llama.cpp ≥0.8.0 (b11960)**.
- llama.cpp expõe **`/v1/realtime` (WebSocket) para conversas de voz em tempo real** com LFM3-Audio GGUF — o caminho de streaming documentado pelo fabricante (https://docs.liquid.ai/deployment/on-device/llama-cpp).

---

## 2. Veredicto consolidado sobre D1–D8 da ADR-001

| Decisão | Consenso | Veredicto consolidado |
|---|---|---|
| D1 (mic do ar + alto-falante) | 5/7 p/ derruba-ajusta | **AJUSTA/DERRUBA**: manter "sem bot", mas trocar pelo caminho digital: Process Tap/BlackHole na captura; fones como modo local |
| D2 (TTS no alto-falante) | 4/7 derruba | **AJUSTA**: saída via mic virtual p/ chegar limpa aos participantes; sidetone nos fones; modo "só local" continua simples |
| D3 (idiomas selecionáveis) | consenso | **MANTÉM** — com teste pt-BR explícito na F0 (docs dizem "Portuguese" genérico) |
| D4 (M4 Pro 48 GB) | consenso | **MANTÉM** — com particionamento: assistente fora da GPU (CPU/AMX) ou escuta na ANE |
| D5 (LFM license) | consenso | **MANTÉM** — uso pessoal/pesquisa livre; limite: anual > US$ 10M exige licença; attribution se distribuir |
| D6 (Audio-2B p/ tudo, 2 instâncias) | 6/7 ajusta forte | **REBAIXA para experimental**: modelo permanece menu, mas v1 provavelmente no papel de TTS/voz via llama.cpp `/v1/realtime`; legenda precisa de STT com parciais |
| D7 (Ports plugáveis) | 7/7 mantém | **MANTÉM** — é a decisão que salva o projeto; adicionar contrato: parciais {seq,t0,t1,lang}, EOU, timestamps |
| D8 (3 processos) | 6/7 ajusta | **AJUSTA**: manter isolamento lógico; cancelamento explícito (seq#/idempotência); sugestões em bullets + debounce/push-to-assist; re-geração não sobrescreve edição/aprovação |
| D9 (runtimes: omlx + llama.cpp) | proposta nova | omlx para texto (batching + KV persistente), llama.cpp `/v1/realtime` para voz — G3 da F0 arbitra o caminho de fala |

---

## 3. Arquitetura revisada (v2 — proposta)

```
[Conferência: Teams/Zoom/Meet/WhatsApp]
   │ áudio remoto                          ▲ áudio do usuário B
   ▼                                       │
[CoreAudio Process Tap / BlackHole]        │      [Fones p/ B (mono monitor)]
   │ PCM digital limpo                     │
   ├──► [VAD Silero, CPU]                  │
   │      │ chunks de fala ~200-500ms      │
   │      ▼                                │
   │   [STT STREAMING c/ parciais]         │
   │    ├─ default F0-A: whisper.cpp large-v3-turbo (Metal, stream)
   │    ├─ default F0-B: Parakeet TDT v3 via FluidAudio (CoreML/ANE — não disputa GPU)
   │    └─ plug: Qwen3-ASR-MLX, Voxtral Realtime, LFM3-Audio (ASR)
   │      │ tokens parciais → LEGENDA (1º token = 1º traço)
   │      │ texto confirmado (por frase, c/ política de confirmação)
   │      ▼
   │   [TRADUÇÃO incremental — ExecPort]
   │    ├─ LFM3-1.7B (8-bit/4-bit) no GPU Metal — OU
   │    └─ LFM3-1.7B via llama.cpp CPU/AMX (zero disputa de GPU)
   │      │ PT stream → legenda + contexto
   │      ├───────────► [ASSISTENTE (cenário entrevista)]
   │      │               LFM3-1.7B (CPU/AMX) ou Qwen3-4B
   │      │               · acionamento: fim-de-pergunta ou push-to-assist
   │      │               · saída: bullets curtos (teleprompter)
   │      │               · cancelamento por seq#; nunca sobrescreve edição/aprovação
   │      ▼
   │   [TTS — ExecPort: frase-a-frase, listen enquanto gera próximo]
   │    ├─ Kokoro-82M pt-BR (Apache-2.0, 3 vozes, ~100ms 1º chunk)
   │    └─ LFM3-Audio-2B via llama.cpp /v1/realtime (EXPERIMENTAL — gate F0: streaming real?)
   │      │ PCM
   └──────┴──► [Saída: mic virtual (BlackHole) p/ conferência + sidetone fones]
```

**Regra de escala (latência alvo, critérios verificáveis — de codex.md §4.5):**
- 1ª legenda parcial ≤ 0,5 s após início da fala
- tradução confirmada ≤ 1,5 s após fim da frase
- 1º áudio TTS ≤ 2,0 s após fim da frase
- p95 com assistente + conferência ativos ≤ 3 s
- drift em sessão de 45 min ≈ 0 (ring-buffer, drop policy p/ áudio)

---

## 4. Fase F0 corrigida (3-5 dias — era otimista em 1-2)

F0 = gates de aprovação, com combinação padrão vs alternativas no MESMO áudio de teste EN→PT real:

1. **G1 — Captura digital**: Process Tap (ou BlackHole) funcionando, VAD sem disparo falso, sem eco com fones. Se faltar: parar e decidir áudio com o dono.
2. **G2 — STT com parciais**: whisper.cpp stream vs Parakeet/FluidAudio — medir latência 1ª parcial e WER pt-BR (amostras reais).
3. **G3 — TTS streaming**: Kokoro pt-BR por frase; e LFM3-Audio-8bit via `llama-server /v1/realtime` — existe streaming real? Qual o 1º áudio?
4. **G4 — Tradução**: LFM3-1.7B (GPU) vs (CPU/AMX) — tok/s, TTFT, com prefix-cache manual.
5. **G5 — Concorrência**: 3 cargas simultâneas — interferência na escuta (o teste que decide o particionamento).
6. **Métrica**: lag médio manual (SimulEval arquivado) + p95.

**Critério de aprovação**: se G3+G5 passarem, mantém-se a opção "LFM3-Audio-2B para voz" (espírito D6); senão, v1 = cascata (whisper/Parakeet + LFM3-1.7B + Kokoro) e o Audio-2B fica experimental.

---

## 6. Runtime (revisão pós-debate omlx × llama.cpp — 2026-11-18)

**Evidência:**
- omlx (jundot/omlx, ex-vllm-mlx) é o único servidor Apple Silicon com **batching real sob concorrência**; llama-server/Ollama/mlx-lm server executam cada request isolado (throughput agregado na concorrência 4 ≈ concorrência 1) — https://jaesolshin.com/posts/apple-silicon-llm-backends/
- omlx: continuous batching, tiered KV cache (RAM/SSD, sobrevive a restart), paged cache, multi-model, menu-bar macOS app — https://github.com/jundot/omlx
- omlx serve LFM3: PR #4937 ("LFM3 text, speech and d1 models"; LFM3-Audio-2B no engine VLM, **entrada** de áudio via `input_audio`) — **NÃO VERIFICADO: saída de fala STREAMADA via API** (engine é mlx-vlm, cujo README diz "streaming input and output are not implemented")
- Quantizador interno oQ quebrou tensors de áudio no LFM3-Omni (issue #5129) ⇒ usar sempre os **MLX weights oficiais LiquidAI**, não o oQ
- llama.cpp ≥0.8.0 (b11960) **`/v1/realtime` (WebSocket)** = única rota de streaming de voz documentada pelo fabricante — https://docs.liquid.ai/deployment/on-device/llama-cpp

**Decisão de runtime (D9):**
| Papel | Runtime v1 | Porque |
|---|---|---|
| ASSISTENTE + TRADUÇÃO (texto) | **omlx** (um servidor, 2 modelos carregados) | único com batching + prefix-cache persistente; cenário de re-geração concorrente é exatamente seu forte |
| FALA (LFM3-Audio, streaming de voz) | **llama.cpp `llama-server /v1/realtime`** com GGUF oficial | única rota documentada de fala streamada; Experimental |
| FALA (alternativa se omlx streamar) | omlx com LFM3-Audio-8bit MLX | gate G3 decide em 20 min de teste |
| Crown fast-path (opcional, G3+) | in-process MLX-VLM via `audio_streamer` | validar se `generate(audio_streamer=...)` streama no port atual |

**G3 da F0 vira o árbitro final entre omlx e llama-server para o caminho de voz** — carregar LFM3-Audio-2B-MLX-8bit nos 2 runtimes e medir: 1º chunk de áudio, continuidade do stream, tok/s de fala.

**Decisão predominante (2026-11-18, final — direção do dono): o LFM3-Audio-2B é ANY-TO-ANY e é o modelo ÚNICO do pipeline v1.**
- O card oficial MLX (https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-4bit; pipeline_tag `any-to-any`) documenta no MESMO modelo: ASR ("Perform ASR in English"), tradução (speech/text→texto), TTS (`--output-modality audio`) e **speech-to-speech chat interleaved** ("Respond with interleaved text and audio").
- Arquitetura v1: **2 instâncias do LFM3-Audio-2B** (ESCUTA = asr+tradução+fala EN→PT; FALA = tradução+TTS PT→EN). STT/TTS dedicados (whisper.cpp, Parakeet, Kokoro, llama.cpp) ficam como **alternativas plugáveis D7/NÃO primário**.
- O único gate que fica de pé: **G3 — a API de geração streama a saída de fala?** (`audio_streamer` do MLX-VLM; `mlx_vlm.generate` baseline devolve WAV completo. README do port diz streaming "not implemented" — a F0 mede e decide; se não streamar por servidor, o orquestrador consume o modo batch por utterance (menor lag) ou o runtime serve o stream).
- Alternativa de STT-tempo-real (parciais de legenda): continua disponível via LM Studio 1.1.3 (realtime transcription) ou whisper.cpp — **só para as legendas parciais**, sem tirar o Audio-2B do núcleo.

**Correção (2026-11-18, tarde — após checagem direta no card HF):**
- O card oficial `LiquidAI/LFM3-Audio-2B-MLX-4bit` **documenta speech-to-speech chat** ("Respond with interleaved text and audio") e TTS (`--output-modality audio`) via MLX-VLM ≥ 0.7.11 — o achado "S2ST não documentado" de rev-arquiteturai está **superado** (fonte primária: https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-4bit). O que segue NÃO VERIFICADO: (a) S2S chat em PT (exemplos no card são EN; voice chat interleaved reportado English-only em runtime por tapioca #69); (b) streaming dessa saída (`mlx_vlm.generate` retorna WAV completo; `audio_streamer` existe na API mas o README do port diz "not implemented").
- **LM Studio 1.1.3** adicionou "local realtime voice transcription" (Mac/Win/Linux — https://lmstudio.ai/transcribe) ⇒ candidato a STT-tempo-real sem whisper.cpp na F0 (validar se a API REST expõe a transcrição). Saída de áudio/TTS via API **continua sem endpoint** (issue #1715 aberta mesmo na 0.4.8: "only supports completions, responses, models and embeddings" — https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1715).
- **Tabela de runtimes revisada (final — direção do dono):**
  | Papel | v1 | Alternativas plugáveis (D7) |
  |---|---|---|
  | ESCUTA (ASR+tradução+voz, EN→PT) | **LFM3-Audio-2B-8bit — instância 1** | STT p/ parciais: LM Studio 1.1.3 / whisper.cpp / Parakeet-FluidAudio |
  | **LLM TÉCNICO NO MEIO (exemplo 2)** | **LFM3-1.7B via omlx — estágio explícito do pipeline** | entre escuta e fala: recebe a pergunta traduzida (PT), re-gera sugestão técnica em streaming (bullets, cancelável por seq#), entrega o texto final à instância de fala |
  | FALA (tradução+TTS, PT→EN) | **LFM3-Audio-2B-8bit — instância 2** | Kokoro-82M, llama.cpp `/v1/realtime` |
  | ASSISTENTE (entrevista) | **LFM3-Audio-2B modo texto — instância 2 (reuso)** ou LFM3-1.7B via omlx | Qwen3-4B etc. |
  | Runtime dos modelos de texto | omlx | llama.cpp, LM Studio |
  | LM Studio | STT realtime (1.1.3) + texto | sem endpoint de áudio de saída (#1715 aberta) |

## 5. Divergências entre revisores (resolução)

- Chatterbox arquivado? → **não** (GitHub API): leitura errônea de frase do README; risco é "manutenção parada", não "arquivado".
- Kokoro 2× vs 3× vozes pt-BR → **3** (fonte oficial).
- Streaming no LFM3-Audio MLX → doc oficial diz streaming decoding existe; **MLX-VLM não implementa** (kilo: README); `llama-server /v1/realtime` é a rota documentada. F0 decide com medição.
- FluidAudio lista LFM3-Audio-2B como modelo integrado (rev-arquiteturai) — verificar versão exata antes de confiar; marcar como opção B do stack Swift.

---

## 7. Interfaces do pipeline com o LLM técnico no meio (exemplo 2) — 2026-11-18, direção do dono

```
AudioSource → (PCM 16 kHz) → VAD → Segment{áudio, t0, t1, seq, lang}
  → [LFM3-Audio-2B inst.1: ASR → tradução] → {texto PT, parciais}
       ├──► LEGENDA (parciais + confirmado)
       └──► (exemplo 2) → [LLM TÉCNICO — LFM3-1.7B via omlx:
                            sugestão técnica PT em streaming,
                            re-gera por pergunta, cancelável por seq#]
                              → texto PT final (editado/aprovado — aprovação fica imutável)
                                  → [LFM3-Audio-2B inst.2: TTS] → fala EN → som
```

- **Cenário 1 (conversa):** sem LLM no meio — a instância 1 (any-to-any) já faz ASR + tradução + voz.
- **Cenário 2 (entrevista técnica):** o LLM é **etapa obrigatória explícita** entre escuta e fala (não é reuso da instância 2 em modo texto): (1) é a etapa que mais raciocina — roda no omlx com batching + prefix-cache persistente; (2) re-gera enquanto o entrevistador fala — cancelamento por `seq#` monotônico, nunca bloqueia a escuta; (3) saída = bullets curtos (teleprompter) + texto completo opcional; (4) edição do usuário congela a sugestão (remove-a do fluxo de re-geração).
- Numerações: D9 = runtimes (omlx p/ texto; llama.cpp `/v1/realtime` fallback de voz; G3 arbitra D10) · D10 = LLM técnico no meio como estágio próprio no cenário 2.
