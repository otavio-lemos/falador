// Dados da UI: categorias da paleta (cores/emoji do layout do dono), metadados
// humanos por nó, e documentação + DEFAULT REAL de cada param (extraído do código
// dos nós). Os IDs de nó e paramNames vêm do catálogo real (/api/catalog).

export interface Category {
  id: string;
  label: string;
  emoji: string;
  accent: string; // cor de destaque (header do nó + stripe da paleta)
  nodes: string[];
  collapsible?: boolean;
}

export const CATEGORIES: Category[] = [
  { id: 'captura', label: 'Captura', emoji: '🎙️', accent: '#22d3ee', nodes: ['capture.ffmpeg'] },
  { id: 'transcricao', label: 'Transcrição', emoji: '💡', accent: '#14b8a6', nodes: ['asr.realtime', 'asr.lfm3'] },
  { id: 'pensar', label: 'Pensar', emoji: '🧠', accent: '#8b5cf6', nodes: ['llm.omlx'] },
  { id: 'decidir', label: 'Decidir', emoji: '🔀', accent: '#f59e0b', nodes: ['decision.llm', 'human.approve'] },
  { id: 'falar', label: 'Falar', emoji: '🗣️', accent: '#d946ef', nodes: ['tts.sts'] },
  { id: 'saida', label: 'Saída', emoji: '📺', accent: '#22c55e', nodes: ['sink.captions', 'sink.playback'] },
  { id: 'teste', label: 'Teste', emoji: '🔧', accent: '#9ca3af', nodes: ['source.tone', 'pipe.delay', 'pipe.parcs', 'sink.collect'], collapsible: true },
];

export interface NodeMeta {
  title: string; // nome humano (hero do card)
  subtitle: string;
  desc: string; // descrição curta pra paleta
}

export const NODE_META: Record<string, NodeMeta> = {
  'capture.ffmpeg': { title: 'Captura da call', subtitle: 'Zoom · Meet · Teams · mic', desc: 'Ouve o áudio do app que você escolher' },
  'asr.realtime':  { title: 'Transcrição em tempo real', subtitle: 'Voxtral streaming', desc: 'Converte fala em texto enquanto o outro fala' },
  'asr.lfm3':      { title: 'Transcrição + tradução direta', subtitle: 'LFM3-Audio', desc: 'Ouve e já traduz sem etapa extra de texto' },
  'llm.omlx':      { title: 'Assistente de texto', subtitle: 'Sugestão · Tradução · Resposta', desc: 'Recebe texto e gera resposta, tradução ou sugestão' },
  'decision.llm':  { title: 'Decisão automática', subtitle: 'Escolhe o próximo passo', desc: 'Roteia o fluxo sem precisar de você' },
  'human.approve': { title: 'Aprovação manual', subtitle: 'Revisar antes de continuar', desc: 'Pausa para você editar ou aprovar' },
  'tts.sts':       { title: 'Voz (falar em voz alta)', subtitle: 'EN / PT', desc: 'Converte texto em fala sintetizada' },
  'sink.captions': { title: 'Legenda na tela', subtitle: 'Texto ao vivo', desc: 'Mostra o texto gerado na interface' },
  'sink.playback': { title: 'Tocar no alto-falante', subtitle: 'Áudio sintetizado', desc: 'Toca o áudio no seu dispositivo' },
  'source.tone':   { title: 'Frases de teste', subtitle: 'Gera texto sintético', desc: 'Fonte de dados para testar o fluxo' },
  'pipe.delay':    { title: 'Atraso', subtitle: 'Atrasa mensagens', desc: 'Introduz um delay configurável' },
  'pipe.parcs':    { title: 'Parciais', subtitle: 'Quebra em streaming', desc: 'Converte texto completo em parciais' },
  'sink.collect':  { title: 'Coleta resultado', subtitle: 'Junta a saída (teste)', desc: 'Acumula tudo para verificar o resultado' },
};

export function categoryOf(type: string): Category {
  return CATEGORIES.find((c) => c.nodes.includes(type)) ?? CATEGORIES[CATEGORIES.length - 1];
}
export function accentOf(type: string): string {
  return categoryOf(type).accent;
}

export interface ParamDoc {
  help: string;
  def?: string;
  // tipo de controle sugerido (além da heurística por nome/valor)
  control?: 'dropdown' | 'slider' | 'toggle' | 'textarea' | 'json' | 'model' | 'text';
  options?: { val: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

const BACKENDS = [
  { val: 'sck', label: 'sck — ScreenCaptureKit por app (recomendado)' },
  { val: 'sounddevice', label: 'sounddevice — PortAudio por device' },
  { val: 'ffmpeg', label: 'ffmpeg — avfoundation (perde samples no ffmpeg 9)' },
];
export const LANGS = [
  { val: 'English', label: 'English (inglês) ★' },
  { val: 'Portuguese', label: 'Portuguese (português) ★' },
  { val: 'Spanish', label: 'Spanish (espanhol)' },
  { val: 'French', label: 'French (francês)' },
  { val: 'German', label: 'German (alemão)' },
];

export const PARAM_HELP: Record<string, Record<string, ParamDoc>> = {
  'capture.ffmpeg': {
    backend: { help: 'como capturar o áudio', def: 'sck', control: 'dropdown', options: BACKENDS },
    input: { help: 'sck: nome do app da call (Teams/zoom.us/Chrome); sounddevice: device (BlackHole/Microfone); ffmpeg: índice :N', def: ':0' },
    sampleRate: { help: 'sample rate de saída (Hz)', def: '16000', control: 'slider', min: 8000, max: 48000, step: 8000, unit: 'Hz' },
    chunkMs: { help: 'tamanho de cada frame (ms)', def: '80', control: 'slider', min: 20, max: 500, step: 20, unit: 'ms' },
    ffmpegPath: { help: 'binário ffmpeg (backend ffmpeg)', def: '/opt/homebrew/bin/ffmpeg' },
    pythonPath: { help: 'python do .venv (backend sounddevice)', def: '.venv/bin/python' },
    sidecarPath: { help: 'capture-sidecar.py (backend sounddevice)', def: 'services/capture-sidecar.py' },
    sckPath: { help: 'binário capture-sck (backend sck)', def: 'services/capture-sck' },
  },
  'asr.realtime': {
    url: { help: 'WebSocket do server mlx-audio', def: 'ws://127.0.0.1:8090/v1/realtime' },
    model: { help: 'modelo com streaming (Voxtral Realtime)', def: 'Voxtral-Mini-4B-Realtime-2602-4bit', control: 'model' },
    inputRate: { help: 'sample rate do PCM que entra (Hz)', def: '16000', control: 'slider', min: 8000, max: 48000, step: 8000, unit: 'Hz' },
    serverVad: { help: 'VAD do servidor detecta fim de fala', def: 'true', control: 'toggle' },
    commitEveryMs: { help: 'sem serverVad: força transcrição a cada N ms', def: '900', control: 'slider', min: 200, max: 3000, step: 100, unit: 'ms' },
    silenceThresholdMs: { help: 'sem serverVad: silêncio de N ms = fim de turno', def: '800', control: 'slider', min: 200, max: 3000, step: 100, unit: 'ms' },
  },
  'asr.lfm3': {
    url: { help: 'sidecar de tradução (POST /asr-translate)', def: 'http://127.0.0.1:8091' },
    instruction: { help: 'instrução enviada ao LFM3-Audio com o áudio', def: 'Transcribe and translate to Brazilian Portuguese…', control: 'textarea' },
    sampleRateHz: { help: 'sample rate do PCM (Hz)', def: '16000', control: 'slider', min: 8000, max: 48000, step: 8000, unit: 'Hz' },
    flushSec: { help: 'janela de tradução (s). Janela que corta a frase faz o modelo transcrever em vez de traduzir — use ≥ duração da fala', def: '30', control: 'slider', min: 3, max: 60, step: 1, unit: 's' },
    timeoutMs: { help: 'timeout de cada tradução (ms)', def: '120000' },
    maxTranslateChars: { help: 'corta a tradução em N caracteres', def: '4000' },
  },
  'llm.omlx': {
    baseUrl: { help: 'servidor OpenAI-compat (omlx)', def: 'http://127.0.0.1:8080' },
    model: { help: 'modelo de texto no omlx', def: 'LiquidAI--LFM3-1.7B-MLX-4bit', control: 'model' },
    targetLanguage: { help: 'idioma da tradução (usado quando template está vazio)', def: '', control: 'dropdown', options: [
      { val: 'Portuguese', label: 'Português' },
      { val: 'English', label: 'Inglês' },
      { val: 'Spanish', label: 'Espanhol' },
      { val: 'French', label: 'Francês' },
      { val: 'German', label: 'Alemão' },
    ] },
    system: { help: 'system prompt: papel e idioma da resposta', def: '(sem system)', control: 'textarea' },
    template: { help: 'JSON array de strings: instrução ANTES do texto recebido. Vazio = só o texto', def: '[]', control: 'json' },
    temperature: { help: 'criatividade (0 = determinístico)', def: '0.2', control: 'slider', min: 0, max: 1, step: 0.1 },
    maxTokens: { help: 'máximo de tokens gerados', def: '256', control: 'slider', min: 16, max: 2048, step: 16 },
    enableThinking: { help: 'false OBRIGATÓRIO no LFM3 (senão conteúdo vem vazio)', def: 'false', control: 'toggle' },
    historyMax: { help: 'pares user/assistant no contexto (0 = sem memória)', def: '0', control: 'slider', min: 0, max: 20, step: 1 },
  },
  'decision.llm': {
    baseUrl: { help: 'servidor OpenAI-compat (omlx)', def: 'http://127.0.0.1:8080' },
    model: { help: 'systemone: d1-2B (~40 ms, calibrado); chat: LLM de texto', def: 'LiquidAI--LFM3-1.7B-MLX-4bit', control: 'model' },
    mode: { help: 'chat = LLM responde a opção; systemone = decisão calibrada d1', def: 'chat', control: 'dropdown', options: [{ val: 'chat', label: 'chat — LLM de texto' }, { val: 'systemone', label: 'systemone — d1 calibrado' }] },
    options: { help: 'JSON array: opções de roteamento — cada uma vira uma PORTA de saída', def: '["auto","humano"]', control: 'json' },
    criteria: { help: 'JSON objeto opção→critério em inglês (systemone)', def: '{}', control: 'json' },
    instructions: { help: 'instrução da decisão (chat)', def: 'Decida a categoria do texto. Responda com UMA opção.', control: 'textarea' },
    defaultOption: { help: 'opção usada quando a resposta não casa', def: 'primeira opção' },
    temperature: { help: 'criatividade (chat)', def: '0.0', control: 'slider', min: 0, max: 1, step: 0.1 },
    maxTokens: { help: 'máximo de tokens (chat)', def: '8', control: 'slider', min: 1, max: 64, step: 1 },
    enableThinking: { help: 'desliga o pensamento do LFM3', def: 'false', control: 'toggle' },
  },
  'tts.sts': {
    url: { help: 'sidecar de voz (POST /tts). NÃO inclua /tts', def: 'http://127.0.0.1:8091' },
    language: { help: 'idioma da fala', def: 'English', control: 'dropdown', options: LANGS },
    voice: { help: 'voz do modelo', def: 'female', control: 'dropdown', options: [{ val: 'female', label: 'female' }, { val: 'male', label: 'male' }] },
    sampleRateHz: { help: 'sample rate (sidecar entrega 24 kHz)', def: '24000', control: 'slider', min: 16000, max: 48000, step: 8000, unit: 'Hz' },
    timeoutMs: { help: 'timeout da síntese (ms)', def: '60000' },
    speakOn: { help: 'quando falar: final = só no fim; partial = ao vivo', def: 'final', control: 'dropdown', options: [{ val: 'final', label: 'final — só no fim' }, { val: 'partial', label: 'partial — ao vivo' }] },
    maxTextChars: { help: 'corta o texto em N caracteres', def: '2000' },
  },
  'sink.captions': {
    mode: { help: 'stdout = terminal; callback = eventos pra UI (use callback na web)', def: 'stdout', control: 'dropdown', options: [{ val: 'stdout', label: 'stdout — terminal' }, { val: 'callback', label: 'callback — UI' }] },
    showParcials: { help: 'mostra parciais ao vivo', def: 'true', control: 'toggle' },
    outputFile: { help: 'arquivo opcional para salvar somente as frases finais', def: '', control: 'text' },
  },
  'sink.playback': {
    player: { help: 'binário que toca o WAV', def: '/usr/bin/afplay' },
    tempDir: { help: 'diretório dos WAVs temporários', def: '(tmp do sistema)' },
    maxQueue: { help: 'falas empilhadas além disso são descartadas', def: '4', control: 'slider', min: 1, max: 16, step: 1 },
  },
  'human.approve': {},
  'source.tone': {
    count: { help: 'quantas frases emitir', def: '5', control: 'slider', min: 1, max: 50, step: 1 },
    intervalMs: { help: 'pausa entre frases (ms)', def: '0', control: 'slider', min: 0, max: 5000, step: 100, unit: 'ms' },
    prefix: { help: 'texto da frase (numerada: prefix-1, prefix-2…)', def: 'tone' },
  },
  'pipe.delay': {
    delayMs: { help: 'atrasa cada mensagem N ms', def: '0', control: 'slider', min: 0, max: 5000, step: 100, unit: 'ms' },
  },
  'pipe.parcs': {},
  'sink.collect': {},
};