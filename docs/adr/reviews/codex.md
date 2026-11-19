OpenAI Codex v0.170.0
--------
workdir: /Users/otaviolemos/ml/falador
model: gpt-6.1-sol
provider: openai
approval: never
sandbox: read-only
reasoning effort: high
reasoning summaries: none
session id: 01a1f0f0-bbbc-7de0-b940-c2ad587fa390
--------
user
Revisão adversarial linha a linha do ADR de arquitetura do projeto "Falador": tradução simultânea EN<->PT em conferências, 100% on-device no Apple Silicon (M4 Pro 48GB), latência extrema. Leia o arquivo /Users/otaviolemos/ml/falador/docs/adr/ADR-001-arquitetura.md e audite as decisões D1-D8: (1) erros/imprecisões; (2) riscos de latência; (3) alternativas de modelos/arquitetura mais viáveis; (4) veredicto por decisão: mantém/ajusta/derruba. NÃO invente: marca não verificável como "NÃO VERIFICADO". NÃO EDITE ARQUIVOS. Responda em português, relatório markdown estruturado.
hook: SessionStart
hook: SessionStart
hook: SessionStart Completed
hook: SessionStart Completed
hook: UserPromptSubmit
hook: UserPromptSubmit
hook: UserPromptSubmit Completed
hook: UserPromptSubmit Completed
codex
Vou ler o ADR e confrontar D1–D8 com fontes primárias, focando latência, execução local e evidências para as escolhas de modelos. Não alterarei arquivos; o que não conseguir confirmar ficará marcado como “NÃO VERIFICADO”. Usarei as orientações de revisão do Ponytail. Se quiser, também posso fazer algumas perguntas curtas sobre o cenário de uso; pode pular essa etapa.
exec
/bin/zsh -lc 'cat /Users/otaviolemos/.codex/skills/using-superpowers/SKILL.md /Users/otaviolemos/.codex/plugins/cache/ponytail/ponytail/5.3.3/skills/ponytail/SKILL.md /Users/otaviolemos/.codex/plugins/cache/ponytail/ponytail/5.3.3/skills/ponytail-review/SKILL.md' in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
---
name: using-superpowers
description: Use when starting any conversation - establishes how to find and use skills, requiring skill invocation before ANY response including clarifying questions
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, ignore this skill.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If you think there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST invoke the skill.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

## The Rule

**Invoke relevant or requested skills BEFORE any response or action** — including clarifying questions, exploring the codebase, or checking files. If it turns out wrong for the situation, you don't have to use it.

**Before entering plan mode:** if you haven't already brainstormed, invoke the brainstorming skill first.

Then announce "Using [skill] to [purpose]" and follow the skill exactly. If it has a checklist, create a todo per item.

## Skill Priority

When multiple skills apply, process skills come first — they set the approach, then implementation skills (frontend-design, etc.) carry it out. Brainstorming and systematic-debugging are Superpowers' most common process skills, but the rule holds for any of them.

- "Let's build X" → superpowers:brainstorming first, then implementation skills.
- "Fix this bug" → superpowers:systematic-debugging first, then domain skills.

## Red Flags

These thoughts mean STOP—you're rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check git/files quickly" | Files lack conversation context. Check for skills. |
| "Let me gather information first" | Skills tell you HOW to gather information. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Read current version. |
| "This doesn't count as a task" | Action = task. Check for skills. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |
| "This feels productive" | Undisciplined action wastes time. Skills prevent this. |
| "I know what that means" | Knowing the concept ≠ using the skill. Invoke it. |

## Platform Adaptation

If your harness appears here, read its reference file for special instructions:

- Codex: `references/codex-tools.md`
- Pi: `references/pi-tools.md`
- Antigravity: `references/antigravity-tools.md`
- Hermes Agent: `references/hermes-tools.md`

## User Instructions

User instructions (CLAUDE.md, AGENTS.md, GEMINI.md, etc, direct requests) take precedence over skills, which in turn override default behavior. Only skip skill workflows or instructions when your human partner has explicitly told you to.
---
name: ponytail
description: >
  Lazy senior dev mode: the smallest change that fully solves the task, and a
  reply a busy human understands in one read. Use on any coding task (writing,
  fixing, refactoring, reviewing, choosing dependencies) and when the user says
  "ponytail", "be lazy", "simplest solution", "yagni", or complains about
  over-engineering or bloat. Levels: lite, full (default), ultra.
argument-hint: "[lite|full|ultra|off]"
license: MIT
---

# Ponytail

You are a lazy senior developer. The best code is the code never written. You solve the whole problem with the least new code. End your reply with one or two lines: what you skipped or did not check, and any risk the user must know.

Active for the whole session until the user says "stop ponytail" or "normal mode". Switch level: `/ponytail lite|full|ultra`.

## Before you write

Read the task and the code it touches. List every place your change must reach: callers, tests, fixtures, config, exports. Check what your change could break for users: data it would destroy or expose, callers that stop working. That is scope. Extra features are not.

## The smallest complete change

Take the first option that fully works:

1. Does it need to exist? Skip features, options and flexibility nobody asked for, and name them in one line. A vague request ("build me X") gets the smallest version that does the core job.
2. Already in this codebase (a helper, component, service, pattern)? Use it the way the surrounding code does.
3. Standard library or a platform feature? Use it, unless the project has its own. A house component beats a native widget.
4. An installed dependency? Use it. Never add a dependency for a few lines.
5. Can it be one line a reader gets at a glance? One line.
6. Otherwise: the minimum code that works.

- Be lazy about the solution, never about the change itself: finish every part the task needs, including the callers, tests and fixtures your change breaks.
- No abstraction, wrapper, type conversion, option, config, boilerplate or "for later" code nobody asked for. Keep values in the form the platform already gives you. Deletion beats addition. Keep the structure the codebase already has: its layers, interfaces and conventions.
- The shortest working diff wins, once you know everything it must touch. A one-liner that needs decoding is not short.
- Comment only the why the code cannot show, in one line.
- Bug fix: before you edit, grep every caller of the function you touch, then fix the root cause once in the shared code.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- Lazy code without its check is unfinished: new non-trivial logic (a branch, a loop, a parser, money or security, or a whole new script or app) leaves one small test or an assert-based self-check. Trivial changes need none.
- A shortcut with a known limit gets a code comment in this form: `shortcut: <the limit>, <when to upgrade>`.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs, anything the user asked for.

## Levels

| Level | Behavior |
|-------|----------|
| **lite** | Build what was asked. Name the smaller option in one line and let the user pick. |
| **full** | The rules above. Default. |
| **ultra** | Also question the request: before building, push back on any part the need does not justify. |
---
name: ponytail-review
description: >
  Quality review of a change: is the logic right, is it safe, does it hold
  under real load, is risky code tested, is it fast enough, and is every line
  needed. Reads the connected code, not only the diff. Each finding is
  explained in plain English. Use for "review this", "code review", "review
  the last commit", "review my PR", "is this over-engineered", /ponytail-review.
---

Review a change like the senior developer who will be paged when it breaks.
Order of importance: correct, safe, holds under load, tested, fast, lean.
Lean still matters: every extra line must be read, tested and fixed later.
This is a report the user asked for, so give it in full.

## 1. Understand first

- Review what the user names: uncommitted or staged changes, a branch, a PR
  link, or files. Nothing named: the uncommitted changes, or the last commit
  if there are none.
- Read the diff, then the code it touches: callers of every changed function,
  the functions it calls, the tests, the README.
- Trace the real flow: where data comes in, what is stored, what goes out.
- A change can break code it does not touch. When a signature, return value
  or behavior changes, grep every caller.
- Find the expected load in the repo (README, deploy config): one person
  running a script, or many users and processes at once. Judge scale against
  that, and say which load you assumed.

## 2. Look for

1. **Bug:** wrong result, crash, missed edge case (empty, zero, last item,
   rounding, time zones), a caller broken by the change, a fix applied in one
   caller while the shared function stays broken.
2. **Risk:** security holes (injection, weak randomness, secrets, missing
   checks on input from users), data loss (errors swallowed, writes in the
   wrong order, no transaction).
3. **Scale:** fine for one user, wrong for many: check-then-write races, the
   same work done by every process, memory or lists that only grow, a query
   per item, O(n^2) on big input, per-process state that must be shared.
4. **Missing test:** risky new logic (a branch, a parser, money, security,
   data writes, a bug fix) with no test that fails when it breaks. One good
   test, not coverage.
5. **Speed:** big slowdowns are problems. Small wins (work repeated in a hot
   loop) are suggestions; some software counts every millisecond.
6. **Lean:** code that should not exist or should be smaller.
   - delete: dead code, unused options, speculative features
   - reuse: the repo already has this helper (name the path)
   - stdlib / native: the standard library or platform already does it; a
     new dependency for a few lines
   - yagni: abstraction with one implementation, config nobody sets
   - merge: near-copies that must change together
   - split: one function doing several unrelated jobs, so it is hard to read
     or test. Split by job, never by line count, and never into helpers that
     exist only to make a function shorter.

## 3. Check before you report

- Every finding needs a concrete case: "this input or situation leads to this
  wrong result". No case, no finding.
- Re-read the lines and confirm: the caller exists, the value can really be
  empty, the code really is unused.
- A shortcut marked with a `shortcut:` (or older `ponytail:`) comment that names its limit is a
  decision, not a finding, unless the expected load already crosses it.
- Propose the smallest fix that works. Prefer fixes that delete code. Never
  add layers, frameworks or config the problem does not need.
- No style taste, no "consider", no vague worries.

## 4. Output

Very simple English: short sentences, everyday words. Explain a technical
term the first time you use it. The reader may never have seen this code.

Start with `What this change does:` in two or three sentences.

Then the findings in three groups, skip empty groups:
- **Must fix:** bug, security, data loss, breaks at the expected load.
- **Should fix:** risky code without a test, real slowness, duplication, a
  function that mixes jobs, code that should not exist.
- **Nice to have:** small speed-ups, shorter forms.

Number findings across all groups, so the user can say "fix 2 and 5".
Every finding has all four parts, each one or two short sentences:

2. **Orders land on the wrong day** (`billing/close_day.py:L40-52`)
   - **What this is:** At midnight this job closes the day and bills all orders of that day.
   - **Problem:** It takes "today" from the server clock, which runs in UTC. An order placed
     at 00:30 in Berlin is billed on the day before.
   - **Fix:** Compute the day once in the shop's time zone:
     `datetime.now(ZoneInfo("Europe/Berlin")).date()`. One line, nothing else changes.
   - **If we skip it:** Late orders show the wrong date, and accounting fixes them by hand.

End with:
- `Verdict: Ship.` or `Verdict: fix 1 and 3 first.`
- `Lean: -<N> lines possible.` when lean findings exist.
- `Not checked:` one line, if something mattered and you could not check it.

Nothing found: `What this change does:`, then `Looks good. Ship.` and one line
on what you checked.

Lists findings, changes no code.

exec
/bin/zsh -lc pwd in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
/Users/otaviolemos/ml/falador

exec
/bin/zsh -lc "rg --files -g AGENTS.md -g '*README*' -g 'pyproject.toml' -g 'package.json' -g '*ADR*' -g '*arquitetura*'" in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
docs/adr/ADR-001-arquitetura.md

exec
/bin/zsh -lc 'nl -ba docs/adr/ADR-001-arquitetura.md' in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
     1	# ADR-001 — Arquitetura · Falador (tradução simultânea em conferências)
     2	
     3	> **Status:** Decidido (2026-11-18) · **Decisor:** Otávio Lemos · **Escopo:** v1, uso pessoal, Apple Silicon
     4	
     5	## 1. Problema
     6	
     7	Conversas em conferência (Teams, Zoom, Meet, WhatsApp) onde A fala um idioma e B fala outro.
     8	O Falador transcreve, traduz em tempo real (legendas) e responde por voz no idioma do outro participante.
     9	Cenário extra: entrevista/help — traduzir **e** dar sugestões técnicas ao usuário enquanto ele acompanha.
    10	
    11	## 2. Decisões tomadas (ADR)
    12	
    13	| # | Decisão |
    14	|---|---|
    15	| D1 | Áudio capturado/reproduzido pelos **dispositivos padrão do notebook** (mic + alto-falantes). Sem BlackHole, sem bot participante na v1 |
    16	| D2 | Voz TTS sai pelo som do notebook (uso pessoal; não há canal de intérprete na reunião) |
    17	| D3 | **Idiomas selecionáveis** na UI; v1 valida EN↔PT-BR |
    18	| D4 | Hardware alvo: **M4 Pro 48 GB** |
    19	| D5 | Licença: **LFM Open License v1.0** aceitável (uso pessoal; limite comercial = receita < US$ 10M — https://www.liquid.ai/lfm-license) |
    20	| D6 | **LFM3-Audio-2B (MLX) para escuta e fala na v1** — STT, tradução e TTS num modelo só, rodando em **2 instâncias** (escuta + fala) |
    21	| D8 | **Cenário 2 (entrevista) = 3 processos**: ESCUTA (Audio-2B) + **ASSISTENTE (LFM3-1.7B, texto)** + FALA (Audio-2B). O assistente é processo próprio — **a escuta é o caminho crítico de latência e nunca pode serrarse para raciocinar** |
    22	| D7 | Cada etapa do pipeline é **plugável por interface** (STT/TRAD/TTS trocáveis por config) — o whisper.cpp volta como opção de STT se o lag do modo D6 se mostrar pior na prática |
    23	
    24	## 3. Arquitetura
    25	
    26	```
    27	┌────────────────────────── FALADOR (app local, macOS, M4 Pro 48GB) ───────────────────────────┐
    28	│                                                                                               │
    29	│  CAPTAÇÃO (D1)                  NÚCLEO DE STREAMING                    SAÍDA                  │
    30	│  ┌──────────────┐  PCM 16kHz   ┌───────────────────────┐                                │
    31	│  │ mic padrão   │────────────► │ VAD (Silero v5, ONNX, │                                │
    32	│  │ (outros      │              │ CPU — não compete GPU)│                                │
    33	│  │  participantes│             └──────────┬────────────┘                                │
    34	│  │  via alto-    │                       ▼  segmento de fala (utterance)                  │
    35	│  │  falante)     │          ┌─ PROC. 1: ESCUTA (LFM3-Audio-2B) ────┐   ┌───────────────┐     │
    36	│  └──────────────┘          │ áudio → texto PT (stream, legenda)   │   │ UI: legendas  │     │
    37	│                            │         + áudio PT (LiquidCodec)     │──►│  por segmento │     │
    38	│                            └──────────────┬───────────────────────┘   └───────────────┘     │
    39	│                                           │ cada segmento confirmado                        │
    40	│                                           ▼                                                 │
    41	│                            ┌─ PROC. 2: ASSISTENTE (LFM3-1.7B) ────┐   ┌───────────────┐     │
    42	│                            │ cenário 2 (entrevista):              │   │ UI: painel de │     │
    43	│                            │ re-gera sugestão de resposta técnica │──►│  sugestão     │     │
    44	│                            │ em PT (streaming, prompt-cache do    │   │  (B edita/    │     │
    45	│                            │ prefixo da conversa p/ TTFT baixo)   │   │   aprova)     │     │
    46	│                            └──────────────┬───────────────────────┘   └───────┬───────┘     │
    47	│                                           │ texto PT escolhido/                │            │
    48	│                                           │ digitado por B                     │            │
    49	│                                           ▼                                    │            │
    50	│                            ┌─ PROC. 3: FALA (LFM3-Audio-2B) ───────┐          │            │
    51	│                            │ texto PT → fala EN (streaming,        │◄─────────┘            │
    52	│                            │ LiquidCodec; cenário 1 usa B=ON/BD)   │                       │
    53	│                            └───────────────────────────────────────┘                       │
    54	└───────────────────────────────────────────────────────────────────────────────────────────────┘
    55	```
    56	
    57	### Modelos (menu plugável — D6/D7)
    58	
    59	| Papel | Padrão v1 | Alternativas plugáveis |
    60	|---|---|---|
    61	| STT+S2ST (Proc. 1 escuta / Proc. 3 fala) | **LiquidAI/LFM3-Audio-2B-MLX-4bit** — PT nas 2 direções, 1º áudio ~140 ms, ~280 tok/s em M4 Max; docs: https://docs.liquid.ai/lfm/models/lfm3-audio-2b · https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-bf16 | whisper.cpp large-v3-turbo (Metal, parcial de legenda): https://github.com/ggml-org/whisper.cpp · Parakeet v3/FluidAudio: https://github.com/FluidInference/FluidAudio · Qwen3-ASR MLX: https://github.com/moona3k/mlx-qwen3-asr |
    62	| Assistente técnico (Proc. 2) | **LFM3-1.7B** (texto, 256K ctx, tool calling; ~119 tok/s decode em MLX): https://docs.liquid.ai/lfm/models/lfm3-1.7b · https://github.com/ml-explore/mlx-lm/issues/2016 | Qwen3-1.7B, cualquier servidor OpenAI-compatible local; o próprio Audio-2B em modo texto (menos indicado: ocuparia a voz do processo de escuta) |
    63	| TTS | LiquidCodec (dentro do Audio-2B, streaming nativo) | Kokoro-82M (3 vozes pt-BR, Apache-2.0): https://github.com/hexgrad/kokoro · Chatterbox Multilingual (MIT, clone de voz; repo arquivado): https://github.com/resemble-ai/chatterbox |
    64	| Runtime LLM | **LM Studio headless** (`lms server start`, API OpenAI /v1 + SSE) ou `mlx-openai-server` (pip) | llama.cpp `llama-server` (LFM3 precisa v0.8.0+): https://docs.liquid.ai/deployment/on-device/llama-cpp · Ollama `lfm3`: https://ollama.com/library/lfm3 |
    65	
    66	Ports MLX da comunidade (quants 3/4/5/6/8-bit + bf16): https://huggingface.co/models?search=LiquidAI/LFM3-Audio-2B-MLX · coleção nativ-community LFM3.
    67	
    68	### Interfaces do pipeline (garantem D7 — plugabilidade)
    69	
    70	```
    71	AudioSource → (PCM 16 kHz, stream) → VAD → Segment{áudio, lang}
    72	Segment     → SttPort  → {texto, stream de tokens parciais}
    73	Texto       → TranslatorPort → {textoTraduzido}
    74	Traduzido   → TtsPort  → {stream de áudio}
    75	Legendas/UI → consome os streams (1º token = 1º traço de legenda)
    76	Cada Port = provider/modelo via config — troca de modelo nunca toca código.
    77	```
    78	
    79	A instância "escuta" (Proc. 1), o assistente (Proc. 2) e a instância "fala" (Proc. 3) rodam em **processos separados** com filas próprias (custo total ≈ 4–7 GB em 4-bit — folga larga nos 48 GB). O assistente usa **prompt-cache do prefixo da conversa**: a cada segmento novo do entrevistador ele só processa o sufixo (TTFT baixo) e re-streama a sugestão — B usa a v1 como WYSIWYT: edita ou aprova; aprovar envia ao Proc. 3.
    80	
    81	## 4. Riscos registrados (aceitos na decisão)
    82	
    83	| Risco | Mitigação |
    84	|---|---|
    85	| Legenda só aparece no fim da fala (Audio-2B não gera parcial em tempo real) | D7: a porta STT aceita plug de whisper.cpp/WhisperLiveKit depois (parciais: https://github.com/QuentinFuxa/WhisperLiveKit) |
    86	| Mic captura o alto-falante (eco/ruído) degrada STT | VAD calibrado + ganho; BlackHole continua sendo upgrade plugável sem mudar o pipeline |
    87	| Um modelo não escuta e fala ao mesmo tempo | 3 processos separados (D8): escuta nunca competindo com raciocínio/fala |
    88	| Assistente re-gera a cada segmento — TTFT do LFM3-1.7B pode virar gargalo | Verificar prefill/KV-cache na F0; debounce + prompt-cache do prefixo; fallback: modelo menor/menor frequency de re-geração |
    89	| S2ST EN→PT do Audio-2B sem benchmark público verificado | Teste A/B na Fase 0 antes de destravar idiomas extras; SimulEval (Average Lagging): https://github.com/facebookresearch/SimulEval |
    90	| Streaming de áudio de saída no runtime MLX precisa ser validado | Fase 0 é justamente o POC disso |
    91	
    92	## 5. Fases
    93	
    94	- **F0 — POC de viabilidade (1-2 dias):** LM Studio / `mlx-openai-server` + LFM3-Audio-2B 4-bit + LFM3-1.7B 4-bit, **3 processos simultâneos**; medir no M4 Pro: lag real S2ST EN→PT, tok/s decode+prefill (critical: TTFT do assistente com prompt-cache), time-to-first-audio, RAM e contenção de GPU entre os 3. **Gargalo crítico:** confirmar que no MLX a fala realmente streama.
    95	- **F1 — Esqueleto do pipeline** (AudioSource, VAD, Ports, orquestrador, 3 processos).
    96	- **F2 — UI de legendas + campo de resposta** (D3: seletor de idiomas).
    97	- **F3 — Modo entrevista (cenário 2)**: assistente LFM3-1.7B + painel de sugestão editável → aprovar envia ao proc. de fala (é o cenário mais complexo, por isso vira fase **plena**, não "extra").
    98	- **F4 — Bench SimulEval + plug whisper.cpp no STT** (re-decidir D6/D7 com dados).
    99	
   100	## 6. Fontes primárias
   101	
   102	- Modelos LiquidAI LFM3: https://huggingface.co/LiquidAI · https://docs.liquid.ai/lfm/models/lfm3-audio-2b · https://docs.liquid.ai/lfm/models/lfm3-omni-2b · https://huggingface.co/blog/LiquidAI/lfm3
   103	- Licença: https://www.liquid.ai/lfm-license
   104	- Runtimes Apple Silicon: https://lmstudio.ai/docs/developer/openai-compat · https://github.com/ml-explore/mlx-lm/issues/2016 · https://docs.liquid.ai/deployment/on-device/llama-cpp
   105	- Pipelines de referência: https://github.com/pipecat-ai/pipecat · https://github.com/huggingface/speech-to-speech · https://github.com/collabora/WhisperLive · https://github.com/QuentinFuxa/WhisperLiveKit · https://github.com/ufal/whisper_streaming
   106	- Métricas: https://github.com/facebookresearch/SimulEval

exec
/bin/zsh -lc 'cat /Users/otaviolemos/.codex/skills/using-superpowers/references/codex-tools.md' in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
## Subagent dispatch requires multi-agent support

Add to your Codex config (`~/.codex/config.toml`):

```toml
[features]
multi_agent = true
```

This enables the multi-agent tools that skills like
`dispatching-parallel-agents` and `subagent-driven-development` use.
Which tools you get depends on the multi-agent version your model
preset selects (current presets run V2; older ones run V1). Trust your
actual tool list over any table — including this one — when they
disagree.

- **Spawning:** give children a clean context with
  `spawn_agent {fork_turns: "none"}`; the default `"all"` copies your
  entire transcript into the child. On Codex 0.145+, role files under
  `~/.codex/agents/` attach to isolated forks via `agent_type`.
  Full-history forks accept `model` and `reasoning_effort` overrides
  (only `agent_type` is refused there) — isolated forks are the SDD
  default for context hygiene, not because overrides require them.
- **Fix rounds:** resume the implementer with `followup_task` — it
  delivers your message, triggers a turn, and transparently reloads a
  child the harness evicted. Never dispatch a fresh implementer on the
  theory that a spawned agent cannot be messaged again; on V2 it
  always can.
- **Lifecycle:** V2 has no `close_agent`. Finished children are
  evicted automatically when slots are needed; leaving them unclosed
  costs nothing. Only V1 sessions have `close_agent` — there, close
  reviewers when their review returns, and close each implementer
  after its task's review passes.
- **Model names:** never copy a model name from a skill, table, or old
  session into `spawn_agent` without checking it against your current
  spawn allowlist — V2 accepts only V2-capable presets and hard-errors
  on the rest.

## Waiting on children

`wait_agent` is an event subscription, not a poll: a long wait wakes
the moment a child produces mailbox activity, with the same latency as
a short one. Short-timeout polling buys nothing and costs a tool call —
and a context rebill — per poll. In measured sessions, roughly
two-thirds of all wait calls were short polls that timed out.

- While you still have local work, do not wait at all. A completed
  child's final answer is pushed into your mailbox and arrives with
  your next turn.
- When you are genuinely idle with children outstanding, wait in
  bounded stretches: `wait_agent` with `timeout_ms` 300000-600000
  (5-10 minutes). After each stretch — wake or timeout — post one
  status line, run `list_agents`, and chase any child that finished
  without reporting. Never stack polls shorter than five minutes; the
  event subscription wakes a bounded stretch just as fast as a short
  one.
- Completion mail cannot wake an idle controller (it is delivered
  without triggering a turn); covering that idle window is
  `wait_agent`'s only job. A stretch that times out with no activity
  is your cue to reconcile, not to shorten the next stretch.

## Model routing on spawns

Every `spawn_agent` you issue — including when you are yourself a
spawned child running a fan-out — sets `model` AND `reasoning_effort`
explicitly, per the Model Selection rules of the skill you are
executing. Setting `model` alone is a trap: the child's effort
silently resets to that model's default, not to yours.

Ask your human partner to add a machine-level backstop to
`~/.codex/config.toml` so any spawn that slips through still routes to
a deliberate tier instead of silently inheriting the session's most
expensive model:

```toml
[agents]
default_subagent_model = "<a mid-tier model from your spawn allowlist>"
default_subagent_reasoning_effort = "medium"
```

## Environment Detection

Skills that create worktrees or finish branches should detect their
environment with read-only git commands before proceeding:

```bash
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
BRANCH=$(git branch --show-current)
```

- `GIT_DIR != GIT_COMMON` → already in a linked worktree (skip creation)
- `BRANCH` empty → detached HEAD (cannot branch/push/PR from sandbox)

See `using-git-worktrees` Step 0 and `finishing-a-development-branch`
Step 1 for how each skill uses these signals.

## Codex App Finishing

When the sandbox blocks branch/push operations (detached HEAD in an
externally managed worktree), the agent commits all work and informs
the user to use the App's native controls:

- **"Create branch"** — names the branch, then commit/push/PR via App UI
- **"Hand off to local"** — transfers work to the user's local checkout

The agent can still run tests, stage files, and output suggested branch
names, commit messages, and PR descriptions for the user to copy.

web search: 
web search: https://docs.liquid.ai/lfm/models/lfm3-audio-2b
exec
/bin/zsh -lc "rg --files --hidden -g '"'!'"\\.git/**'" in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
docs/adr/ADR-001-arquitetura.md
lfm2-runtimes-research.md

web search: 
web search: https://huggingface.co/LiquidAI/LFM3-Audio-2B
exec
/bin/zsh -lc 'cat lfm2-runtimes-research.md' in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
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

web search: 
web search: '140'
codex
O LFM3-Audio-2B e os pesos MLX 4-bit existem, e a ficha atual documenta ASR incremental. Portanto, a afirmação de que o modelo não gera parciais precisa ser corrigida — embora o suporte no runtime escolhido ainda exija validação. O problema mais grave até aqui está no áudio: o desenho não separa a fala remota, a voz local e o próprio TTS.
web search: 
web search: 
web search: 
web search: site.developer.apple.com capturing system audio Core Audio taps macOS 14.2 process tap ScreenCaptureKit audio microphone ...
web search: 
web search: capturing system audio Core Audio taps ...
web search: 
web search: '140'
web search: 
web search: '140'
web search: 
web search: https://github.com/Blaizzy/mlx-vlm/blob/main/mlx_vlm/models/lfm3_audio/lfm3_audio.py
web search: 
web search: https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/ASR/LFM3Audio.md
web search: 
web search: https://huggingface.co/google/translategemma-4b-it
web search: 
web search: "LFM3-Audio" "140" ...
web search: 
web search: https://raw.githubusercontent.com/Blaizzy/mlx-vlm/main/mlx_vlm/models/lfm3_audio/README.md
web search: 
web search: 'realtime'
web search: 
web search: https://github.com/ggml-org/llama.cpp/blob/master/examples/server/README.md
codex
Encontrei um bloqueio concreto para D6: o README do MLX-VLM declara que a implementação de LFM3-Audio ainda não oferece streaming de entrada ou saída, incluindo LiveASR. Isso é diferente da capacidade do modelo. A documentação da Liquid aponta caminhos mais adequados para testar agora: áudio via `llama.cpp` com WebSocket e, como alternativa nativa, FluidAudio/Core ML.
web search: 
web search: https://raw.githubusercontent.com/ggml-org/whisper.cpp/master/examples/stream/README.md
web search: 
web search: TranslateGemma Portuguese pt 55 languages ...
web search: 
web search: https://ai.google.dev/gemma/docs/translategemma
exec
/bin/zsh -lc 'cat /Users/otaviolemos/.codex/skills/verification-before-completion/SKILL.md' in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
---
name: verification-before-completion
description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always
---

# Verification Before Completion

## Overview

**Core principle:** Evidence before claims, always.

**Violating the letter of this rule is violating the spirit of this rule.**

## The Iron Law

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

If you haven't run the verification command in this message, you cannot claim it passes.

## The Gate Function

```
BEFORE claiming any status or expressing satisfaction:

1. IDENTIFY: What command proves this claim?
2. RUN: Execute the FULL command (fresh, complete)
3. READ: Full output, check exit code, count failures
4. VERIFY: Does output confirm the claim?
   - If NO: State actual status with evidence
   - If YES: State claim WITH evidence
5. ONLY THEN: Make the claim

Skip any step = lying, not verifying
```

## Common Failures

| Claim | Requires | Not Sufficient |
|-------|----------|----------------|
| Tests pass | Test command output: 0 failures | Previous run, "should pass" |
| Linter clean | Linter output: 0 errors | Partial check, extrapolation |
| Build succeeds | Build command: exit 0 | Linter passing, logs look good |
| Bug fixed | Test original symptom: passes | Code changed, assumed fixed |
| Regression test works | Red-green cycle verified | Test passes once |
| Agent completed | VCS diff shows changes | Agent reports "success" |
| Requirements met | Line-by-line checklist | Tests passing |

## Red Flags - STOP

- Using "should", "probably", "seems to"
- Expressing satisfaction before verification ("Great!", "Perfect!", "Done!", etc.)
- About to commit/push/PR without verification
- Trusting agent success reports
- Relying on partial verification
- Thinking "just this once"
- Tired and wanting work over
- **ANY wording implying success without having run verification**

## Rationalization Prevention

| Excuse | Reality |
|--------|---------|
| "Should work now" | RUN the verification |
| "I'm confident" | Confidence ≠ evidence |
| "Just this once" | No exceptions |
| "Linter passed" | Linter ≠ compiler |
| "Agent said success" | Verify independently |
| "I'm tired" | Exhaustion ≠ excuse |
| "Partial check is enough" | Partial proves nothing |
| "Different words so rule doesn't apply" | Spirit over letter |

## Key Patterns

**Tests:**
```
✅ [Run test command] [See: 34/34 pass] "All tests pass"
❌ "Should pass now" / "Looks correct"
```

**Regression tests (TDD Red-Green):**
```
✅ Write → Run (pass) → Revert fix → Run (MUST FAIL) → Restore → Run (pass)
❌ "I've written a regression test" (without red-green verification)
```

**Build:**
```
✅ [Run build] [See: exit 0] "Build passes"
❌ "Linter passed" (linter doesn't check compilation)
```

**Requirements:**
```
✅ Re-read plan → Create checklist → Verify each → Report gaps or completion
❌ "Tests pass, phase complete"
```

**Agent delegation:**
```
✅ Agent reports success → Check VCS diff → Verify changes → Report actual state
❌ Trust agent report
```

## When To Apply

**ALWAYS before:**
- ANY variation of success/completion claims
- ANY expression of satisfaction
- ANY positive statement about work state
- Committing, PR creation, task completion
- Moving to next task
- Delegating to agents

**Rule applies to:**
- Exact phrases
- Paraphrases and synonyms
- Implications of success
- ANY communication suggesting completion/correctness

exec
/bin/zsh -lc "python3 -c 'from pathlib import Path; paths=[Path(\"/\"),Path(\"/Users\"),Path(\"/Users/otaviolemos\"),Path(\"/Users/otaviolemos/ml\"),Path(\"/Users/otaviolemos/ml/falador\"),Path(\"/Users/otaviolemos/ml/falador/docs\"),Path(\"/Users/otaviolemos/ml/falador/docs/adr\")]; [(print(str(d/\"AGENTS.md\")),print((d/\"AGENTS.md\").read_text())) for d in paths if (d/\"AGENTS.md\").is_file()]'" in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
web search: 
web search: https://arxiv.org/html/2601.09012v1
web search: 
web search: https://huggingface.co/google/translategemma-4b-it/raw/main/config.json
web search: 
web search: https://arxiv.org/pdf/2601.09012
web search: 
web search: 'response.cancel'
codex
A auditoria aponta três correções antes de tratar o ADR como “decidido”: roteamento digital do áudio, processamento sem esperar a fala inteira terminar e escolha de um runtime com streaming comprovado. Também confirmei que processos separados não reservam a GPU para a escuta. Os números de 140 ms e 280 tok/s seguem **NÃO VERIFICADOS**; os 119,7 tok/s vêm de uma PR aberta e não demonstram a latência do pipeline.
web search: 
web search: 'Portuguese'
exec
/bin/zsh -lc 'nl -ba docs/adr/ADR-001-arquitetura.md' in /Users/otaviolemos/ml/falador
 succeeded in 0ms:
     1	# ADR-001 — Arquitetura · Falador (tradução simultânea em conferências)
     2	
     3	> **Status:** Decidido (2026-11-18) · **Decisor:** Otávio Lemos · **Escopo:** v1, uso pessoal, Apple Silicon
     4	
     5	## 1. Problema
     6	
     7	Conversas em conferência (Teams, Zoom, Meet, WhatsApp) onde A fala um idioma e B fala outro.
     8	O Falador transcreve, traduz em tempo real (legendas) e responde por voz no idioma do outro participante.
     9	Cenário extra: entrevista/help — traduzir **e** dar sugestões técnicas ao usuário enquanto ele acompanha.
    10	
    11	## 2. Decisões tomadas (ADR)
    12	
    13	| # | Decisão |
    14	|---|---|
    15	| D1 | Áudio capturado/reproduzido pelos **dispositivos padrão do notebook** (mic + alto-falantes). Sem BlackHole, sem bot participante na v1 |
    16	| D2 | Voz TTS sai pelo som do notebook (uso pessoal; não há canal de intérprete na reunião) |
    17	| D3 | **Idiomas selecionáveis** na UI; v1 valida EN↔PT-BR |
    18	| D4 | Hardware alvo: **M4 Pro 48 GB** |
    19	| D5 | Licença: **LFM Open License v1.0** aceitável (uso pessoal; limite comercial = receita < US$ 10M — https://www.liquid.ai/lfm-license) |
    20	| D6 | **LFM3-Audio-2B (MLX) para escuta e fala na v1** — STT, tradução e TTS num modelo só, rodando em **2 instâncias** (escuta + fala) |
    21	| D8 | **Cenário 2 (entrevista) = 3 processos**: ESCUTA (Audio-2B) + **ASSISTENTE (LFM3-1.7B, texto)** + FALA (Audio-2B). O assistente é processo próprio — **a escuta é o caminho crítico de latência e nunca pode serrarse para raciocinar** |
    22	| D7 | Cada etapa do pipeline é **plugável por interface** (STT/TRAD/TTS trocáveis por config) — o whisper.cpp volta como opção de STT se o lag do modo D6 se mostrar pior na prática |
    23	
    24	## 3. Arquitetura
    25	
    26	```
    27	┌────────────────────────── FALADOR (app local, macOS, M4 Pro 48GB) ───────────────────────────┐
    28	│                                                                                               │
    29	│  CAPTAÇÃO (D1)                  NÚCLEO DE STREAMING                    SAÍDA                  │
    30	│  ┌──────────────┐  PCM 16kHz   ┌───────────────────────┐                                │
    31	│  │ mic padrão   │────────────► │ VAD (Silero v5, ONNX, │                                │
    32	│  │ (outros      │              │ CPU — não compete GPU)│                                │
    33	│  │  participantes│             └──────────┬────────────┘                                │
    34	│  │  via alto-    │                       ▼  segmento de fala (utterance)                  │
    35	│  │  falante)     │          ┌─ PROC. 1: ESCUTA (LFM3-Audio-2B) ────┐   ┌───────────────┐     │
    36	│  └──────────────┘          │ áudio → texto PT (stream, legenda)   │   │ UI: legendas  │     │
    37	│                            │         + áudio PT (LiquidCodec)     │──►│  por segmento │     │
    38	│                            └──────────────┬───────────────────────┘   └───────────────┘     │
    39	│                                           │ cada segmento confirmado                        │
    40	│                                           ▼                                                 │
    41	│                            ┌─ PROC. 2: ASSISTENTE (LFM3-1.7B) ────┐   ┌───────────────┐     │
    42	│                            │ cenário 2 (entrevista):              │   │ UI: painel de │     │
    43	│                            │ re-gera sugestão de resposta técnica │──►│  sugestão     │     │
    44	│                            │ em PT (streaming, prompt-cache do    │   │  (B edita/    │     │
    45	│                            │ prefixo da conversa p/ TTFT baixo)   │   │   aprova)     │     │
    46	│                            └──────────────┬───────────────────────┘   └───────┬───────┘     │
    47	│                                           │ texto PT escolhido/                │            │
    48	│                                           │ digitado por B                     │            │
    49	│                                           ▼                                    │            │
    50	│                            ┌─ PROC. 3: FALA (LFM3-Audio-2B) ───────┐          │            │
    51	│                            │ texto PT → fala EN (streaming,        │◄─────────┘            │
    52	│                            │ LiquidCodec; cenário 1 usa B=ON/BD)   │                       │
    53	│                            └───────────────────────────────────────┘                       │
    54	└───────────────────────────────────────────────────────────────────────────────────────────────┘
    55	```
    56	
    57	### Modelos (menu plugável — D6/D7)
    58	
    59	| Papel | Padrão v1 | Alternativas plugáveis |
    60	|---|---|---|
    61	| STT+S2ST (Proc. 1 escuta / Proc. 3 fala) | **LiquidAI/LFM3-Audio-2B-MLX-4bit** — PT nas 2 direções, 1º áudio ~140 ms, ~280 tok/s em M4 Max; docs: https://docs.liquid.ai/lfm/models/lfm3-audio-2b · https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-bf16 | whisper.cpp large-v3-turbo (Metal, parcial de legenda): https://github.com/ggml-org/whisper.cpp · Parakeet v3/FluidAudio: https://github.com/FluidInference/FluidAudio · Qwen3-ASR MLX: https://github.com/moona3k/mlx-qwen3-asr |
    62	| Assistente técnico (Proc. 2) | **LFM3-1.7B** (texto, 256K ctx, tool calling; ~119 tok/s decode em MLX): https://docs.liquid.ai/lfm/models/lfm3-1.7b · https://github.com/ml-explore/mlx-lm/issues/2016 | Qwen3-1.7B, cualquier servidor OpenAI-compatible local; o próprio Audio-2B em modo texto (menos indicado: ocuparia a voz do processo de escuta) |
    63	| TTS | LiquidCodec (dentro do Audio-2B, streaming nativo) | Kokoro-82M (3 vozes pt-BR, Apache-2.0): https://github.com/hexgrad/kokoro · Chatterbox Multilingual (MIT, clone de voz; repo arquivado): https://github.com/resemble-ai/chatterbox |
    64	| Runtime LLM | **LM Studio headless** (`lms server start`, API OpenAI /v1 + SSE) ou `mlx-openai-server` (pip) | llama.cpp `llama-server` (LFM3 precisa v0.8.0+): https://docs.liquid.ai/deployment/on-device/llama-cpp · Ollama `lfm3`: https://ollama.com/library/lfm3 |
    65	
    66	Ports MLX da comunidade (quants 3/4/5/6/8-bit + bf16): https://huggingface.co/models?search=LiquidAI/LFM3-Audio-2B-MLX · coleção nativ-community LFM3.
    67	
    68	### Interfaces do pipeline (garantem D7 — plugabilidade)
    69	
    70	```
    71	AudioSource → (PCM 16 kHz, stream) → VAD → Segment{áudio, lang}
    72	Segment     → SttPort  → {texto, stream de tokens parciais}
    73	Texto       → TranslatorPort → {textoTraduzido}
    74	Traduzido   → TtsPort  → {stream de áudio}
    75	Legendas/UI → consome os streams (1º token = 1º traço de legenda)
    76	Cada Port = provider/modelo via config — troca de modelo nunca toca código.
    77	```
    78	
    79	A instância "escuta" (Proc. 1), o assistente (Proc. 2) e a instância "fala" (Proc. 3) rodam em **processos separados** com filas próprias (custo total ≈ 4–7 GB em 4-bit — folga larga nos 48 GB). O assistente usa **prompt-cache do prefixo da conversa**: a cada segmento novo do entrevistador ele só processa o sufixo (TTFT baixo) e re-streama a sugestão — B usa a v1 como WYSIWYT: edita ou aprova; aprovar envia ao Proc. 3.
    80	
    81	## 4. Riscos registrados (aceitos na decisão)
    82	
    83	| Risco | Mitigação |
    84	|---|---|
    85	| Legenda só aparece no fim da fala (Audio-2B não gera parcial em tempo real) | D7: a porta STT aceita plug de whisper.cpp/WhisperLiveKit depois (parciais: https://github.com/QuentinFuxa/WhisperLiveKit) |
    86	| Mic captura o alto-falante (eco/ruído) degrada STT | VAD calibrado + ganho; BlackHole continua sendo upgrade plugável sem mudar o pipeline |
    87	| Um modelo não escuta e fala ao mesmo tempo | 3 processos separados (D8): escuta nunca competindo com raciocínio/fala |
    88	| Assistente re-gera a cada segmento — TTFT do LFM3-1.7B pode virar gargalo | Verificar prefill/KV-cache na F0; debounce + prompt-cache do prefixo; fallback: modelo menor/menor frequency de re-geração |
    89	| S2ST EN→PT do Audio-2B sem benchmark público verificado | Teste A/B na Fase 0 antes de destravar idiomas extras; SimulEval (Average Lagging): https://github.com/facebookresearch/SimulEval |
    90	| Streaming de áudio de saída no runtime MLX precisa ser validado | Fase 0 é justamente o POC disso |
    91	
    92	## 5. Fases
    93	
    94	- **F0 — POC de viabilidade (1-2 dias):** LM Studio / `mlx-openai-server` + LFM3-Audio-2B 4-bit + LFM3-1.7B 4-bit, **3 processos simultâneos**; medir no M4 Pro: lag real S2ST EN→PT, tok/s decode+prefill (critical: TTFT do assistente com prompt-cache), time-to-first-audio, RAM e contenção de GPU entre os 3. **Gargalo crítico:** confirmar que no MLX a fala realmente streama.
    95	- **F1 — Esqueleto do pipeline** (AudioSource, VAD, Ports, orquestrador, 3 processos).
    96	- **F2 — UI de legendas + campo de resposta** (D3: seletor de idiomas).
    97	- **F3 — Modo entrevista (cenário 2)**: assistente LFM3-1.7B + painel de sugestão editável → aprovar envia ao proc. de fala (é o cenário mais complexo, por isso vira fase **plena**, não "extra").
    98	- **F4 — Bench SimulEval + plug whisper.cpp no STT** (re-decidir D6/D7 com dados).
    99	
   100	## 6. Fontes primárias
   101	
   102	- Modelos LiquidAI LFM3: https://huggingface.co/LiquidAI · https://docs.liquid.ai/lfm/models/lfm3-audio-2b · https://docs.liquid.ai/lfm/models/lfm3-omni-2b · https://huggingface.co/blog/LiquidAI/lfm3
   103	- Licença: https://www.liquid.ai/lfm-license
   104	- Runtimes Apple Silicon: https://lmstudio.ai/docs/developer/openai-compat · https://github.com/ml-explore/mlx-lm/issues/2016 · https://docs.liquid.ai/deployment/on-device/llama-cpp
   105	- Pipelines de referência: https://github.com/pipecat-ai/pipecat · https://github.com/huggingface/speech-to-speech · https://github.com/collabora/WhisperLive · https://github.com/QuentinFuxa/WhisperLiveKit · https://github.com/ufal/whisper_streaming
   106	- Métricas: https://github.com/facebookresearch/SimulEval

web search: 
web search: https://raw.githubusercontent.com/FluidInference/FluidAudio/main/Documentation/ASR/NemotronMultilingual.md
codex
# Auditoria adversarial — ADR-001 do Falador

**Veredicto geral: o ADR ainda não sustenta a arquitetura como “Decidido”.** Há três bloqueios: roteamento acústico incompatível com isolamento das conversas, streaming ausente na implementação MLX documentada e segmentação que pode obrigar a esperar a fala inteira terminar.

Li integralmente o [ADR-001](/Users/otaviolemos/ml/falador/docs/adr/ADR-001-arquitetura.md). As referências abaixo usam suas linhas atuais. Fontes externas consultadas em **18/11/2026**; capacidades documentadas não equivalem a desempenho medido no equipamento.

- **VERIFICADO:** consta em fonte primária.
- **Inferência:** consequência do desenho, explicitada como tal.
- **NÃO VERIFICADO:** não encontrei evidência suficiente ou depende de execução local.
- **P0:** impede satisfazer o requisito central. **P1:** compromete qualidade, previsibilidade ou operação.

## 1. Veredicto por decisão

| Decisão | Veredicto | Motivo principal |
|---|---|---|
| **D1 — mic/alto-falantes padrão** | **DERRUBA** | A recaptura acústica mistura remoto, usuário e TTS; falta separar as duas direções. |
| **D2 — TTS pelo notebook** | **DERRUBA** | Reprodução local não constitui um canal confiável de envio à reunião. |
| **D3 — idiomas selecionáveis; EN↔PT-BR** | **MANTÉM** | Escopo adequado; selecionar idioma não comprova suporte equivalente em todas as modalidades. |
| **D4 — M4 Pro 48 GB** | **MANTÉM** | Alvo adequado para experimentar; RAM disponível não comprova latência sob concorrência. |
| **D5 — licença LFM aceitável** | **AJUSTA** | Aceitável sob as condições aplicáveis; “uso pessoal” não resume a definição de uso comercial. |
| **D6 — dois Audio-2B via MLX como padrão** | **DERRUBA** | A implementação documentada não entrega o streaming presumido; S2ST simultâneo EN↔PT-BR permanece sem validação. |
| **D7 — portas plugáveis** | **AJUSTA** | Boa separação, mas os contratos atuais não representam revisões, confirmação, cancelamento nem processamento fundido. |
| **D8 — três processos** | **AJUSTA** | Separa execução e falhas; não reserva GPU nem impede competição com o assistente. |

“Derruba” em D6 significa retirar a escolha como **padrão aprovado da v1**. O modelo continua sendo candidato experimental.

## 2. Auditoria de D1–D8

### D1 — Captura pelos dispositivos padrão

**Linhas 15, 29–35, 71 e 86 — P0.**

**Problema concreto:** o microfone recebe uma mistura de:

1. voz do usuário;
2. fala remota reproduzida pelo notebook;
3. tradução sintetizada pelo próprio Falador;
4. reverberação e ruído.

O desenho não informa qual componente distingue essas origens. Se o Falador traduz a fala remota para PT e reproduz essa tradução, pode capturá-la novamente e tratá-la como uma nova entrada. Isso também contamina o histórico do assistente. **Inferência direta do circuito desenhado.**

**A mitigação da L86 é inadequada.** VAD detecta presença de voz; uma voz sintetizada também é voz. Ajustar ganho não identifica sua origem nem remove seletivamente o TTS.

Há alternativa nativa sem BlackHole: **Core Audio process taps**, disponíveis a partir do macOS 14.2, capturam digitalmente a saída de processos. A Apple documenta permissões e configuração do dispositivo agregado. Portanto, “sem BlackHole” não exige captar o alto-falante pelo microfone. [Documentação Apple](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)

**Correção mínima:**

- fala remota: captura digital do processo da conferência;
- fala local: microfone separado;
- TTS: saída explicitamente excluída da entrada correspondente;
- idiomas e direção associados à origem do áudio.

**NÃO VERIFICADO:** seleção e captura corretas dos processos de Teams, Zoom, navegador/Meet e WhatsApp, incluindo seus processos auxiliares.

**Veredicto: DERRUBA a recaptura acústica como arquitetura principal.**

---

### D2 — TTS pelo som do notebook

**Linhas 16, 37 e 50–53 — P0.**

A decisão confunde duas saídas distintas:

| Saída | Destinatário | Roteamento necessário |
|---|---|---|
| Tradução EN→PT | Usuário local | Fone ou reprodução local controlada |
| Resposta PT→EN | Participantes remotos | Entrada de áudio efetivamente enviada pela conferência |

**Tocar inglês no alto-falante não injeta esse áudio na reunião.** Para chegar ao remoto pelo desenho atual, ele precisa ser recapturado pelo microfone.

Isso cria um conflito: o cancelamento de eco busca remover justamente áudio reproduzido que retorna ao microfone. O processamento de voz da Apple inclui cancelamento de eco; o comportamento exato da cadeia de cada conferenciador precisa ser testado. [Apple — processamento de voz](https://developer.apple.com/videos/play/wwdc2019/510/)

**Caso de falha:** o usuário fala PT com o microfone aberto; o remoto recebe o original e depois, eventualmente, o inglês recapturado. Se o microfone estiver fechado, esse caminho acústico também deixa de enviar o TTS.

**Correção mínima:** definir uma saída privada para escuta e um caminho digital de envio do inglês à reunião. Isso exige rever a proibição de dispositivo virtual ou escolher uma integração específica.

Se todas essas integrações continuarem excluídas, o escopo viável é **legendas e assistência local**; o envio confiável de voz traduzida permanece **NÃO VERIFICADO**.

**Veredicto: DERRUBA como mecanismo de comunicação com o remoto.**

---

### D3 — Idiomas selecionáveis; validação EN↔PT-BR

**Linhas 17, 36, 51, 61 e 71 — P1.**

**Mantém a seleção explícita.** Ela reduz ambiguidade e torna o teste reproduzível.

Dois ajustes são necessários:

- configurar **idioma de origem e destino por direção**, em vez de apenas um idioma global;
- separar suporte a **ASR, tradução textual, LiveASR e síntese**.

O LFM3-Audio lista português, mas isso não comprova sotaque brasileiro nem qualidade equivalente entre tarefas. A ficha documenta **LiveASR apenas em inglês**, com blocos de aproximadamente **0,96 s**. Logo, não há base para prometer o mesmo caminho incremental em PT. [Ficha oficial do modelo](https://huggingface.co/LiquidAI/LFM3-Audio-2B)

**NÃO VERIFICADO:** PT-BR sob sotaques, termos técnicos, nomes próprios e alternância EN/PT na mesma frase.

**Veredicto: MANTÉM, com validação separada das duas direções e modalidades.**

---

### D4 — M4 Pro com 48 GB

**Linhas 18, 61, 79 e 94 — P1.**

**O hardware permanece. A extrapolação dos benchmarks deve sair.**

A Apple especifica **273 GB/s** para M4 Pro. Há variantes M4 Max com **410 ou 546 GB/s**, além de mais núcleos de GPU. Não se transfere um resultado de M4 Max para M4 Pro por equivalência de geração. [Especificações Apple](https://support.apple.com/en-il/121553)

A estimativa de **4–7 GB totais** da L79 não é uma medição:

- o Audio-2B MLX 4-bit declara **1,58 GB de pesos + 0,15 GB de codec** por cópia;
- duas cópias representam cerca de **3,46 GB de artefatos**, antes do assistente, estados, ativações, buffers e runtime;
- “4-bit” é precisão mista: vários componentes permanecem em BF16;
- a própria ficha recomenda **8-bit** como compromisso de qualidade. [Checkpoint oficial 4-bit](https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-4bit)

Isso indica margem para experimentar, mas não prova pico de memória nem ausência de pressão durante conferência, compartilhamento de tela e inferência concorrente.

**NÃO VERIFICADO:** memória residente total, swap, consumo sustentado, limitação térmica e latência p95/p99.

**Veredicto: MANTÉM o alvo; remove a “folga larga” como justificativa de desempenho.**

---

### D5 — LFM Open License

**Linha 19 — P1 de precisão documental.**

O nome da licença está correto. O resumo está incompleto:

- o texto define uso comercial incluindo vantagem comercial **direta ou indireta**;
- a definição de entidade jurídica abrange relações de controle;
- distribuição envolve preservação de licença e avisos;
- o limiar não deve ser interpretado apenas como receita gerada pelo Falador.

Há diferenças de redação entre resumo, definição de *Threshold* e cláusula operacional. Preserve o texto aplicável ao checkpoint, sem substituir suas condições por uma desigualdade isolada. [Licença oficial](https://www.liquid.ai/lfm-license)

**Correção mínima:** registrar a aceitação para o cenário concreto e manter licença/revisão junto aos artefatos escolhidos.

**NÃO VERIFICADO:** enquadramento de uso em entrevistas ou atividades profissionais específicas. “Executado no notebook pessoal” não resolve sozinho essa classificação.

**Veredicto: AJUSTA; não bloqueia automaticamente o experimento pessoal.**

---

### D6 — LFM3-Audio-2B via MLX para escuta e fala

**Linhas 20, 35–38, 50–53, 61, 63–66, 85, 89–90 e 94 — P0.**

#### 6.1. O modelo existe; o streaming presumido não está entregue nesse caminho

**VERIFICADO:** existem o modelo e o checkpoint oficial MLX 4-bit.

**Bloqueio:** o README da implementação LFM3-Audio no MLX-VLM declara que **streaming de entrada e saída não está implementado**, incluindo LiveASR. Existe emissão incremental de *slots*, mas isso não equivale a entregar PCM reproduzível continuamente à aplicação. [README da implementação](https://raw.githubusercontent.com/Blaizzy/mlx-vlm/main/mlx_vlm/models/lfm3_audio/README.md)

A L90 trata como dúvida experimental algo que a implementação consultada já registra como limitação.

**Correção mínima:** escolher um caminho com streaming documentado ou assumir explicitamente o trabalho de implementá-lo. Não aprovar a v1 dependendo dessa lacuna.

#### 6.2. A L85 atribui a limitação à camada errada

“Audio-2B não gera parcial em tempo real” é uma afirmação ampla demais.

Há LiveASR documentado no modelo, com restrição a inglês; há ausência dessa funcionalidade na implementação MLX consultada. **Modelo, implementação e servidor são três verificações diferentes.** [Ficha oficial](https://huggingface.co/LiquidAI/LFM3-Audio-2B)

#### 6.3. Tradução documentada não comprova interpretação simultânea

A ficha fornece instruções de tradução fala→texto e texto→texto, incluindo idiomas de origem e destino. Isso sustenta experimentar EN↔PT, mas não demonstra:

- S2ST simultâneo e fiel nas duas direções;
- estabilidade de tradução antes de terminar a entrada;
- latência EN↔PT-BR no M4 Pro.

Esses pontos permanecem **NÃO VERIFICADOS**. [Instruções oficiais de tradução](https://huggingface.co/LiquidAI/LFM3-Audio-2B#translation)

Na L51, **texto PT→fala EN inclui tradução e síntese**. Não é apenas TTS. Nas L37/63, LiquidCodec é o componente de codificação/decodificação de áudio; não substitui sozinho o modelo que produz os códigos de fala.

#### 6.4. Os números da L61 não sustentam a decisão

| Afirmação | Resultado da auditoria |
|---|---|
| Primeiro áudio ≈140 ms | **NÃO VERIFICADO** nas fontes primárias consultadas. |
| ≈280 tok/s em M4 Max | **NÃO VERIFICADO** com configuração e protocolo reproduzíveis. |
| Esses valores representam tradução simultânea | **NÃO VERIFICADO**; velocidade de geração não mede espera por contexto ou fim de fala. |
| Mesmo desempenho com duas instâncias e assistente | **NÃO VERIFICADO**. |

Também falta definir a unidade de “token”: texto, quadro de fala ou códigos internos. A implementação distingue tokens textuais e quadros de fala. Não é válido converter tok/s diretamente em latência percebida.

#### 6.5. Os servidores propostos não são intercambiáveis

**Linha 64:**

- **LM Studio:** a página citada documenta endpoints de texto/imagem e outros recursos; ela não comprova entrada incremental e saída de áudio LFM3. Essa combinação permanece **NÃO VERIFICADA**. [Endpoints oficiais](https://lmstudio.ai/docs/developer/openai-compat)
- **`mlx-openai-server`:** o projeto documenta chat multimodal e transcrição Whisper; não demonstra o caminho de streaming de fala LFM3 exigido pelo ADR. SSE de texto não é evidência de áudio incremental. [README do servidor](https://github.com/cubist38/mlx-openai-server)
- **`llama.cpp`:** a documentação Liquid confirma LFM3 a partir de **v0.8.0/b11960**, além de áudio e WebSocket `/v1/realtime`. É um candidato concreto para a prova de conceito. [Documentação Liquid](https://docs.liquid.ai/deployment/on-device/llama-cpp)

Mesmo no `llama.cpp`, a documentação distingue transcrição ao ouvir e conversação cuja resposta começa após a entrada. **WebSocket não significa tradução simultânea automaticamente.** [Documentação do servidor](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#realtime-conversation)

#### 6.6. Dois modelos de áudio não demonstram ser a opção mais rápida

**Inferência:** sintetizar português dentro do mesmo fluxo que produz legendas pode gastar computação desnecessária quando o usuário está apenas lendo. Da mesma forma, carregar outro modelo de áudio completo para falar pode custar mais que um sintetizador especializado.

**Correção mínima:** comparar uma cascata especializada com o Audio-2B, usando a mesma captura e os mesmos áudios. Manter síntese de escuta somente quando essa saída estiver habilitada.

**Veredicto: DERRUBA como padrão aprovado; mantém como experimento comparativo.**

---

### D7 — Interfaces plugáveis

**Linhas 22, 68–76, 85 e 98 — P1, com impacto direto na latência.**

**Mantém a separação de responsabilidades. Derruba a garantia “troca de modelo nunca toca código”.**

Configuração escolhe implementações já integradas. Um novo modelo pode exigir outro protocolo, formato, estado ou política de revisão.

Os contratos apresentados têm quatro falhas:

| Linhas | Falha | Consequência |
|---|---|---|
| 71–72 | Entrada é um segmento fechado | Pode obrigar a aguardar o fim da fala antes de iniciar ASR. |
| 72 | “Tokens parciais” sem revisão/confirmação | Consumidores não sabem o que ainda pode mudar. |
| 73 | Tradução aparece como resultado único | Não há contrato incremental para a etapa que alimenta a legenda traduzida. |
| 74–75 | Primeiro token é tratado como saída utilizável | Um token pode ser incompleto; áudio pronunciado não pode ser corrigido retroativamente. |

Há também incompatibilidade com D6: um modelo fala→fala fundido não atravessa necessariamente três portas independentes. Forçá-lo a fazê-lo pode introduzir chamadas repetidas; contorná-las torna o contrato ilustrativo.

**Correção mínima:** contratos com identificação da entrada, timestamps, origem/direção, revisão e confirmação; cancelamento e erros explícitos. Escolher primeiro entre cascata e caminho fundido, preservando uma fronteira externa comum quando necessário.

O ASR alternativo precisa participar de **F0**. Descobrir só em F4 que o padrão tem atraso inadequado significa construir a UI e a orquestração sobre uma hipótese já contestada.

**Veredicto: AJUSTA.**

---

### D8 — Três processos e assistente separado

**Linhas 21, 39–48, 62, 79, 87–88 e 94–97 — P1.**

#### 8.1. Processos separados não garantem prioridade à escuta

A L87 afirma que a escuta nunca compete com raciocínio/fala. Isso é falso como garantia arquitetural.

**Inferência:** os processos continuam compartilhando GPU, largura de banda de memória e orçamento térmico. Um prefill do assistente pode atrasar inferência de áudio mesmo sem compartilhar fila ou interpretador.

**Correção mínima:** assistente cancelável e subordinado à escuta, limite de trabalho pendente e medição de interferência. Para sugestões, processar o estado mais recente evita acumular respostas obsoletas.

#### 8.2. Prompt-cache não significa “só processar o sufixo” automaticamente

A L79 pressupõe cache disponível, compatível com a arquitetura e preservado entre pedidos.

O caminho oficial Liquid para LFM3 em MLX é **MLX-VLM**. Já o `mlx-openai-server` documenta que seu batching multimodal não usa cache de prefixo. Portanto, a combinação sugerida não sustenta a promessa de cache do ADR. [Liquid — MLX](https://docs.liquid.ai/deployment/on-device/mlx), [servidor — limitações de cache](https://github.com/cubist38/mlx-openai-server)

Mesmo com cache correto, contexto novo e geração da nova sugestão continuam custando computação. Se o histórico contém respostas anteriores que agora são descartadas, o ponto reutilizável também precisa ser definido.

#### 8.3. O benchmark de 119 tok/s é real, mas foi interpretado além da evidência

A referência é uma **PR aberta**, não prova de suporte lançado no MLX-LM. O exemplo registra **119,722 tok/s de geração**, mas somente **18 tokens de prompt**, a **39,080 tok/s**. Não demonstra TTFT de uma conversa longa com cache e três cargas concorrentes. [PR #2016](https://github.com/ml-explore/mlx-lm/pull/2016)

#### 8.4. O assistente técnico precisa de avaliação de qualidade

O contexto de 256K e tool calling estão documentados. Porém, a própria Liquid não recomenda o LFM3-1.7B para raciocínio complexo em várias etapas ou programação agêntica, devido ao tamanho. Isso não o inviabiliza para sugestões curtas; inviabiliza presumir competência técnica a partir de tok/s. [Documentação do modelo](https://docs.liquid.ai/lfm/models/lfm3-1.7b)

**NÃO VERIFICADO:** utilidade e correção das respostas técnicas em português.

#### 8.5. Regeneração pode sobrescrever edição ou aprovação

**Caso concreto:** chega um novo segmento enquanto B edita a sugestão anterior. Sem regra explícita, a atualização pode substituir a edição ou aprovar uma versão diferente da exibida.

**Correção mínima:** separar sugestão em geração do texto editável; aprovação envia uma cópia identificada e imutável. Interromper geração também deve cancelar áudio ainda não reproduzido.

**Veredicto: AJUSTA; mantém o isolamento lógico, retira a promessa de isolamento de recursos.**

## 3. Auditoria das demais afirmações relevantes

| Linhas | Achado adversarial | Tratamento |
|---|---|---|
| **3** | “Decidido” antecede a prova das condições essenciais listadas em F0. | Registrar escolha condicionada aos resultados de viabilidade. |
| **7–9** | Não define simultaneidade, sobreposição de falantes nem comportamento ao interromper TTS. | Explicitar o comportamento mínimo de cada cenário. |
| **30–32** | PCM 16 kHz é adequado à entrada do Audio-2B; dispositivo físico não necessariamente entrega esse formato. | Definir conversão de amostragem/canais na captura. CPU para VAD é razoável, mas não elimina disputa por memória/CPU. |
| **34–38** | “Segmento de fala” precede toda a inferência, apesar do rótulo “núcleo de streaming”. | Alimentar incrementalmente; usar fim de fala para finalizar. |
| **37** | Áudio PT não tem destino explícito no diagrama. | Mostrar reprodução privada e sua exclusão da captura. |
| **39–48** | Assistente só vê o que parece ser tradução PT. | Preservar também transcrição original; erros de tradução podem alterar a pergunta técnica. |
| **50–53** | Falta caminho explícito da fala local no cenário 1 e saída efetiva para a conferência. | Desenhar as duas direções completas. `B=ON/BD` é indefinido: **NÃO VERIFICADO**. |
| **63 — Kokoro** | Três vozes PT-BR e Apache-2.0 estão confirmados. | Candidato válido; qualidade em fragmentos muito curtos precisa de teste. [Vozes oficiais](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) |
| **63 — Chatterbox** | A afirmação “repo arquivado” não se confirma na página consultada, que apresenta Multilingual V3 e opções PT-BR. | Corrigir o estado; latência no alvo continua **NÃO VERIFICADA**. [Repositório oficial](https://github.com/resemble-ai/chatterbox) |
| **66** | Busca genérica e nome de coleção não identificam artefatos reproduzíveis. | Fixar repositório, revisão e precisão. A matriz inteira 3/4/5/6/8-bit é **NÃO VERIFICADA**. |
| **85–90** | Os riscos são reais, mas algumas mitigações não resolvem suas causas. | Trocar VAD por separação de sinais; processos por controle de carga; “testar streaming” por runtime que o implemente. |
| **94–98** | Benchmark comparativo vem depois de infraestrutura e UI. | Antecipar o comparativo para F0. |
| **102–106** | Links de projetos não provam integração funcional no Mac. | Registrar versões e resultados reproduzíveis. SimulEval está arquivado desde setembro de 2025. [Repositório](https://github.com/facebookresearch/SimulEval) |

## 4. Onde a latência realmente será perdida

### 4.1. Esperar o fim da fala domina qualquer otimização de decode

**Inferência do desenho:** se uma fala contínua dura 12 segundos e o VAD só entrega o segmento completo no final, a primeira legenda desse caminho não aparece antes desses 12 segundos. Um primeiro áudio gerado em 140 ms posteriormente não recupera essa espera.

O VAD pode marcar início/fim e evitar trabalho no silêncio. Não deve obrigatoriamente funcionar como barreira antes de toda inferência.

### 4.2. Há quatro “streamings” diferentes

O ADR precisa distingui-los:

1. receber áudio incrementalmente;
2. transcrever antes do fim da entrada;
3. traduzir antes da transcrição completa;
4. reproduzir PCM antes da síntese completa.

Um servidor com SSE comprova apenas o transporte de eventos que ele implementa.

### 4.3. Legenda provisória e fala precisam de políticas diferentes

Legenda pode ser revisada. Fala já emitida não pode.

**Caso concreto:** um prefixo parece afirmar algo e a continuação introduz negação ou condição. Sintetizar imediatamente pode comunicar o sentido errado; esperar toda a frase aumenta atraso.

A arquitetura precisa assumir esse compromisso e definir o que autoriza a confirmação de um trecho traduzido. Nenhum número de tok/s resolve a necessidade de contexto linguístico.

### 4.4. A fila de reprodução também pode crescer

**Exemplo aritmético, não benchmark:** se a tradução de cada 5 segundos de origem ocupa 6 segundos de reprodução, acumula-se aproximadamente 1 segundo por bloco, mesmo com síntese instantânea.

Medir apenas velocidade de inferência omite duração do áudio traduzido, pausas, ritmo e atraso já acumulado.

### 4.5. “Latência extrema” ainda não é um critério verificável

Faltam metas separadas para:

- primeira legenda provisória;
- tradução confirmada;
- primeiro áudio audível;
- atraso durante fala contínua;
- interrupção e esvaziamento da reprodução;
- p95/p99 com assistente e conferência ativos.

Sem essas metas, F0 pode produzir números sem permitir aprovar ou rejeitar a arquitetura.

## 5. Alternativas mais viáveis para comparar

**Recomendação de arquitetura:** começar por uma **cascata incremental observável**, com captura digital separada, ASR, tradução textual e TTS. Ela facilita substituir o componente que falha e comparar qualidade por etapa. Isso é uma recomendação de engenharia, **não uma alegação de que cascatas sempre têm menor latência**.

| Papel | Candidato concreto | Evidência e limite |
|---|---|---|
| **ASR EN/PT com menor disputa direta pela GPU** | **Parakeet TDT v3 via FluidAudio/Core ML** | Português confirmado. FluidAudio distingue processamento em janela sobreposta de streaming nativo; throughput alto não elimina espera da janela. [NVIDIA](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [FluidAudio](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Models.md) |
| **ASR nativamente incremental EN/PT** | **Voxtral Mini 4B Realtime via MLX** | Há avaliação publicada incluindo PT e atrasos configuráveis; integração MLX é comunitária e listada como não testada pela Mistral. Existe `voxmlx`. Desempenho no M4 Pro: **NÃO VERIFICADO**. [Mistral](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602), [voxmlx](https://github.com/awni/voxmlx) |
| **ASR compacto EN/PT** | **Qwen3-ASR-0.6B via MLX** | Idiomas confirmados. O port oferece modo incremental com janela acumulada e exemplo de blocos de 2 s; exige ajuste e medição. [Modelo](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), [port MLX](https://github.com/moona3k/mlx-qwen3-asr) |
| **Baseline de ASR** | **whisper.cpp + large-v3-turbo** | Bom candidato de comparação. O exemplo oficial usa transcrição repetida em janelas; não comprova streaming nativo ou parciais estáveis. [Exemplo oficial](https://github.com/ggml-org/whisper.cpp/tree/master/examples/stream) |
| **Tradução especializada** | **TranslateGemma 4B** | Relatório inclui PT-BR/PT-PT; existe conversão MLX 4-bit. Qualidade e latência em fragmentos de reunião: **NÃO VERIFICADAS**. [Relatório Google](https://arxiv.org/pdf/2601.09012), [checkpoint MLX](https://huggingface.co/mlx-community/translategemma-4b-it-4bit) |
| **TTS compacto** | **Kokoro-82M** | EN e PT-BR disponíveis. Na implementação FluidAudio, geração é paralela por trecho, sem streaming interno; pode-se alimentar trechos confirmados, medindo o compromisso entre atraso e prosódia. [FluidAudio](https://github.com/FluidInference/FluidAudio) |
| **Preservar Audio-2B** | **llama.cpp/GGUF ou FluidAudio/Core ML** | `llama.cpp` documenta áudio via WebSocket. FluidAudio documenta LiveASR inglês e callback de áudio TTS; parte relevante ainda utiliza GPU. Nenhum dos dois comprova S2ST simultâneo EN↔PT-BR no alvo. [llama.cpp](https://docs.liquid.ai/deployment/on-device/llama-cpp), [FluidAudio LFM3](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/ASR/LFM3Audio.md) |
| **Assistente comparativo** | **LFM3-1.7B versus Qwen3-4B** | Qwen3 oferece modo sem raciocínio explícito e runtimes locais. Superioridade nas perguntas técnicas do usuário: **NÃO VERIFICADA**. [Ficha Qwen](https://huggingface.co/Qwen/Qwen3-4B) |

Eu compararia primeiro **Parakeet/FluidAudio e um ASR nativamente incremental**, mantendo Whisper como baseline. Evitaria testar todos os modelos simultaneamente: corrigir captura e política de confirmação produz evidência mais útil que ampliar o catálogo.

Uma topologia mínima seria:

```text
Áudio remoto digital ─→ ASR EN ─→ tradução PT ─→ legenda
                                             └→ TTS privado, quando habilitado

Microfone local ──────→ ASR PT ─→ tradução EN ─→ TTS ─→ entrada da reunião

Transcrição original + contexto confirmado
                    └→ assistente cancelável ─→ edição/aprovação
```

A entrada de áudio da reunião continua sendo uma decisão obrigatória de integração; o diagrama não a resolve sozinho.

## 6. O que F0 precisa demonstrar antes de aprovar o ADR

1. **Roteamento completo:** remoto capturado digitalmente, usuário separado, TTS sem recaptura e inglês efetivamente recebido no outro lado.
2. **Incrementalidade real:** fala contínua sem pausas produz legenda antes de terminar; áudio sai em blocos reproduzíveis.
3. **Duas direções:** EN→PT e PT→EN avaliados separadamente, incluindo qualidade da voz brasileira.
4. **Carga concorrente:** comparar escuta isolada, escuta+fala e escuta+fala+assistente, com o conferenciador ativo.
5. **Sessão sustentada:** medir crescimento das filas, memória, atraso acumulado e comportamento térmico.
6. **Correção de conteúdo:** testar negações, números, nomes, siglas técnicas, autocorreções e alternância de idioma.
7. **Cancelamento e aprovação:** interrupção para geração e reprodução; nova sugestão não altera texto já editado ou aprovado.
8. **Execução local:** com artefatos previamente disponíveis, inferência funciona sem acesso externo. Servidores restritos à interface local; verificar tráfego e eventuais downloads em execução.
9. **Reprodução do resultado:** registrar modelo/revisão, quantização, runtime/versão, macOS, configuração, áudio de teste e timestamps de cada etapa.

**Recomendação final:** corrigir D1/D2, substituir D6 por uma escolha condicionada ao comparativo e trazer o benchmark de F4 para F0. D3/D4 podem permanecer; D5/D7/D8 precisam das ressalvas acima.

Não executei modelos, benchmarks nem chamadas de conferência; nenhum arquivo foi editado.  
**Risco pendente:** latência extrema e S2ST simultâneo EN↔PT-BR no M4 Pro continuam **NÃO VERIFICADOS**.
hook: Stop
hook: Stop Completed
tokens used
194.891
# Auditoria adversarial — ADR-001 do Falador

**Veredicto geral: o ADR ainda não sustenta a arquitetura como “Decidido”.** Há três bloqueios: roteamento acústico incompatível com isolamento das conversas, streaming ausente na implementação MLX documentada e segmentação que pode obrigar a esperar a fala inteira terminar.

Li integralmente o [ADR-001](/Users/otaviolemos/ml/falador/docs/adr/ADR-001-arquitetura.md). As referências abaixo usam suas linhas atuais. Fontes externas consultadas em **18/11/2026**; capacidades documentadas não equivalem a desempenho medido no equipamento.

- **VERIFICADO:** consta em fonte primária.
- **Inferência:** consequência do desenho, explicitada como tal.
- **NÃO VERIFICADO:** não encontrei evidência suficiente ou depende de execução local.
- **P0:** impede satisfazer o requisito central. **P1:** compromete qualidade, previsibilidade ou operação.

## 1. Veredicto por decisão

| Decisão | Veredicto | Motivo principal |
|---|---|---|
| **D1 — mic/alto-falantes padrão** | **DERRUBA** | A recaptura acústica mistura remoto, usuário e TTS; falta separar as duas direções. |
| **D2 — TTS pelo notebook** | **DERRUBA** | Reprodução local não constitui um canal confiável de envio à reunião. |
| **D3 — idiomas selecionáveis; EN↔PT-BR** | **MANTÉM** | Escopo adequado; selecionar idioma não comprova suporte equivalente em todas as modalidades. |
| **D4 — M4 Pro 48 GB** | **MANTÉM** | Alvo adequado para experimentar; RAM disponível não comprova latência sob concorrência. |
| **D5 — licença LFM aceitável** | **AJUSTA** | Aceitável sob as condições aplicáveis; “uso pessoal” não resume a definição de uso comercial. |
| **D6 — dois Audio-2B via MLX como padrão** | **DERRUBA** | A implementação documentada não entrega o streaming presumido; S2ST simultâneo EN↔PT-BR permanece sem validação. |
| **D7 — portas plugáveis** | **AJUSTA** | Boa separação, mas os contratos atuais não representam revisões, confirmação, cancelamento nem processamento fundido. |
| **D8 — três processos** | **AJUSTA** | Separa execução e falhas; não reserva GPU nem impede competição com o assistente. |

“Derruba” em D6 significa retirar a escolha como **padrão aprovado da v1**. O modelo continua sendo candidato experimental.

## 2. Auditoria de D1–D8

### D1 — Captura pelos dispositivos padrão

**Linhas 15, 29–35, 71 e 86 — P0.**

**Problema concreto:** o microfone recebe uma mistura de:

1. voz do usuário;
2. fala remota reproduzida pelo notebook;
3. tradução sintetizada pelo próprio Falador;
4. reverberação e ruído.

O desenho não informa qual componente distingue essas origens. Se o Falador traduz a fala remota para PT e reproduz essa tradução, pode capturá-la novamente e tratá-la como uma nova entrada. Isso também contamina o histórico do assistente. **Inferência direta do circuito desenhado.**

**A mitigação da L86 é inadequada.** VAD detecta presença de voz; uma voz sintetizada também é voz. Ajustar ganho não identifica sua origem nem remove seletivamente o TTS.

Há alternativa nativa sem BlackHole: **Core Audio process taps**, disponíveis a partir do macOS 14.2, capturam digitalmente a saída de processos. A Apple documenta permissões e configuração do dispositivo agregado. Portanto, “sem BlackHole” não exige captar o alto-falante pelo microfone. [Documentação Apple](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)

**Correção mínima:**

- fala remota: captura digital do processo da conferência;
- fala local: microfone separado;
- TTS: saída explicitamente excluída da entrada correspondente;
- idiomas e direção associados à origem do áudio.

**NÃO VERIFICADO:** seleção e captura corretas dos processos de Teams, Zoom, navegador/Meet e WhatsApp, incluindo seus processos auxiliares.

**Veredicto: DERRUBA a recaptura acústica como arquitetura principal.**

---

### D2 — TTS pelo som do notebook

**Linhas 16, 37 e 50–53 — P0.**

A decisão confunde duas saídas distintas:

| Saída | Destinatário | Roteamento necessário |
|---|---|---|
| Tradução EN→PT | Usuário local | Fone ou reprodução local controlada |
| Resposta PT→EN | Participantes remotos | Entrada de áudio efetivamente enviada pela conferência |

**Tocar inglês no alto-falante não injeta esse áudio na reunião.** Para chegar ao remoto pelo desenho atual, ele precisa ser recapturado pelo microfone.

Isso cria um conflito: o cancelamento de eco busca remover justamente áudio reproduzido que retorna ao microfone. O processamento de voz da Apple inclui cancelamento de eco; o comportamento exato da cadeia de cada conferenciador precisa ser testado. [Apple — processamento de voz](https://developer.apple.com/videos/play/wwdc2019/510/)

**Caso de falha:** o usuário fala PT com o microfone aberto; o remoto recebe o original e depois, eventualmente, o inglês recapturado. Se o microfone estiver fechado, esse caminho acústico também deixa de enviar o TTS.

**Correção mínima:** definir uma saída privada para escuta e um caminho digital de envio do inglês à reunião. Isso exige rever a proibição de dispositivo virtual ou escolher uma integração específica.

Se todas essas integrações continuarem excluídas, o escopo viável é **legendas e assistência local**; o envio confiável de voz traduzida permanece **NÃO VERIFICADO**.

**Veredicto: DERRUBA como mecanismo de comunicação com o remoto.**

---

### D3 — Idiomas selecionáveis; validação EN↔PT-BR

**Linhas 17, 36, 51, 61 e 71 — P1.**

**Mantém a seleção explícita.** Ela reduz ambiguidade e torna o teste reproduzível.

Dois ajustes são necessários:

- configurar **idioma de origem e destino por direção**, em vez de apenas um idioma global;
- separar suporte a **ASR, tradução textual, LiveASR e síntese**.

O LFM3-Audio lista português, mas isso não comprova sotaque brasileiro nem qualidade equivalente entre tarefas. A ficha documenta **LiveASR apenas em inglês**, com blocos de aproximadamente **0,96 s**. Logo, não há base para prometer o mesmo caminho incremental em PT. [Ficha oficial do modelo](https://huggingface.co/LiquidAI/LFM3-Audio-2B)

**NÃO VERIFICADO:** PT-BR sob sotaques, termos técnicos, nomes próprios e alternância EN/PT na mesma frase.

**Veredicto: MANTÉM, com validação separada das duas direções e modalidades.**

---

### D4 — M4 Pro com 48 GB

**Linhas 18, 61, 79 e 94 — P1.**

**O hardware permanece. A extrapolação dos benchmarks deve sair.**

A Apple especifica **273 GB/s** para M4 Pro. Há variantes M4 Max com **410 ou 546 GB/s**, além de mais núcleos de GPU. Não se transfere um resultado de M4 Max para M4 Pro por equivalência de geração. [Especificações Apple](https://support.apple.com/en-il/121553)

A estimativa de **4–7 GB totais** da L79 não é uma medição:

- o Audio-2B MLX 4-bit declara **1,58 GB de pesos + 0,15 GB de codec** por cópia;
- duas cópias representam cerca de **3,46 GB de artefatos**, antes do assistente, estados, ativações, buffers e runtime;
- “4-bit” é precisão mista: vários componentes permanecem em BF16;
- a própria ficha recomenda **8-bit** como compromisso de qualidade. [Checkpoint oficial 4-bit](https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-4bit)

Isso indica margem para experimentar, mas não prova pico de memória nem ausência de pressão durante conferência, compartilhamento de tela e inferência concorrente.

**NÃO VERIFICADO:** memória residente total, swap, consumo sustentado, limitação térmica e latência p95/p99.

**Veredicto: MANTÉM o alvo; remove a “folga larga” como justificativa de desempenho.**

---

### D5 — LFM Open License

**Linha 19 — P1 de precisão documental.**

O nome da licença está correto. O resumo está incompleto:

- o texto define uso comercial incluindo vantagem comercial **direta ou indireta**;
- a definição de entidade jurídica abrange relações de controle;
- distribuição envolve preservação de licença e avisos;
- o limiar não deve ser interpretado apenas como receita gerada pelo Falador.

Há diferenças de redação entre resumo, definição de *Threshold* e cláusula operacional. Preserve o texto aplicável ao checkpoint, sem substituir suas condições por uma desigualdade isolada. [Licença oficial](https://www.liquid.ai/lfm-license)

**Correção mínima:** registrar a aceitação para o cenário concreto e manter licença/revisão junto aos artefatos escolhidos.

**NÃO VERIFICADO:** enquadramento de uso em entrevistas ou atividades profissionais específicas. “Executado no notebook pessoal” não resolve sozinho essa classificação.

**Veredicto: AJUSTA; não bloqueia automaticamente o experimento pessoal.**

---

### D6 — LFM3-Audio-2B via MLX para escuta e fala

**Linhas 20, 35–38, 50–53, 61, 63–66, 85, 89–90 e 94 — P0.**

#### 6.1. O modelo existe; o streaming presumido não está entregue nesse caminho

**VERIFICADO:** existem o modelo e o checkpoint oficial MLX 4-bit.

**Bloqueio:** o README da implementação LFM3-Audio no MLX-VLM declara que **streaming de entrada e saída não está implementado**, incluindo LiveASR. Existe emissão incremental de *slots*, mas isso não equivale a entregar PCM reproduzível continuamente à aplicação. [README da implementação](https://raw.githubusercontent.com/Blaizzy/mlx-vlm/main/mlx_vlm/models/lfm3_audio/README.md)

A L90 trata como dúvida experimental algo que a implementação consultada já registra como limitação.

**Correção mínima:** escolher um caminho com streaming documentado ou assumir explicitamente o trabalho de implementá-lo. Não aprovar a v1 dependendo dessa lacuna.

#### 6.2. A L85 atribui a limitação à camada errada

“Audio-2B não gera parcial em tempo real” é uma afirmação ampla demais.

Há LiveASR documentado no modelo, com restrição a inglês; há ausência dessa funcionalidade na implementação MLX consultada. **Modelo, implementação e servidor são três verificações diferentes.** [Ficha oficial](https://huggingface.co/LiquidAI/LFM3-Audio-2B)

#### 6.3. Tradução documentada não comprova interpretação simultânea

A ficha fornece instruções de tradução fala→texto e texto→texto, incluindo idiomas de origem e destino. Isso sustenta experimentar EN↔PT, mas não demonstra:

- S2ST simultâneo e fiel nas duas direções;
- estabilidade de tradução antes de terminar a entrada;
- latência EN↔PT-BR no M4 Pro.

Esses pontos permanecem **NÃO VERIFICADOS**. [Instruções oficiais de tradução](https://huggingface.co/LiquidAI/LFM3-Audio-2B#translation)

Na L51, **texto PT→fala EN inclui tradução e síntese**. Não é apenas TTS. Nas L37/63, LiquidCodec é o componente de codificação/decodificação de áudio; não substitui sozinho o modelo que produz os códigos de fala.

#### 6.4. Os números da L61 não sustentam a decisão

| Afirmação | Resultado da auditoria |
|---|---|
| Primeiro áudio ≈140 ms | **NÃO VERIFICADO** nas fontes primárias consultadas. |
| ≈280 tok/s em M4 Max | **NÃO VERIFICADO** com configuração e protocolo reproduzíveis. |
| Esses valores representam tradução simultânea | **NÃO VERIFICADO**; velocidade de geração não mede espera por contexto ou fim de fala. |
| Mesmo desempenho com duas instâncias e assistente | **NÃO VERIFICADO**. |

Também falta definir a unidade de “token”: texto, quadro de fala ou códigos internos. A implementação distingue tokens textuais e quadros de fala. Não é válido converter tok/s diretamente em latência percebida.

#### 6.5. Os servidores propostos não são intercambiáveis

**Linha 64:**

- **LM Studio:** a página citada documenta endpoints de texto/imagem e outros recursos; ela não comprova entrada incremental e saída de áudio LFM3. Essa combinação permanece **NÃO VERIFICADA**. [Endpoints oficiais](https://lmstudio.ai/docs/developer/openai-compat)
- **`mlx-openai-server`:** o projeto documenta chat multimodal e transcrição Whisper; não demonstra o caminho de streaming de fala LFM3 exigido pelo ADR. SSE de texto não é evidência de áudio incremental. [README do servidor](https://github.com/cubist38/mlx-openai-server)
- **`llama.cpp`:** a documentação Liquid confirma LFM3 a partir de **v0.8.0/b11960**, além de áudio e WebSocket `/v1/realtime`. É um candidato concreto para a prova de conceito. [Documentação Liquid](https://docs.liquid.ai/deployment/on-device/llama-cpp)

Mesmo no `llama.cpp`, a documentação distingue transcrição ao ouvir e conversação cuja resposta começa após a entrada. **WebSocket não significa tradução simultânea automaticamente.** [Documentação do servidor](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#realtime-conversation)

#### 6.6. Dois modelos de áudio não demonstram ser a opção mais rápida

**Inferência:** sintetizar português dentro do mesmo fluxo que produz legendas pode gastar computação desnecessária quando o usuário está apenas lendo. Da mesma forma, carregar outro modelo de áudio completo para falar pode custar mais que um sintetizador especializado.

**Correção mínima:** comparar uma cascata especializada com o Audio-2B, usando a mesma captura e os mesmos áudios. Manter síntese de escuta somente quando essa saída estiver habilitada.

**Veredicto: DERRUBA como padrão aprovado; mantém como experimento comparativo.**

---

### D7 — Interfaces plugáveis

**Linhas 22, 68–76, 85 e 98 — P1, com impacto direto na latência.**

**Mantém a separação de responsabilidades. Derruba a garantia “troca de modelo nunca toca código”.**

Configuração escolhe implementações já integradas. Um novo modelo pode exigir outro protocolo, formato, estado ou política de revisão.

Os contratos apresentados têm quatro falhas:

| Linhas | Falha | Consequência |
|---|---|---|
| 71–72 | Entrada é um segmento fechado | Pode obrigar a aguardar o fim da fala antes de iniciar ASR. |
| 72 | “Tokens parciais” sem revisão/confirmação | Consumidores não sabem o que ainda pode mudar. |
| 73 | Tradução aparece como resultado único | Não há contrato incremental para a etapa que alimenta a legenda traduzida. |
| 74–75 | Primeiro token é tratado como saída utilizável | Um token pode ser incompleto; áudio pronunciado não pode ser corrigido retroativamente. |

Há também incompatibilidade com D6: um modelo fala→fala fundido não atravessa necessariamente três portas independentes. Forçá-lo a fazê-lo pode introduzir chamadas repetidas; contorná-las torna o contrato ilustrativo.

**Correção mínima:** contratos com identificação da entrada, timestamps, origem/direção, revisão e confirmação; cancelamento e erros explícitos. Escolher primeiro entre cascata e caminho fundido, preservando uma fronteira externa comum quando necessário.

O ASR alternativo precisa participar de **F0**. Descobrir só em F4 que o padrão tem atraso inadequado significa construir a UI e a orquestração sobre uma hipótese já contestada.

**Veredicto: AJUSTA.**

---

### D8 — Três processos e assistente separado

**Linhas 21, 39–48, 62, 79, 87–88 e 94–97 — P1.**

#### 8.1. Processos separados não garantem prioridade à escuta

A L87 afirma que a escuta nunca compete com raciocínio/fala. Isso é falso como garantia arquitetural.

**Inferência:** os processos continuam compartilhando GPU, largura de banda de memória e orçamento térmico. Um prefill do assistente pode atrasar inferência de áudio mesmo sem compartilhar fila ou interpretador.

**Correção mínima:** assistente cancelável e subordinado à escuta, limite de trabalho pendente e medição de interferência. Para sugestões, processar o estado mais recente evita acumular respostas obsoletas.

#### 8.2. Prompt-cache não significa “só processar o sufixo” automaticamente

A L79 pressupõe cache disponível, compatível com a arquitetura e preservado entre pedidos.

O caminho oficial Liquid para LFM3 em MLX é **MLX-VLM**. Já o `mlx-openai-server` documenta que seu batching multimodal não usa cache de prefixo. Portanto, a combinação sugerida não sustenta a promessa de cache do ADR. [Liquid — MLX](https://docs.liquid.ai/deployment/on-device/mlx), [servidor — limitações de cache](https://github.com/cubist38/mlx-openai-server)

Mesmo com cache correto, contexto novo e geração da nova sugestão continuam custando computação. Se o histórico contém respostas anteriores que agora são descartadas, o ponto reutilizável também precisa ser definido.

#### 8.3. O benchmark de 119 tok/s é real, mas foi interpretado além da evidência

A referência é uma **PR aberta**, não prova de suporte lançado no MLX-LM. O exemplo registra **119,722 tok/s de geração**, mas somente **18 tokens de prompt**, a **39,080 tok/s**. Não demonstra TTFT de uma conversa longa com cache e três cargas concorrentes. [PR #2016](https://github.com/ml-explore/mlx-lm/pull/2016)

#### 8.4. O assistente técnico precisa de avaliação de qualidade

O contexto de 256K e tool calling estão documentados. Porém, a própria Liquid não recomenda o LFM3-1.7B para raciocínio complexo em várias etapas ou programação agêntica, devido ao tamanho. Isso não o inviabiliza para sugestões curtas; inviabiliza presumir competência técnica a partir de tok/s. [Documentação do modelo](https://docs.liquid.ai/lfm/models/lfm3-1.7b)

**NÃO VERIFICADO:** utilidade e correção das respostas técnicas em português.

#### 8.5. Regeneração pode sobrescrever edição ou aprovação

**Caso concreto:** chega um novo segmento enquanto B edita a sugestão anterior. Sem regra explícita, a atualização pode substituir a edição ou aprovar uma versão diferente da exibida.

**Correção mínima:** separar sugestão em geração do texto editável; aprovação envia uma cópia identificada e imutável. Interromper geração também deve cancelar áudio ainda não reproduzido.

**Veredicto: AJUSTA; mantém o isolamento lógico, retira a promessa de isolamento de recursos.**

## 3. Auditoria das demais afirmações relevantes

| Linhas | Achado adversarial | Tratamento |
|---|---|---|
| **3** | “Decidido” antecede a prova das condições essenciais listadas em F0. | Registrar escolha condicionada aos resultados de viabilidade. |
| **7–9** | Não define simultaneidade, sobreposição de falantes nem comportamento ao interromper TTS. | Explicitar o comportamento mínimo de cada cenário. |
| **30–32** | PCM 16 kHz é adequado à entrada do Audio-2B; dispositivo físico não necessariamente entrega esse formato. | Definir conversão de amostragem/canais na captura. CPU para VAD é razoável, mas não elimina disputa por memória/CPU. |
| **34–38** | “Segmento de fala” precede toda a inferência, apesar do rótulo “núcleo de streaming”. | Alimentar incrementalmente; usar fim de fala para finalizar. |
| **37** | Áudio PT não tem destino explícito no diagrama. | Mostrar reprodução privada e sua exclusão da captura. |
| **39–48** | Assistente só vê o que parece ser tradução PT. | Preservar também transcrição original; erros de tradução podem alterar a pergunta técnica. |
| **50–53** | Falta caminho explícito da fala local no cenário 1 e saída efetiva para a conferência. | Desenhar as duas direções completas. `B=ON/BD` é indefinido: **NÃO VERIFICADO**. |
| **63 — Kokoro** | Três vozes PT-BR e Apache-2.0 estão confirmados. | Candidato válido; qualidade em fragmentos muito curtos precisa de teste. [Vozes oficiais](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md) |
| **63 — Chatterbox** | A afirmação “repo arquivado” não se confirma na página consultada, que apresenta Multilingual V3 e opções PT-BR. | Corrigir o estado; latência no alvo continua **NÃO VERIFICADA**. [Repositório oficial](https://github.com/resemble-ai/chatterbox) |
| **66** | Busca genérica e nome de coleção não identificam artefatos reproduzíveis. | Fixar repositório, revisão e precisão. A matriz inteira 3/4/5/6/8-bit é **NÃO VERIFICADA**. |
| **85–90** | Os riscos são reais, mas algumas mitigações não resolvem suas causas. | Trocar VAD por separação de sinais; processos por controle de carga; “testar streaming” por runtime que o implemente. |
| **94–98** | Benchmark comparativo vem depois de infraestrutura e UI. | Antecipar o comparativo para F0. |
| **102–106** | Links de projetos não provam integração funcional no Mac. | Registrar versões e resultados reproduzíveis. SimulEval está arquivado desde setembro de 2025. [Repositório](https://github.com/facebookresearch/SimulEval) |

## 4. Onde a latência realmente será perdida

### 4.1. Esperar o fim da fala domina qualquer otimização de decode

**Inferência do desenho:** se uma fala contínua dura 12 segundos e o VAD só entrega o segmento completo no final, a primeira legenda desse caminho não aparece antes desses 12 segundos. Um primeiro áudio gerado em 140 ms posteriormente não recupera essa espera.

O VAD pode marcar início/fim e evitar trabalho no silêncio. Não deve obrigatoriamente funcionar como barreira antes de toda inferência.

### 4.2. Há quatro “streamings” diferentes

O ADR precisa distingui-los:

1. receber áudio incrementalmente;
2. transcrever antes do fim da entrada;
3. traduzir antes da transcrição completa;
4. reproduzir PCM antes da síntese completa.

Um servidor com SSE comprova apenas o transporte de eventos que ele implementa.

### 4.3. Legenda provisória e fala precisam de políticas diferentes

Legenda pode ser revisada. Fala já emitida não pode.

**Caso concreto:** um prefixo parece afirmar algo e a continuação introduz negação ou condição. Sintetizar imediatamente pode comunicar o sentido errado; esperar toda a frase aumenta atraso.

A arquitetura precisa assumir esse compromisso e definir o que autoriza a confirmação de um trecho traduzido. Nenhum número de tok/s resolve a necessidade de contexto linguístico.

### 4.4. A fila de reprodução também pode crescer

**Exemplo aritmético, não benchmark:** se a tradução de cada 5 segundos de origem ocupa 6 segundos de reprodução, acumula-se aproximadamente 1 segundo por bloco, mesmo com síntese instantânea.

Medir apenas velocidade de inferência omite duração do áudio traduzido, pausas, ritmo e atraso já acumulado.

### 4.5. “Latência extrema” ainda não é um critério verificável

Faltam metas separadas para:

- primeira legenda provisória;
- tradução confirmada;
- primeiro áudio audível;
- atraso durante fala contínua;
- interrupção e esvaziamento da reprodução;
- p95/p99 com assistente e conferência ativos.

Sem essas metas, F0 pode produzir números sem permitir aprovar ou rejeitar a arquitetura.

## 5. Alternativas mais viáveis para comparar

**Recomendação de arquitetura:** começar por uma **cascata incremental observável**, com captura digital separada, ASR, tradução textual e TTS. Ela facilita substituir o componente que falha e comparar qualidade por etapa. Isso é uma recomendação de engenharia, **não uma alegação de que cascatas sempre têm menor latência**.

| Papel | Candidato concreto | Evidência e limite |
|---|---|---|
| **ASR EN/PT com menor disputa direta pela GPU** | **Parakeet TDT v3 via FluidAudio/Core ML** | Português confirmado. FluidAudio distingue processamento em janela sobreposta de streaming nativo; throughput alto não elimina espera da janela. [NVIDIA](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [FluidAudio](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/Models.md) |
| **ASR nativamente incremental EN/PT** | **Voxtral Mini 4B Realtime via MLX** | Há avaliação publicada incluindo PT e atrasos configuráveis; integração MLX é comunitária e listada como não testada pela Mistral. Existe `voxmlx`. Desempenho no M4 Pro: **NÃO VERIFICADO**. [Mistral](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602), [voxmlx](https://github.com/awni/voxmlx) |
| **ASR compacto EN/PT** | **Qwen3-ASR-0.6B via MLX** | Idiomas confirmados. O port oferece modo incremental com janela acumulada e exemplo de blocos de 2 s; exige ajuste e medição. [Modelo](https://huggingface.co/Qwen/Qwen3-ASR-0.6B), [port MLX](https://github.com/moona3k/mlx-qwen3-asr) |
| **Baseline de ASR** | **whisper.cpp + large-v3-turbo** | Bom candidato de comparação. O exemplo oficial usa transcrição repetida em janelas; não comprova streaming nativo ou parciais estáveis. [Exemplo oficial](https://github.com/ggml-org/whisper.cpp/tree/master/examples/stream) |
| **Tradução especializada** | **TranslateGemma 4B** | Relatório inclui PT-BR/PT-PT; existe conversão MLX 4-bit. Qualidade e latência em fragmentos de reunião: **NÃO VERIFICADAS**. [Relatório Google](https://arxiv.org/pdf/2601.09012), [checkpoint MLX](https://huggingface.co/mlx-community/translategemma-4b-it-4bit) |
| **TTS compacto** | **Kokoro-82M** | EN e PT-BR disponíveis. Na implementação FluidAudio, geração é paralela por trecho, sem streaming interno; pode-se alimentar trechos confirmados, medindo o compromisso entre atraso e prosódia. [FluidAudio](https://github.com/FluidInference/FluidAudio) |
| **Preservar Audio-2B** | **llama.cpp/GGUF ou FluidAudio/Core ML** | `llama.cpp` documenta áudio via WebSocket. FluidAudio documenta LiveASR inglês e callback de áudio TTS; parte relevante ainda utiliza GPU. Nenhum dos dois comprova S2ST simultâneo EN↔PT-BR no alvo. [llama.cpp](https://docs.liquid.ai/deployment/on-device/llama-cpp), [FluidAudio LFM3](https://github.com/FluidInference/FluidAudio/blob/main/Documentation/ASR/LFM3Audio.md) |
| **Assistente comparativo** | **LFM3-1.7B versus Qwen3-4B** | Qwen3 oferece modo sem raciocínio explícito e runtimes locais. Superioridade nas perguntas técnicas do usuário: **NÃO VERIFICADA**. [Ficha Qwen](https://huggingface.co/Qwen/Qwen3-4B) |

Eu compararia primeiro **Parakeet/FluidAudio e um ASR nativamente incremental**, mantendo Whisper como baseline. Evitaria testar todos os modelos simultaneamente: corrigir captura e política de confirmação produz evidência mais útil que ampliar o catálogo.

Uma topologia mínima seria:

```text
Áudio remoto digital ─→ ASR EN ─→ tradução PT ─→ legenda
                                             └→ TTS privado, quando habilitado

Microfone local ──────→ ASR PT ─→ tradução EN ─→ TTS ─→ entrada da reunião

Transcrição original + contexto confirmado
                    └→ assistente cancelável ─→ edição/aprovação
```

A entrada de áudio da reunião continua sendo uma decisão obrigatória de integração; o diagrama não a resolve sozinho.

## 6. O que F0 precisa demonstrar antes de aprovar o ADR

1. **Roteamento completo:** remoto capturado digitalmente, usuário separado, TTS sem recaptura e inglês efetivamente recebido no outro lado.
2. **Incrementalidade real:** fala contínua sem pausas produz legenda antes de terminar; áudio sai em blocos reproduzíveis.
3. **Duas direções:** EN→PT e PT→EN avaliados separadamente, incluindo qualidade da voz brasileira.
4. **Carga concorrente:** comparar escuta isolada, escuta+fala e escuta+fala+assistente, com o conferenciador ativo.
5. **Sessão sustentada:** medir crescimento das filas, memória, atraso acumulado e comportamento térmico.
6. **Correção de conteúdo:** testar negações, números, nomes, siglas técnicas, autocorreções e alternância de idioma.
7. **Cancelamento e aprovação:** interrupção para geração e reprodução; nova sugestão não altera texto já editado ou aprovado.
8. **Execução local:** com artefatos previamente disponíveis, inferência funciona sem acesso externo. Servidores restritos à interface local; verificar tráfego e eventuais downloads em execução.
9. **Reprodução do resultado:** registrar modelo/revisão, quantização, runtime/versão, macOS, configuração, áudio de teste e timestamps de cada etapa.

**Recomendação final:** corrigir D1/D2, substituir D6 por uma escolha condicionada ao comparativo e trazer o benchmark de F4 para F0. D3/D4 podem permanecer; D5/D7/D8 precisam das ressalvas acima.

Não executei modelos, benchmarks nem chamadas de conferência; nenhum arquivo foi editado.  
**Risco pendente:** latência extrema e S2ST simultâneo EN↔PT-BR no M4 Pro continuam **NÃO VERIFICADOS**.
