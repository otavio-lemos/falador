// Documentação dos params por nó — significado + DEFAULT REAL (extraído do código
// dos nós, 2026-11-19). O Inspector mostra como helperText e como placeholder
// quando o param está omitido. Nada de "usa default" sem dizer qual.
export interface ParamDoc {
  help: string;
  def?: string; // default real do nó (string p/ exibição)
}

export const PARAM_HELP: Record<string, Record<string, ParamDoc>> = {
  'capture.ffmpeg': {
    backend: { help: 'como capturar: sck = ScreenCaptureKit por app (recomendado, sem routing); sounddevice = PortAudio por device; ffmpeg = avfoundation (perde samples no ffmpeg 9)', def: 'ffmpeg' },
    input: { help: 'sck: nome do app da call (Teams/zoom.us/Chrome — escolha na lista ou digite um que vai abrir); sounddevice: nome do device (BlackHole/Microfone); ffmpeg: índice :N', def: ':0' },
    sampleRate: { help: 'sample rate de saída dos frames (Hz)', def: '16000' },
    chunkMs: { help: 'tamanho de cada frame de áudio (ms)', def: '80' },
    ffmpegPath: { help: 'caminho do binário ffmpeg (backend ffmpeg)', def: '/opt/homebrew/bin/ffmpeg' },
    pythonPath: { help: 'python do .venv com sounddevice (backend sounddevice)', def: '.venv/bin/python do repo' },
    sidecarPath: { help: 'script capture-sidecar.py (backend sounddevice)', def: 'services/capture-sidecar.py' },
    sckPath: { help: 'binário capture-sck (backend sck; compilado do .swift automaticamente)', def: 'services/capture-sck' },
  },
  'asr.realtime': {
    url: { help: 'WebSocket do server mlx-audio (subset OpenAI Realtime)', def: 'ws://127.0.0.1:8090/v1/realtime' },
    model: { help: 'snapshot do modelo com StreamingSession (Voxtral Realtime). LFM3-Audio NÃO funciona aqui', def: 'Voxtral-Mini-4B-Realtime-2602-4bit (snapshot HF)' },
    inputRate: { help: 'sample rate do PCM que entra (Hz) — tem que casar com a captura', def: '16000' },
    serverVad: { help: 'true = VAD do servidor (Silero) detecta fim de fala; false = commit manual por tempo', def: 'true' },
    commitEveryMs: { help: 'sem serverVad: força transcrição a cada N ms', def: '900' },
    silenceThresholdMs: { help: 'sem serverVad: silêncio de N ms = fim de turno', def: '800' },
  },
  'asr.lfm3': {
    url: { help: 'sidecar TTS/tradução (POST /asr-translate)', def: 'http://127.0.0.1:8091' },
    instruction: { help: 'instrução enviada ao LFM3-Audio junto com o áudio', def: 'Transcribe the audio and translate it to Brazilian Portuguese…' },
    sampleRateHz: { help: 'sample rate do PCM acumulado (Hz)', def: '16000' },
    flushSec: { help: 'janela de tradução (s). IMPORTANTE: janela que corta a frase no meio faz o modelo transcrever em vez de traduzir — use ≥ duração da fala', def: '30' },
    timeoutMs: { help: 'timeout de cada chamada de tradução (ms)', def: '120000' },
    maxTranslateChars: { help: 'corta a tradução em N caracteres', def: '4000' },
  },
  'llm.omlx': {
    baseUrl: { help: 'servidor OpenAI-compat (omlx)', def: 'http://127.0.0.1:8080' },
    model: { help: 'modelo de texto no omlx (escolha na lista — ★ recomendado)', def: 'LiquidAI--LFM3-1.7B-MLX-4bit' },
    system: { help: 'system prompt: papel e idioma da resposta', def: '(sem system)' },
    template: { help: 'JSON array de strings: instrução que vai ANTES do texto recebido, ex. ["Traduza para PT…"] ou ["Suggest an answer in ENGLISH…"]. Vazio = só o texto', def: '[] (neutro)' },
    temperature: { help: 'criatividade (0 = determinístico)', def: '0.2' },
    maxTokens: { help: 'máximo de tokens gerados', def: '256' },
    enableThinking: { help: 'false OBRIGATÓRIO no LFM3 (senão o conteúdo vem vazio, só reasoning)', def: 'false' },
    historyMax: { help: 'pares user/assistant mantidos no contexto (0 = sem memória)', def: '0' },
  },
  'decision.llm': {
    baseUrl: { help: 'servidor OpenAI-compat (omlx)', def: 'http://127.0.0.1:8080' },
    model: { help: 'modelo da decisão. mode=systemone: d1-2B (1 forward pass, ~40 ms, probabilidade calibrada); mode=chat: LLM de texto', def: 'LiquidAI--LFM3-1.7B-MLX-4bit' },
    mode: { help: 'chat = LLM responde a opção; systemone = endpoint /v1/systemone dos modelos d1 (decisão calibrada, sem gerar texto)', def: 'chat' },
    options: { help: 'JSON array: as opções de roteamento — cada uma vira uma PORTA de saída, ex. ["auto","humano"]', def: '[]' },
    defaultOption: { help: 'opção usada quando a resposta não casa com nenhuma', def: 'primeira opção' },
    instructions: { help: 'instrução da decisão (mode chat)', def: 'Decida a qual categoria o texto abaixo pertence…' },
    criteria: { help: 'JSON objeto opção→critério em inglês (mode systemone), ex. {"auto":"Routine technical question…","humano":"Sensitive…"}', def: '(usa o nome da opção)' },
    temperature: { help: 'criatividade (mode chat)', def: '0.0' },
    maxTokens: { help: 'máximo de tokens (mode chat)', def: '8' },
    enableThinking: { help: 'desliga o pensamento do LFM3', def: 'false' },
  },
  'tts.sts': {
    url: { help: 'sidecar de voz (POST /tts). NÃO inclua /tts — o nó acrescenta', def: 'http://127.0.0.1:8091' },
    language: { help: 'idioma da fala (English/Portuguese verificados no LFM3-Audio)', def: 'English' },
    voice: { help: 'voz do modelo', def: 'female' },
    sampleRateHz: { help: 'sample rate pedido (o sidecar entrega 24 kHz)', def: '24000' },
    timeoutMs: { help: 'timeout da síntese (ms)', def: '60000' },
  },
  'sink.captions': {
    mode: { help: 'stdout = terminal; callback = eventos pro host/UI (use callback na web)', def: 'stdout' },
    showParcials: { help: 'mostra parciais ao vivo (não só o final)', def: 'true' },
  },
  'sink.playback': {
    player: { help: 'binário que toca o WAV (afplay = saída default do sistema)', def: '/usr/bin/afplay' },
    maxQueue: { help: 'falas empilhadas além disso são descartadas (ao vivo, latência > 3 falas = inútil)', def: '4' },
  },
  'human.approve': {},
  'source.tone': {
    count: { help: 'quantas frases sintéticas emitir', def: '(obrigatório)' },
    intervalMs: { help: 'pausa entre frases (ms)', def: '0' },
    prefix: { help: 'texto da frase (o nó numera: prefix-1, prefix-2…)', def: 'tone' },
  },
  'pipe.delay': {
    delayMs: { help: 'atrasa cada mensagem N ms (simula latência)', def: '0' },
  },
  'pipe.parcs': {},
  'sink.collect': {},
};