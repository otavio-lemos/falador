# Relatório de Revisão Adversarial — ADR-001 (Projeto Falador)

> **Documento auditado:** [`ADR-001-arquitetura.md`](file:///Users/otaviolemos/ml/falador/docs/adr/ADR-001-arquitetura.md)  
> **Perfil do projeto:** Tradução simultânea bidirecional EN↔PT em conferências, 100% on-device (Apple Silicon M4 Pro 48 GB), foco em latência extrema.  
> **Postura da revisão:** Adversarial rigorosa (busca ativa de pontos de falha física, acústica, de concorrência e de protocolo).

---

## 1. Diagnóstico Executivo de Arquitetura

O ADR-001 possui méritos conceituais (modularização por portas em D7, isolamento de processos em D8 e foco no ecossistema Apple Silicon), mas contém **três premissas fatais** que inviabilizam a operação em tempo real se implementadas como redigidas:

1. **Colapso Acústico (D1 + D2):** Captar o áudio do outro participante pelo microfone do ar e reproduzir a fala sintetizada nos alto-falantes do próprio notebook gera retroalimentação acústica (loop de eco), cortes agressivos pelo cancelamento de ruído das plataformas de conferência (Zoom/Meet/Teams) e destruição do SNR no VAD.
2. **Incompatibilidade de Runtime e Protocolo (D6):** O ADR propõe servir o `LFM3-Audio-2B` via `LM Studio headless` ou `mlx-openai-server` sobre a API `/v1/chat/completions`. Esses servidores expõem payloads textuais e não possuem suporte ao streaming bidirecional de áudio com vocodificação/desvocodificação `LiquidCodec` nativa.
3. **Falsa Simultaneidade (D6 + VAD):** Ao condicionar o envio de áudio ao fechamento de uma *utterance* completa via Silero VAD (admitido na Seção 4, L85), o sistema não opera como **tradução simultânea**, mas sim como **tradução consecutiva segmentada**. O atraso acumulado (*ear-voice span*) supera 3 a 8 segundos por turno de fala.

---

## 2. Auditoria Detalhada Linha a Linha: Decisões D1 a D8

---

### [D1] Captação e reprodução pelos dispositivos padrão do notebook (Mic + Alto-falantes), sem BlackHole ou bot (L15, L29-35)

#### (1) Erros e Imprecisões Técnicas
* **Feedback Loop Acústico & Alucinação Recursiva:** O microfone embutido do MacBook captará a voz emitida pelos próprios alto-falantes. Quando o Falador reproduzir o áudio traduzido ou quando o usuário falar, o microfone captará esse sinal com atraso de sala (reverberação), realimentando o VAD e gerando transcrições/traduções fantasmas em cascata.
* **Degradação Severa de SNR (Signal-to-Noise Ratio):** Captar a voz do interlocutor que sai do alto-falante introduz resposta de frequência degradada do cone do falante, reflexões no ambiente e ruído ambiente local. Isso eleva substancialmente o WER (*Word Error Rate*) do modelo ASR/S2ST em comparação com PCM digital limpo.
* **Supressão por Softwares de Conferência:** Clientes como Zoom, Teams e Meet possuem AEC (*Acoustic Echo Cancellation*) e filtros neurais proprietários (ex: Krisp). Ao detectar áudio saindo do alto-falante e entrando no microfone, o software ativamente corta ou distorce o sinal ("ducking"), picotando as palavras iniciais.

#### (2) Riscos de Latência
* Para evitar disparos acidentais com eco de sala e ruído ambiente, o Silero VAD precisará de limiares de energia mais altos e parâmetros de *hangover* (silêncio mínimo para fechar sentença) elevados (400–700 ms). Esse atraso é latência morta injetada obrigatoriamente antes de qualquer processamento.

#### (3) Alternativas Mais Viáveis
* **Audio Loopback Digital Direto:** Uso mandatório de dispositivo virtual como **BlackHole 2ch** (open source, latência zero em nível de kernel CoreAudio) ou **CoreAudio Process Tap** (`CATapDescription`, nativo no macOS 14.2+ / Sonoma e Sequoia, que permite capturar o buffer PCM digital direto do processo do Zoom/Meet sem drivers virtuais adicionais).
* **Uso de Fones de Ouvido (Headset/AirPods):** O usuário deve escutar pelo fone. O microfone capta apenas a voz local; o loopback virtual capta o áudio do interlocutor.

#### (4) Veredicto
> **DERRUBA.** A premissa de captar conferência pelo ar com microfone e alto-falante abertos é inviável em produção e compromete todo o pipeline a montante.

---

### [D2] Voz TTS sai pelo som do notebook (L16, L50-53)

#### (1) Erros e Imprecisões Técnicas
* **Incompatibilidade Funcional do Caso de Uso:** Se o objetivo é responder na conferência ("tradução simultânea onde A fala inglês e B responde em inglês"), emitir o TTS no alto-falante físico do notebook significa que o interlocutor remoto só escutará se o microfone da chamada captar o som da sala.
* Conforme apontado em D1, os algoritmos de cancelamento de ruído do Zoom/Meet/Teams consideram sons que saem do alto-falante como eco ou ruído de fundo, suprimindo ou mutando o áudio antes de transmiti-lo à chamada. O interlocutor remoto receberá áudio picotado e inteligibilidade quase nula.

#### (2) Riscos de Latência
* Bloqueio mútuo e *barge-in* quebrado: Enquanto o alto-falante toca a tradução, o usuário não pode intervir verbalmente e o interlocutor não pode interromper sem causar colapso no VAD e no AEC.

#### (3) Alternativas Mais Viáveis
* **Injeção de Microfone Virtual (Virtual Mic Injection):** Criar um dispositivo agregado no CoreAudio onde o TTS envia o PCM diretamente para uma entrada de microfone virtual (BlackHole) selecionada como entrada no Zoom/Meet. O interlocutor recebe PCM digital cristalino a 48 kHz/16 kHz sem ruído de ambiente.
* Monitoramento local: Enviar uma cópia atenuada da síntese para os fones de ouvido do usuário B para confirmação auditiva (sidetone).

#### (4) Veredicto
> **DERRUBA.** A saída precisa ser roteada digitalmente para o canal de entrada da conferência, e não jogada acusticamente na carcaça do laptop.

---

### [D3] Idiomas selecionáveis na UI; v1 valida EN↔PT-BR (L17)

#### (1) Erros e Imprecisões Técnicas
* Não há erro conceitual na decisão. Contudo, EN↔PT possui assimetria sintática crítica (ordem de adjetivos, inversões sujeito-verbo e orações relativas) que exige políticas de espera (*wait-k policy*) distintas para cada direção de tradução simultânea.
* Qualidade de prosódia e acentuação em PT-BR no LFM3-Audio-2B: `NÃO VERIFICADO` em produção para dialetos regionais brasileiros e terminologia técnica especializada de TI/conferência.

#### (2) Riscos de Latência
* A assimetria linguística impõe um *lag* semântico estrutural (Ear-Voice Span): em traduções do alemão ou de construções passivas em inglês para o português, o modelo precisa de pelo menos 3 a 5 palavras de contexto futuro para não cometer erros crônicos de concordância de gênero e tempo verbal.

#### (3) Alternativas Mais Viáveis
* Manter o par EN↔PT-BR, mas arquitetar os prompts e os parâmetros de decodificação de forma assimétrica para cada direção (ex: streaming mais agressivo em EN→PT e confirmação semântica em PT→EN).

#### (4) Veredicto
> **MANTÉM.** Escopo adequado e realista para a v1.

---

### [D4] Hardware alvo: Apple Silicon M4 Pro 48 GB (L18, L79, L94)

#### (1) Erros e Imprecisões Técnicas
* **Capacidade de Memória (VRAM):** A estimativa do ADR (4–7 GB no total com quants 4-bit) está tecnicamente correta. Os 48 GB de memória unificada oferecem margem abundante para pesos, KV-cache e buffers de áudio.
* **Falsa Suposição de Isolamento de Hardware:** O texto afirma que rodar em 3 processos separados garante que *"a escuta é o caminho crítico de latência e nunca pode serrarse para raciocinar"* (L21, L87). Isso ignora a arquitetura do Apple Silicon:
  * Todos os 3 processos competem pela **mesma GPU Metal** e pelo **mesmo barramento de memória unificada (273 GB/s)**.
  * O Metal framework no macOS multiplexa comandos de GPU via filas de comando (*command queues*). Uma rajada de prefill massivo do LFM3-1.7B (Processo 2) prenderá as unidades de execução da GPU (Execution Units / SIMD cores), causando *frame drops* e atrasos de dezenas a centenas de milissegundos no loop de decode do modelo de áudio (Processo 1).

#### (2) Riscos de Latência
* Contenção de largura de banda de memória (Memory Bandwidth Saturation) durante acessos concorrentes de prefill e decode.
* *Audio underrun* (estalos e engasgos na reprodução) no Processo 3 caso a GPU seja monopolizada por um turno de raciocínio do Processo 2.

#### (3) Alternativas Mais Viáveis
* **Particionamento Heterogêneo de Compute:**
  * Processo 1 (Escuta/Áudio): Fixo na **GPU via MLX/Metal** com prioridade alta.
  * Processo 2 (Assistente de Texto): Deslocado para a **CPU (Apple Matrix Coprocessor - AMX / NEON)** rodando via `llama.cpp` quantizado (Q4_K_M). Os 14 núcleos de CPU do M4 Pro processam LLMs de 1.7B a ~40-60 tok/s sem tocar na GPU nem degradar o pipeline de áudio.
  * VAD: Mantido na CPU (conforme o ADR já especificou).

#### (4) Veredicto
> **AJUSTA.** O hardware M4 Pro é excelente, mas o ADR precisa especificar o particionamento de hardware (CPU vs GPU) para evitar contenção catastrófica no Metal.

---

### [D5] Licença: LFM Open License v1.0 aceitável (L19)

#### (1) Erros e Imprecisões Técnicas
* O texto do ADR cita: *"uso pessoal; limite comercial = receita < US$ 10M"*.
* Para prototipagem, validação técnica v1 e uso estritamente pessoal, a licença é aplicável sem taxas.
* Restrições e termos exatos de redistribuição de pesos derivados / quantizados em ecossistema comunitário: `NÃO VERIFICADO` se a Liquid AI impõe restrições adicionais em modelos convertidos para MLX ou redistribuídos publicamente.

#### (2) Riscos de Latência
* Não aplicável (questão puramente de compliance).

#### (3) Alternativas Mais Viáveis
* Preservar a opção de modelos sob licença puramente permissiva (MIT / Apache-2.0), tais como Whisper (MIT), Kokoro (Apache-2.0) e Qwen2.5 (Apache-2.0), caso o projeto venha a ser comercializado ou empacotado como produto aberto.

#### (4) Veredicto
> **MANTÉM.** Válida para o escopo e estágio definidos.

---

### [D6] LFM3-Audio-2B (MLX) para escuta e fala na v1 — STT, tradução e TTS em modelo único (L20, L61, L64)

#### (1) Erros e Imprecisões Técnicas
* **Inviabilidade do Runtime Especificado (L64):**
  * O ADR especifica: *"LM Studio headless (`lms server start`, API OpenAI /v1 + SSE) ou `mlx-openai-server` (pip)"*.
  * **Isso é um erro técnico estrutural grave.** O LM Studio e o `mlx-openai-server` são servidores projetados para chat textual padrão (`/v1/chat/completions`). Eles não possuem suporte à ingestão contínua de PCM 16 kHz com tokenização `LiquidCodec`, nem à transmissão de tokens de áudio sintetizados para desvocodificação PCM 24 kHz via streaming SSE nesse formato.
  * Para executar o `LFM3-Audio-2B` em MLX de forma nativa com áudio in/out, é estritamente obrigatório usar o runtime dedicado fornecido pelo repositório oficial da Liquid AI / implementação específica em MLX com o vocoder integrado, e não um servidor genérico de chat completions.
* **Contradição Arquitetural Interna (D6 vs D7):**
  * Em D6, afirma-se que o modelo é *any-to-any* (S2ST direto em modelo único).
  * No entanto, o diagrama (L36-37) e a tabela de interfaces (L70-74) definem:
    `AudioSource → VAD → SttPort → TranslatorPort → TtsPort`
  * Se o modelo faz S2ST direto, as portas `TranslatorPort` e `TtsPort` deixam de existir no caminho da escuta. Se as portas existem, o LFM3-Audio-2B está sendo subutilizado apenas como ASR ou ASR+MT, gerando redundância computacional de 2 bilhões de parâmetros para tarefas que modelos especializados de 100M a 500M parâmetros realizam com menor latência.

#### (2) Riscos de Latência
* **A Falácia do VAD de Utterance Completa (L33-35, L85):**
  * O próprio ADR registra como risco aceito: *"Legenda só aparece no fim da fala (Audio-2B não gera parcial em tempo real)"*.
  * **Este risco destrói o requisito de latência extrema.**
  * Exemplo real em conferência: se o interlocutor fala por 8 segundos contínuos, o Silero VAD aguarda o fim da fala + janela de hangover (ex: 500 ms) = **8.5 segundos**. Só então o buffer é despachado para o modelo processar o prefill e decodificar a saída. A latência percebida pelo usuário será de **9 a 10 segundos**! Isso inviabiliza qualquer dinâmica de conversa e destrói o propósito da legenda.
* **Tempo de Primeiro Áudio Citado (L61):**
  * Cita-se *"1º áudio ~140 ms em M4 Max"*. Esse número refere-se unicamente ao TTFT sintético de geração após o prompt estar pré-computado em hardware superior (M4 Max tem 546 GB/s de bandwidth vs 273 GB/s do M4 Pro alvo). Ele não reflete a latência end-to-end (captura + VAD + prefill de áudio longo + decode + vocodificação).

#### (3) Alternativas Mais Viáveis
* **Arquitetura Cascata Otimizada para Streaming Real (Sub-segundo):**
  1. **STT Streaming:** `whisper.cpp` com streaming local (modo sliding window / WhisperLiveKit com *LocalAgreement*) ou `Parakeet-CTC 0.6B` / `Qwen2-Audio` emitindo tokens a cada 200–300 ms de fala, sem esperar silêncio.
  2. **Tradução:** Modelo ultracompacto (ex: `Qwen2.5-1.5B` ou `LFM3-1.7B` texto) com política de tradução incremental por chunks de texto.
  3. **TTS Streaming:** `Kokoro-82M` (ONNX/Metal), que gera o primeiro chunk de áudio em ~80–120 ms sobre pequenas sentenças, suportando nativamente vozes em PT-BR (`pf_dora`, `pm_alex`).
* Se mantido o LFM3-Audio-2B: Deve-se validar na Fase 0 se ele suporta modo streaming causal com *chunking* contínuo de 500 ms sem fechamento de sentença. Caso contrário, deve ser rebaixado imediatamente.

#### (4) Veredicto
> **DERRUBA (como arquitetura padrão v1) / REBAIXA A EXPERIMENTAL.** A combinação de runtime incompatível (LM Studio) com dependência de fim de frase por VAD inviabiliza o requisito de latência extrema.

---

### [D8] Cenário 2 (Entrevista) = 3 Processos Independentes (Escuta + Assistente + Fala) (L21, L40-53, L79)

#### (1) Erros e Imprecisões Técnicas
* **Inviabilidade Operacional do Fluxo WYSIWYT (What You See Is What You Type) em Tempo Real (L79):**
  * O ADR descreve: *"B usa a v1 como WYSIWYT: edita ou aprova; aprovar envia ao Proc. 3"*.
  * Em uma entrevista técnica real, o tempo cognitivo humano para ler uma sugestão textual de 2 ou 3 parágrafos, editar eventuais erros e clicar em "Aprovar" leva entre **10 e 25 segundos**. Se o candidato fica 20 segundos em silêncio absoluto após cada pergunta do entrevistador, a entrevista fica descaracterizada e artificial.
* **Instabilidade de UI por Re-geração Contínua (L43-45):**
  * O documento prevê: *"a cada segmento confirmado [...] re-gera sugestão de resposta técnica [...] re-streama a sugestão"*.
  * Se o interlocutor fala uma frase longa composta por 4 segmentos de VAD, a UI re-iniciará o streaming da resposta 4 vezes consecutivas. Enquanto o usuário tenta ler a linha 1 da primeira sugestão, o texto é apagado e substituído por uma nova resposta. Isso causa *layout thrashing* e sobrecarga cognitiva intransponível.

#### (2) Riscos de Latência & Concorrência
* Conforme exposto em D4, colocar 3 processos pesados disputando a GPU Metal causará picos de latência no processo de escuta no exato momento em que o assistente disparar a geração da resposta técnica.

#### (3) Alternativas Mais Viáveis
* **Debounce e Gatilho Semântico de Fim de Pergunta:** O assistente não deve re-gerar sugestões a cada segmento parcial de VAD. Ele deve aguardar um detector de intenção/interrogação ou um silêncio consolidado (>1.5s), ou ser acionado manualmente por um atalho de teclado (*Push-to-Assist*).
* **Sugestões Curtas (Bullet Points / Teleprompter):** O assistente deve gerar tópicos-chave em 2 linhas concisas para o usuário ler diretamente com sua própria voz, em vez de gerar monólogos para aprovação e síntese TTS.
* **Isolamento de Compute:** Mover o `LFM3-1.7B` para a CPU (conforme D4).

#### (4) Veredicto
> **AJUSTA.** O isolamento em processos distintos é salutar, mas o modelo de concorrência de GPU, a dinâmica de UI e o fluxo humano de aprovação precisam de reformulação total.

---

### [D7] Pipeline Plugável por Interface (STT/TRAD/TTS) (L22, L68-77)

#### (1) Erros e Imprecisões Técnicas
* A decisão é excelente e segue os princípios da Clean Architecture. A única inconsistência reside na incompatibilidade entre as interfaces granulares definidas (`SttPort`, `TranslatorPort`, `TtsPort`) e a escolha em D6 de um bloco monolítico S2ST.
* Se D6 for mantido, as interfaces precisam prever portas compostas (`SpeechToSpeechPort` com emissão de eventos parciais de transcrição e tradução).

#### (2) Riscos de Latência
* A divisão em processos distintos exige comunicação inter-processos (IPC). Se feito via HTTP/REST clássico com serialização JSON pesada, adiciona-se overhead desnecessário de sockets e context switching no kernel.
* IPC de alta eficiência em macOS deve utilizar **Unix Domain Sockets**, **Shared Memory (POSIX `shm_open`)** ou filas de memória compartilhada para transmissão de buffers PCM brutos de áudio.

#### (3) Alternativas Mais Viáveis
* Manter as interfaces e utilizá-las para implementar a cascata desacoplada de alto desempenho (Whisper streaming + MT ultrarrápido + Kokoro TTS) como o pipeline primário da v1.

#### (4) Veredicto
> **MANTÉM.** É a decisão mais sólida e prudente do ADR, funcionando como a rede de proteção que salvará o projeto caso D6 colapse na Fase 0.

---

## 3. Matriz Consolidada de Veredictos

| # | Decisão | Veredicto | Resumo da Justificativa Técnica |
|---|---|:---:|---|
| **D1** | Captação/Reprodução via mic/falantes padrão sem BlackHole | **DERRUBA** | Loop de eco acústico inevitável, alucinações recursivas e cancelamento destrutivo pelo Zoom/Meet. Exige loopback digital (BlackHole ou CoreAudio Tap). |
| **D2** | Saída TTS pelo som do notebook | **DERRUBA** | O áudio não chega limpo ao interlocutor remoto (é suprimido como ruído). Requer injeção digital como Microfone Virtual. |
| **D3** | UI com idiomas selecionáveis; v1 em EN↔PT-BR | **MANTÉM** | Escopo pragmático. Exige atenção às assimetrias gramaticais na tradução simultânea. |
| **D4** | Hardware M4 Pro 48 GB | **AJUSTA** | VRAM é farta, mas falta particionamento de compute. Manter 3 processos na GPU Metal gera contenção e jitter no áudio. Assistente deve ir para CPU. |
| **D5** | Licença LFM Open License v1.0 | **MANTÉM** | Plenamente compatível com protótipo v1 e uso pessoal. |
| **D6** | LFM3-Audio-2B único em 2 instâncias via LM Studio | **DERRUBA** | LM Studio não suporta áudio nativo/LiquidCodec via API de chat; o VAD de sentença completa transforma o app em tradução consecutiva lenta (3-10s lag). |
| **D7** | Interfaces plugáveis (STT / TRAD / TTS) | **MANTÉM** | Arquitetura desacoplada indispensável; protege o projeto e viabiliza a migração para cascata rápida. |
| **D8** | Cenário 2 com 3 processos e re-geração contínua | **AJUSTA** | O fluxo de aprovação manual introduz latência humana impraticável em entrevistas; a re-geração a cada segmento causa instabilidade na UI. |

---

## 4. Itens Não Verificados (Conforme Diretriz Antitapeação)

1. **`NÃO VERIFICADO` — Qualidade de Sotaque e Acentuação PT-BR no LFM3-Audio-2B:** Não há benchmarks públicos padronizados de inteligibilidade fonética e prosódia para dialetos brasileiros no LiquidCodec em comparação com modelos dedicados de TTS.
2. **`NÃO VERIFICADO` — Suporte Causal Streaming no LFM3-Audio-2B em MLX:** A documentação pública não comprova categoricamente a capacidade de inferência por janelas deslizantes (streaming incremental sem encerramento de áudio) no port MLX disponível.
3. **`NÃO VERIFICADO` — Estabilidade de Driver em Sessões Longas com BlackHole + CoreAudio no macOS 15 (Sequoia):** Necessário testar se o *drift* de clock entre o dispositivo agregado e o hardware de som do M4 Pro não acumula latência de buffer após 45 minutos contínuos de chamada.

---

## 5. Proposta de Arquitetura Corrigida para Latência Extrema

Para atingir **latência extrema real (atraso total percebido < 800–1200 ms)** em reuniões e entrevistas no M4 Pro, a arquitetura deve ser ajustada para a topologia abaixo:

```
[Videoconferência / Zoom]
       │ (Áudio remoto digital)
       ▼
[CoreAudio Tap / BlackHole 2ch] ────► [VAD Streaming - Silero CPU]
                                              │ (Chunks de 200ms)
                                              ▼
                                    [STT: Whisper.cpp / Parakeet] (GPU Metal)
                                              │ (Tokens parciais em tempo real)
                                              ▼
                                    [UI: Legenda Instantânea]
                                              │
                    ┌─────────────────────────┴─────────────────────────┐
                    ▼                                                   ▼
         [MT: Qwen2.5-1.5B / LFM3-1.7B]                      [Assistente Técnico]
             (Tradução incremental)                               (CPU / AMX)
                    │                                                   │
                    ▼                                                   ▼
       [TTS: Kokoro-82M / LiquidCodec]                       [UI: Sugestão Tópicos]
             (Sentenças parciais)                                       │
                    │                                                   ▼
                    ▼                                        (Aprovação rápida / Fala)
       [Microfone Virtual (BlackHole)] ─────────────────────────────────┘
                    │
                    ▼
[Entrada de Mic na Videoconferência] (Interlocutor ouve áudio digital cristalino)
```

### Principais Ganhos da Correção:
1. **Zero Eco e Áudio Cristalino:** Eliminação total do canal acústico da sala;
2. **Legendas em Tempo Real:** Tokens fluem para a tela a cada 200 ms de fala do interlocutor;
3. **Zero Jitter na GPU:** O assistente de raciocínio opera nos núcleos de CPU/AMX, deixando os 20 núcleos de GPU do M4 Pro 100% dedicados à decodificação contínua de áudio.
