[0m
> code · reflection/beam-free
[0m
[0m→ [0mRead docs/adr/ADR-001-arquitetura.md
[0m◈ [0mExa Web Search "Liquid AI LFM Open License v1.0 terms commercial limit"
[0m◈ [0mExa Web Search "LFM3-Audio-2B 140ms first audio 280 tok/s M4 Max benchmark"
[0m◈ [0mExa Web Search "LFM3-Audio-2B-MLX-4bit model capabilities speech-to-speech translation Portuguese"
[0m◈ [0mExa Web Search "LFM3-1.7B model context length 256K mlx tok/s specifications"
[0m◈ [0mExa Web Search "mlx-lm prompt cache prefix caching LFM3 support streaming audio output MLX-VLM"
[0m◈ [0mExa Web Search "LM Studio audio streaming LFM3-Audio-2B server OpenAI audio modality"
# Relatório de Revisão Adversarial — ADR-001 (Falador)

**Arquivo:** `/Users/otaviolemos/ml/falador/docs/adr/ADR-001-arquitetura.md` · **Status:** Decidido (2026-11-18) · **Escopo auditado:** D1–D8
**Hardware alvo:** M4 Pro 48 GB · **Caso de uso:** tradução simultânea EN↔PT em conferências, 100% on-device.

> Convenção: afirmações não verificáveis estão marcadas **NÃO VERIFICADO**. Nenhum arquivo foi editado.

## Sumário executivo

- A decisão central (D6) é a mais frágil: o ADR assume "streaming nativo" do LFM3-Audio-2B via MLX, mas a documentação do MLX-VLM afirma explicitamente que **streaming de entrada e saída não está implementado** (incluindo LiveASR). Isso invalida a promessa de "1º áudio ~140 ms" e de legendas parciais em tempo real.
- O runtime proposto (LM Studio headless) **não expõe endpoints de áudio** (`/v1/audio/*` está em issue aberta). Para streaming real de áudio, o runtime viável hoje é `llama-server` (b11960+) com `/v1/realtime` WebSocket, ou `mistral.rs`.
- A arquitetura de 3 processos (D8) é conceitualmente correta, mas a promessa de "prompt-cache do prefixo" como ganho de TTFT é otimista: `mlx-lm` não carrega LFM3 (issue #2016) e o server do `mlx-vlm` limpa o cache Metal após cada request (issue #999).
- Licença (D5), hardware (D4) e plugabilidade (D7) são sólidos. D1/D2/D3 precisam de ajustes (eco, PT-BR).

## Metodologia / fontes verificadas

- Model card LFM3-Audio-2B (HF + docs.liquid.ai) — idiomas, licença, streaming, LiveASR inglês-only.
- MLX-VLM README (`mlx_vlm/models/lfm3_audio/README.md`) — "streaming input and output are not implemented".
- oMLX benchmarks — tok/s por chip.
- mlx.app — estimativas M4 Pro.
- Liquid AI license page + LICENSE (LFM3-1.7B) — threshold US$ 10M.
- Issue mlx-lm #2016, mlx-vlm #999, LM Studio #1715.
- TypeWhisper benchmark — WER PT 7.8–9.8%.

## Auditoria por decisão

### D1 — Captura/reprodução pelos dispositivos padrão (sem BlackHole, sem bot)

- **Erros/imprecisões:** Nenhum factual direto. O ADR reconhece o risco de eco e lista BlackHole como upgrade plugável — consistente com D7.
- **Riscos de latência:** **Alto.** TTS sai pelo alto-falante (D2) enquanto o mic capta a sala → realimentação acústica. O Silero VAD pode disparar com o próprio TTS, gerando segmentos espúrios e loop de tradução. Aumenta RTF efetivo e pode saturar o pipeline de escuta.
- **Alternativas mais viáveis:** captura de loopback do sistema via CoreAudio tap / BlackHole (já previsto como upgrade); AEC (echo cancellation) no pré-processamento; ou captura separada de "remote audio" vs "mic" em apps que expõem (Zoom/Teams SDK). Para v1 pessoal, manter com AEC.
- **Veredicto:** **AJUSTA** (manter v1, mas adicionar AEC + caminho de upgrade de loopback documentado).

### D2 — Voz TTS sai pelo som do notebook

- **Erros/imprecisões:** Nenhum.
- **Riscos de latência:** Mesmo risco de D1 (eco → re-trigger do VAD). Além disso, latência de reprodução pelo alto-falante + captura do mic pode inflar o "Average Lagging" percebido.
- **Alternativas:** Fone de ouvido (elimina eco por hardware) como recomendação de uso; ou roteamento para dispositivo virtual em cenários de gravação.
- **Veredicto:** **AJUSTA** (recomendar fone de ouvido na documentação de uso; manter arquitetura).

### D3 — Idiomas selecionáveis; v1 valida EN↔PT-BR

- **Erros/imprecisões:** O modelo expõe "Portuguese" genérico, não PT-BR específico. Vozes PT são genéricas ("Portuguese" male/female). **NÃO VERIFICADO** se existe variante PT-BR distinta ou acento brasileiro aceitável. WER PT no benchmark TypeWhisper: 7.8–9.8% (PT genérico), abaixo da mediana do campo (~7.3% Common Voice PT).
- **Riscos de latência:** Nenhum direto; mas qualidade de ASR em PT-BR com sotaque regional pode degradar WER e aumentar reprocessamento.
- **Alternativas:** Validar PT-BR na F0 com amostras reais; fallback para Whisper large-v3-turbo (parciais) se WER alto; considerar fine-tune (LFM suporta fine-tuning, NÃO VERIFICADO viabilidade).
- **Veredicto:** **AJUSTA** (manter seletor, mas trocar "PT-BR" por "Portuguese" até validação; adicionar teste de WER PT-BR na F0).

### D4 — Hardware alvo M4 Pro 48 GB

- **Erros/imprecisões:** M4 Pro existe em configuração de 48 GB (verificado: 24 GB ou 48 GB). Afirmação correta.
- **Riscos de latência:** **Médio/Alto.** O ADR cita "~280 tok/s em M4 Max" mas o alvo é M4 Pro. M4 Pro tem bandwidth menor (~68–121 tok/s para LFM3-1.7B 8-bit, estimativa mlx.app). **NÃO VERIFICADO** tok/s do Audio-2B em M4 Pro especificamente. A contenção entre 3 processos em M4 Pro (menos bandwidth que M4 Max) é o risco real.
- **Alternativas:** Benchmark na F0 no M4 Pro real; se insuficiente, considerar M4 Max (maior bandwidth) ou reduzir para 2 processos em cenário 1.
- **Veredicto:** **MANTÉM** (hardware válido; exigir benchmark real na F0).

### D5 — Licença LFM Open License v1.0

- **Erros/imprecisões:** Nenhum. Threshold US$ 10M de receita anual, aplicado à Legal Entity (grupo corporativo). Uso pessoal sem receita = licenciado. "Limite comercial = receita < US$ 10M" correto.
- **Riscos de latência:** Nenhum.
- **Riscos não-latência:** Se o projeto virar produto/empresa, precisa licença comercial. "Commercial Use" inclui uso interno com vantagem comercial, mesmo sem receita direta — risco de interpretação.
- **Alternativas:** Manter modelos LFM; documentar a limitação; se comercializar, contatar sales@liquid.ai. Alternativas open-source sem threshold: Whisper (MIT), Kokoro (Apache-2.0) — mas perdem integração.
- **Veredicto:** **MANTÉM** (para v1 pessoal; documentar limite).

### D6 — LFM3-Audio-2B (MLX) para escuta e fala; STT+tradução+TTS num modelo só; 2 instâncias

- **Erros/imprecisões (críticos):**
  1. **"Streaming nativo" / "1º áudio ~140 ms":** A doc do MLX-VLM afirma explicitamente: *"streaming input and output are not implemented, including the card's LiveASR"*. O ADR trata isso como "gargalo a validar na F0", mas já é um não-suporte documentado. **Impossível atingir streaming real via MLX-VLM hoje.**
  2. **"~280 tok/s em M4 Max":** **NÃO VERIFICADO.** Benchmarks oMLX mostram ~88–117 speech slots/s e 88–90 tok/s decode (bf16/8-bit) em M3 Ultra/M3 Max; prefill ~2.8k–3.4k tok/s. 280 tok/s pode ser prefill em M4 Max ou confusão. Marcar NÃO VERIFICADO.
  3. **"STT, tradução e TTS num modelo só":** Parcialmente verdade. O modelo faz ASR, *speech-to-text translation* (EN↔PT texto) e TTS separadamente, mas **não é S2ST end-to-end** num único forward. Para fala traduzida é preciso orquestrar: ASR EN → texto PT → TTS PT. E "voice chat" interleaved (Respond with interleaved text and audio) é **inglês-only**. Para PT, pipeline obrigatório.
  4. **"PT nas 2 direções":** Modelo suporta Portuguese + tradução to/from English "generally works best". EN→PT speech-to-text é suportado via prompt, mas qualidade **NÃO VERIFICADO** (sem benchmark público de S2ST EN→PT — o próprio ADR reconhece).
  5. **"LiquidCodec (streaming nativo)":** O codec suporta streaming decoding (87× real-time em M4 Max), mas o binding MLX não expõe streaming de saída. Via `llama-server`/`mistral.rs` o streaming funciona.
  6. **"4-bit" como padrão:** A doc MLX recomenda 8-bit ("Use 8 bits by default; 4 bits is the small option and loses accuracy"). 4-bit tem WER PT pior (8.8% vs 0% em clip curto) e 68% de concordância de speech codes com float32. Para conferência, 8-bit é mais defensável.
  7. **Contexto 32K:** áudio = ~12.5 tokens/s → 32K ≈ 42 min. Reuniões longas estouram contexto; ADR não menciona chunking/split. **NÃO VERIFICADO** se o ADR prevê isso.
- **Riscos de latência:** **Muito alto** (bloqueante). Sem streaming real via MLX, a latência será batch (utterance inteira → texto → TTS) = segundos, não "extrema". Contenção de GPU entre 2 instâncias Audio-2B + assistente em M4 Pro. `mlx-vlm` server limpa cache após cada request (issue #999) → sem prefix cache entre turnos.
- **Alternativas mais viáveis:**
  - **Runtime:** `llama-server` b11960+ com `/v1/realtime` WebSocket (streaming real speech-to-speech) ou `mistral.rs` (SSE pcm16). Ambos suportam LFM3-Audio streaming.
  - **STT com parciais:** `whisper.cpp` large-v3-turbo (Metal) ou Parakeet/FluidAudio para legendas em tempo real (o ADR já prevê como plug).
  - **TTS PT-BR dedicado:** Kokoro-82M (3 vozes pt-BR, Apache-2.0) para qualidade de voz brasileira; Chatterbox (MIT, repo arquivado — **NÃO VERIFICADO** status).
  - **Quantização:** 8-bit (2.33 GB) em vez de 4-bit para qualidade; ainda cabe 2× em 48 GB.
- **Veredicto:** **AJUSTA** (não derruba o modelo, mas trocar runtime para streaming real, subir para 8-bit, e reescrever a promessa de latência). D7 (plugabilidade) é o salva-vidas aqui.

### D8 — Cenário 2 (entrevista) = 3 processos

- **Erros/imprecisões:**
  1. **Numeração fora de ordem:** A tabela de decisões lista D8 antes de D7 (linha 21 antes de linha 22). Inconsistência documental.
  2. **Typo:** "nunca pode **serrarse** para raciocinar" — provavelmente "se bloquear"/"se perder".
  3. **"prompt-cache do prefixo da conversa":** A infraestrutura existe em `mlx-lm` (LRUPromptCache, trim), mas **LFM3-1.7B não é suportado em `mlx-lm`** (issue #2016). Em `mlx-vlm`, o server limpa cache após cada request (issue #999), destruindo o prefix cache. A promessa de "TTFT baixo via prompt-cache" requer implementação manual (common_prefix_len + trim_prompt_cache) e desabilitar o clear agressivo. **NÃO VERIFICADO** que o ADR prevê essa implementação.
  4. **"~119 tok/s decode em MLX":** **NÃO VERIFICADO** para M4 Pro. Estimativa mlx.app para M4 Pro 8-bit: 68–121 tok/s. 119 é o extremo superior da faixa. Plausível, mas no limite.
  5. **"custo total ≈ 4–7 GB em 4-bit":** Plausível (2× Audio-2B 4-bit ≈ 3.46 GB + LFM3-1.7B 4-bit ≈ 1 GB + overhead), mas **NÃO VERIFICADO** exato (incluindo KV cache em 32K).
  6. **"cenário 1 usa B=ON/BD" (linha 52):** **NÃO VERIFICADO** o significado (provavelmente "B=ON/OFF" de botão?). Ambíguo.
- **Riscos de latência:** **Alto.** 3 processos competindo por Metal em M4 Pro; assistente re-gera a cada segmento (debounce + prompt-cache necessários); se o prompt-cache não funcionar, prefill completo a cada turno = segundos. Contenção pode degradar a escuta (caminho crítico).
- **Alternativas:** Manter 3 processos (conceito correto), mas: (a) implementar prefix cache manualmente ou usar `llama-server` (que tem prompt cache nativo); (b) debounce configurável + re-geração só em pausas; (c) considerar modelo menor (LFM3-1.7B já é o menor da família LFM3; alternativa Qwen3-1.7B).
- **Veredicto:** **AJUSTA** (manter arquitetura de 3 processos, corrigir numeração/typo, e rebaixar expectativa de prompt-cache automático).

### D7 — Cada etapa plugável por interface (STT/TRAD/TTS trocáveis)

- **Erros/imprecisões:** Nenhum. A interface (AudioSource → VAD → Segment → SttPort → TranslatorPort → TtsPort) é bem definida.
- **Riscos de latência:** Baixo (overhead de abstração mínimo). O risco é implementação incorreta das filas entre processos (backpressure).
- **Alternativas:** Manter. É a decisão mais sólida do ADR e o que permite pivotar D6 sem reescrever.
- **Veredicto:** **MANTÉM**.

## Achados transversais

| # | Tipo | Detalhe |
|---|------|---------|
| 1 | Numeração | D8 aparece antes de D7 na tabela de decisões (ordem inconsistente). |
| 2 | Typo | "serrarse" (D8). |
| 3 | Ambiguidade | "cenário 1 usa B=ON/BD" (diagrama, linha 52) não definido. |
| 4 | Inconsistência de hardware | Benchmark citado em M4 Max, alvo é M4 Pro. |
| 5 | Runtime inviável | LM Studio headless não suporta `/v1/audio/*` (issue #1715 aberta). |
| 6 | Streaming não suportado | MLX-VLM não implementa streaming I/O (inclui LiveASR). |
| 7 | F0 otimista | "1-2 dias" subestima a complexidade (streaming real + prompt-cache manual). |
| 8 | NÃO VERIFICADO | Kokoro "3 vozes pt-BR", Chatterbox "repo arquivado", mlx-openai-server, tok/s 280, PT-BR específico, custo 4–7 GB, 119 tok/s, "B=ON/BD". |

## Tabela resumo de veredictos

| Decisão | Veredicto |
|---|---|
| D1 | AJUSTA |
| D2 | AJUSTA |
| D3 | AJUSTA |
| D4 | MANTÉM |
| D5 | MANTÉM |
| D6 | AJUSTA (crítico) |
| D7 | MANTÉM |
| D8 | AJUSTA |

## Recomendações prioritárias

1. **Trocar o runtime de áudio** de LM Studio para `llama-server` (b11960+) com `/v1/realtime`, ou `mistral.rs`, para obter streaming real. Atualizar F0.
2. **Subir D6 de 4-bit para 8-bit** (qualidade WER PT + speech codes).
3. **Reescrever a promessa de latência:** "extrema" só é alcançável com streaming real; via MLX-VLM atual é batch (segundos).
4. **Implementar prefix cache manualmente** ou migrar assistente para `llama-server` (que tem prompt cache nativo); não assumir cache automático.
5. **Validar PT-BR** na F0 com amostras reais; ajustar D3 de "PT-BR" para "Portuguese" até validação.
6. **Adicionar AEC / recomendar fone de ouvido** para mitigar eco (D1/D2).
7. **Adicionar chunking de contexto** (32K ≈ 42 min) para reuniões longas.
8. **Corrigir numeração (D7/D8), typo "serrarse" e ambiguidade "B=ON/BD"**.
9. **Reestimar F0** para 3–5 dias.
