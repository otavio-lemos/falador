// Descrições PT dos nós — honestas, baseadas nos fatos medidos (AGENTS.md §4).
export const NODE_DESCRIPTIONS: Record<string, string> = {
  'capture.ffmpeg':
    'CAPTURA de áudio. Pega o som do sistema (BlackHole = o que você ouve na call) ou do mic. Emite frames brutos de audio (s16le). backend sounddevice (PortAudio, recomendado — ffmpeg 9 perde samples) ou ffmpeg; input = nome do device (sounddevice) ou :N (ffmpeg).',
  'asr.realtime':
    'TRANSCRIÇÃO em STREAMING (WS /v1/realtime do server mlx-audio, Voxtral). Texto vai saindo palavra a palavra. NÃO traduz — lang do audio é detectada, texto sai no idioma falado.',
  'asr.lfm3':
    'TRANSCRIÇÃO + TRADUÇÃO NATIVA (LFM3-Audio task=chat). traduz DIRETO do aúdio pro PT — sem nó llm no meio. não é streaming: traduz por janela de tempo (flushSec). medido ~15× realtime.',
  'llm.omlx':
    'LLM TEXTO via omlx :8080 (streaming SSE). uso: tradução EN→PT, assistente de entrevista, qualquer instruction/template. enable_thinking:false já vem de fábrica.',
  'decision.llm':
    'DECISÃO/ROTEAMENTO: escolhe UMA opção e manda o payload pela PORTA correspondente (ex.: options [auto,humano] → portas dec.auto e dec.humano). mode=systemone usa d1-2B (LiquidAI, calibrado) via omlx /v1/systemone — VERIFICADO: ~40 ms/decisão; mode=chat usa LLM gerando texto (mais lento, sem calibração).',
  'human.approve':
    'GATE HUMANO: o run PAUSA, a sugestão aparece na UI (editável) e só segue depois de Aprovar/Rejeitar. use quando a máquina não pode decidir sozinha.',
  'tts.sts':
    'VOZ (TTS) via sidecar LFM3-Audio :8091. fala em EN/PT no momento que a frase fecha. idioma por nó (param language). não é streaming: entrega o WAV completo.',
  'sink.playback':
    'TOCA o áudio gerado nos alto-falantes (afplay serializado). é o som que você ouve do outro lado.',
  'sink.captions':
    'LEGENDAS: mostra parciais (linha que sobrescreve) + finais em linha nova. modo tela/console ou callback (UI web).',
  'sink.collect':
    'coleta tudo que chega nela (pro testes/auto-binding da UI). não faz nada visível — endpoints de prova.',
  'source.tone':
    'FONTE DE TESTE sintética: dispara N payloads fake. serve pra testar o grafo SEM áudio real.',
  'pipe.delay':
    'atrasa o fluxo (teste de timing/backpressure).',
  'pipe.parcs':
    'cola: transforma string em tokens_parcial {text, final} — necessário entre nós que falam "texto" e nós que esperam "tokens_parcial".',
};

/** Descrições dos cenários prontos (também dentro de cada flow JSON). */
export const SCENARIOS: Record<string, string> = {
  'cenario1-pt': 'Cenário 1: fala EN da call → legenda PT em tempo real (streaming)',
  'cenario1-lfm3': 'Cenário 1 (nativo): traduz direto do áudio, janelas de 12s',
  'cenario2-auto': 'Cenário 2: entrevista — LLM sugere resposta, máquina decide sozinha',
  'cenario2': 'Cenário 2: entrevista com GATE humano (você aprova cada resposta)',
};
