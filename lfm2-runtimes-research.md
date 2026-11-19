# Pesquisa: runtimes Apple Silicon para LFM2/LFM3 (18/11/2026)

## Descoberta-chave: LFM2-1.7B NÃO existe
- HF API `?search=LFM2-1.7B` → `[]` (vazio). `api/models/LiquidAI/LFM2-1.7B` → "Invalid username or password" (repo não público).
- Família LFM2 (blog jul/2025): 350M, 700M, 1.2B (+ depois 2.6B, 8B-A1B, 24B-A2B). LiquidAI nunca lançou 1.7B; confusão provável com Qwen3-1.7B (modelo de comparação no blog LFM2) ou o novo LFM3-1.7B.
- Sucessor atual: **LFM3-1.7B** (out/2026): 1.73B params, 256K ctx, **pt incluído** (16 idiomas), ~1 GB em 4-bit.
  - https://huggingface.co/LiquidAI/LFM3-1.7B | https://docs.liquid.ai/lfm/models/lfm3-1.7b
  - MLX oficial: LiquidAI/LFM3-1.7B-MLX-4bit/5/6/8bit/bf16 (4bit: 17k downloads)
  - GGUF oficial: LiquidAI/LFM3-1.7B-GGUF (Q4_0 QAD, Q4_K_M, Q5_K_M, Q6_K, Q8_0, F16)
- LFM2-1.2B (deprecated mas disponível): LiquidAI/LFM2-1.2B-GGUF.

## mlx-community (HF API author=mlx-community&search=LFM2, limite 100 — truncado, mas sem nenhum 1.7B na listagem)
- LFM2-1.2B: 4/5/6/8bit + bf16
- LFM2-2.6B(-Exp), 350M, 700M, 8B-A1B, LFM2-VL-*: 4/5/6/8bit + bf16
- LFM2.5-1.2B Base/Instruct: 4/5/6/8bit + bf16; LFM2.5-8B-A1B-MLX-4bit; LFM2.5-VL-1.6B
- NADA de LFM2-1.7B (nem oficial LiquidAI, nem comunidade)
- URLs: https://huggingface.co/collections/mlx-community/lfm2x

## Português
- LFM2 (350M-1.2B): idiomas = en,ar,zh,fr,de,ja,ko,es — SEM português. Blog: "multilingual focus: Japanese, Arabic, Korean, Spanish, French, German" (corpus 75% EN, 20% multi, 5% code).
  - https://www.liquid.ai/blog/liquid-foundation-models-v2-our-second-series-of-generative-ai-models
  - https://lmstudio.ai/models/lfm2 (lista de idiomas)
- LFM2.5-1.2B-Instruct: ainda sem pt (tags HF). LFM2.5-2.6B, 230M, 350M, VL-3B, 24B-A2B: COM pt ((tags HF: pt, it, vi, th, id, hi, ru, pl).
- LFM3-1.7B: EN,AR,ZH,FR,DE,IT,JA,KO,**PT**,ES,VI,TH,ID,HI,RU,PL → https://docs.liquid.ai/lfm/models/lfm3-1.7b

## Runtimes

### mlx-lm
- Server: `mlx_lm.server --model <repo>` → porta 8080; endpoints /v1/chat/completions + /v1/models; stream:true = SSE; campo `model` por request (troca de modelo); adapters; draft_model (speculative); KV cache quant ( territory --kv-bits 4).
- Docs: https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/SERVER.md — "não recomendado p/ produção, segurança básica".
- LFM3: **ainda não carrega** — pendente ml-explore/mlx-lm#2016 (aberto 27/10/2026). LFM3 funciona via mlx-vlm 0.8.0. LFM2.5-1.2B funciona com mlx-lm 0.32.2.
- Benchmark (issue #2016, Apple Silicon): LFM3-1.7B-MLX-4bit → decode 119.7 tok/s, prefill 39.1 tok/s (prompt 18 tok), pico 1.133 GB.
- Docs Liquid MLX: https://docs.liquid.ai/deployment/on-device/mlx

### LM Studio
- Server OpenAI-compat: /v1/models, /v1/responses, /v1/decisions, /v1/chat/completions, /v1/embeddings, /v1/completions (porta 1234) → https://lmstudio.ai/docs/developer/openai-compat
- Headless como serviço: https://lmstudio.ai/docs/developer/core/headless e https://lmstudio.ai/docs/advanced/headless (`lms server start`, JIT loading, estado restaurado no boot, auto-evict TTL)
- REST v0 com métricas de TTFT e tok/s: https://lmstudio.ai/docs/app/api/endpoints/rest
- Motores: llama.cpp (GGUF) + MLX engine (AppSil). LFM2: GGUF e MLX nativos (https://lmstudio.ai/models/lfm2: liquid/lfm2-350m/700m/1.2b). LFM2 tool calls suportados jan/2026 (0.3.38, https://lmstudio.ai/blog). LFM3: página https://lmstudio.ai/models/lfm3 — por ora só GGUF/LFM3-VL-2B 1.10 GB.
- MLX engine ainda sem parallel requests (blog 0.4.0) — contínuo batching só no llm-engine (llama.cpp).

### Ollama
- Oficial: `lfm3` (102.7k downloads, 1.1–1.7 GB, 256K, thinking + tools) → https://ollama.com/library/lfm3 — verificado com Ollama 0.40.16 (https://docs.liquid.ai/deployment/on-device/ollama)
- OpenAI-compat /v1 + streaming NDJSON nativo (stream:true), tools.
- Biblioteca antiga: lfm2 (só 24b agora) https://ollama.com/library/lfm2; lfm2.5 (8b/24b) https://ollama.com/library/lfm2.5
- Imports de GGUF HF: ollama run hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M
- Metal via llama.cpp; engine MLX da Ollama em evolução (2026): https://yage.ai/share/mlx-apple-silicon-en-20260331.html

### llama.cpp
- `llama serve -hf LiquidAI/LFM3-1.7B-GGUF:Q4_K_M` → UI + API OpenAI-compatible na porta 9931; brew install llama.cpp; **LFM3 exige v0.8.0 (b11960)+**; Q4_0 = QAD (quant-aware distillation); docs oficiais Liquid: https://docs.liquid.ai/deployment/on-device/llama-cpp
- Histórico LFM2-1.2B-Q4_0 (CPU): Mac Mini M4 → prefill 1427 tok/s, decode 122 tok/s (melhor que Ryzen/Intel/Snapdragon na tabela).
- Suporta todos os LFM2.x GGUF; multimodal lfm3-vl com mmproj.

### vLLM no Mac
- vllm-metal (plugin oficial da vllm-project, executa via MLX/Metal): v0.28.0 (set/2026), v0.29.0 via brew; macOS 15+; scheduler V1, paged KV, chunked prefill, OpenAI server com streaming + parsing de tool calls; suporte a hybrid models e GGUF; M5 NAX prefill.
  - https://github.com/vllm-project/vllm-metal | https://vllm.ai/blog/2026-09-22-vllm-metal-v0-28-0 | docs https://docs.vllm.ai/projects/vllm-metal/en/latest/ | Docker: https://www.docker.com/blog/docker-model-runner-vllm-metal-macos/
- vLLM nativo (CUDA): 0.34.0 adiciona LFM3 → docs.liquid.ai/lfm/models/lfm3-1.7b
- vLLM não roda Metal puro sem o plugin — no mac, vllm-metal == MLX por baixo.

### Servidores MLX da comunidade
- mlx-openai-server (FastAPI; forks: RutgerLubbers, brunopistone, cubist38; PyPI): OpenAI-compat, launch CLI com model-types (lm/multimodal/embeddings/whisper/image-gen), tool-call parsers, config com vários modelos, CLI `list models` (2 configured, 1 loaded).
  - https://github.com/RutgerLubbers/mlx-openai-server | https://pypi.org/project/mlx-openai-server/
- omlx (jundot/omlx): continuous batching + SSD caching, menu bar app, admin Web UI: https://github.com/jundot/omlx
- Rapid-MLX (raullenchai): OpenAI+Anthropic-compat, foco em tool calling p/ coding agents, 4x mais rápido que mlx-lm em CLI benchmarks: https://github.com/raullenchai/Rapid-MLX

## Benchmarks MLX vs llama.cpp (M-series)
- MLX decode tipicamente 15–30% mais rápido que llama.cpp Metal: https://aiagentskit.com/blog/mlx-vs-llama-cpp-apple-silicon/
- MLX 20–87% mais rápido em <8B: https://medium.com/@michael.hannecke/choosing-an-on-device-llm-runtime-on-apple-silicon-a-decision-framework-beyond-benchmarks-2449067b8b67
- M5 MLX accelerators: TTFT 4.06x vs M4, gen 1.19x: https://yage.ai/share/mlx-apple-silicon-en-20260331.html
- Agregador 619 datapoints M1–M6: https://llmcheck.net/benchmarks
- Ollama fica ~igual a llama.cpp (mesmo backend) com overhead do runtime Go.
