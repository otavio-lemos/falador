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
  { id: 'input', label: 'Input', emoji: '🎙️', accent: '#22d3ee', nodes: ['capture.ffmpeg'] },
  { id: 'transcricao', label: 'Transcription', emoji: '💡', accent: '#14b8a6', nodes: ['asr.realtime', 'asr.lfm3'] },
  { id: 'pensar', label: 'Reasoning', emoji: '🧠', accent: '#8b5cf6', nodes: ['llm.omlx', 'translate.llm', 'agent.tools'] },
  { id: 'decidir', label: 'Routing', emoji: '🔀', accent: '#f59e0b', nodes: ['turn.detector', 'decision.llm', 'human.approve'] },
  { id: 'acoes', label: 'Actions / Connectors', emoji: '⚡', accent: '#f97316', nodes: ['exec.command', 'rag.search', 'tool.mcp', 'tool.workflow', 'tool.web_search', 'tool.crawler'] },
  { id: 'output', label: 'Output', emoji: '🗣️', accent: '#22c55e', nodes: ['sink.captions'] },
  { id: 'teste', label: 'Testing', emoji: '🔧', accent: '#9ca3af', nodes: ['source.tone', 'pipe.delay', 'pipe.parcs', 'sink.collect'], collapsible: true },
];

export interface NodeMeta {
  title: string; // nome humano (hero do card)
  subtitle: string;
  desc: string; // descrição curta pra paleta
}

export const NODE_META: Record<string, NodeMeta> = {
  'capture.ffmpeg': { title: 'Input', subtitle: 'Aplicações · Microfone · Chat', desc: 'Única entrada: Aplicações, Microfone ou Chat' },
  'input.chat':    { title: 'Chat Input', subtitle: 'Entrada escrita interativa', desc: 'Campo de prompt para escrever e ligar em nós de texto' },
  'asr.realtime':  { title: 'Speech to Text (STT)', subtitle: 'Voxtral streaming', desc: 'Converte fala em texto enquanto o outro fala' },
  'asr.lfm3':      { title: 'Speech Translation (S2ST)', subtitle: 'LFM3-Audio', desc: 'Ouve e já traduz sem etapa extra de texto' },
  'llm.omlx':      { title: 'LLM', subtitle: 'Sugestão · Tradução · Resposta', desc: 'Recebe texto e gera resposta, tradução ou sugestão' },
  'translate.llm': { title: 'Translate', subtitle: 'Modelo + idioma (opcional)', desc: 'Traduz texto para o idioma escolhido; selecione — para desabilitar' },
  'agent.tools':   { title: 'Tool-calling Agent', subtitle: 'Loop multi-step · OpenAI tools', desc: 'Chama ferramentas conectadas em múltiplos passos até diagnosticar' },
  'turn.detector': { title: 'Turn Detection', subtitle: 'd1-2B semântico', desc: 'Distingue pausa de fim real de pergunta ou solicitação' },
  'decision.llm':  { title: 'Decision / Router', subtitle: 'Escolhe o próximo passo', desc: 'Roteia o fluxo sem precisar de você' },
  'human.approve': { title: 'Human Approval (HITL)', subtitle: 'Revisar antes de continuar', desc: 'Pausa para você editar ou aprovar' },
  'exec.command':  { title: 'Execute Command', subtitle: 'Local · SSH (guardrails)', desc: 'Executa comandos aprovados com validação e audit log' },
  'rag.search':    { title: 'RAG Search', subtitle: 'BM25 local · Runbooks', desc: 'Expõe documentos e runbooks locais como ferramenta sob demanda' },
  'tool.mcp':      { title: 'MCP Connector', subtitle: 'stdio · Streamable HTTP', desc: 'Conecta servidores MCP externos com allowlist e dry-run' },
  'tool.workflow': { title: 'Workflow Tools', subtitle: 'flows/*.json · AGENTS.md', desc: 'Lista, lê, valida, salva workflows e atualiza o AGENTS.md' },
  'tool.web_search': { title: 'Web Search', subtitle: 'DuckDuckGo · anti-SSRF', desc: 'Pesquisa externa e leitura de documentação pública com proteção anti-SSRF' },
  'tool.crawler':  { title: 'Crawler', subtitle: 'HTML · BFS · anti-SSRF', desc: 'Raspa páginas ou faz crawl em sites com limite e proteção anti-SSRF' },
  'tts.sts':       { title: 'Text to Speech', subtitle: 'EN / PT', desc: 'Converte texto em fala sintetizada' },
  'sink.captions': { title: 'Output', subtitle: 'Escrever · Falar', desc: 'Única saída: texto na tela (Escrever) ou texto + voz (Falar)' },
  'sink.playback': { title: 'Audio Playback', subtitle: 'Áudio sintetizado', desc: 'Toca o áudio no seu dispositivo' },
  'source.tone':   { title: 'Test Source', subtitle: 'Gera texto sintético', desc: 'Fonte de dados para testar o fluxo' },
  'pipe.delay':    { title: 'Delay', subtitle: 'Atrasa mensagens', desc: 'Introduz um delay configurável' },
  'pipe.parcs':    { title: 'Partials', subtitle: 'Quebra em streaming', desc: 'Converte texto completo em parciais' },
  'sink.collect':  { title: 'Collector', subtitle: 'Junta a saída (teste)', desc: 'Acumula tudo para verificar o resultado' },
};

export function categoryOf(type: string): Category {
  if (type === 'input.chat') return CATEGORIES[0];
  if (type === 'tts.sts' || type === 'sink.playback') return CATEGORIES.find((c) => c.id === 'output') ?? CATEGORIES[CATEGORIES.length - 1];
  return CATEGORIES.find((c) => c.nodes.includes(type)) ?? CATEGORIES[CATEGORIES.length - 1];
}
export function accentOf(type: string): string {
  return categoryOf(type).accent;
}

export const SHORT_NAMES: Record<string, string> = {
  'capture.ffmpeg': 'Input',
  'input.chat': 'Chat',
  'asr.realtime': 'Transcription',
  'asr.lfm3': 'Speech Translation',
  'llm.omlx': 'LLM',
  'translate.llm': 'Translate',
  'agent.tools': 'Agent',
  'turn.detector': 'Turn Detector',
  'decision.llm': 'Decision',
  'human.approve': 'Approval',
  'exec.command': 'Command',
  'rag.search': 'RAG',
  'tool.mcp': 'MCP',
  'tool.workflow': 'Workflows',
  'tool.web_search': 'Web',
  'tool.crawler': 'Crawler',
  'tts.sts': 'TTS',
  'sink.captions': 'Output',
  'sink.playback': 'Playback',
  'source.tone': 'Test Source',
  'pipe.delay': 'Delay',
  'pipe.parcs': 'Partials',
  'sink.collect': 'Collector',
};

export function shortNodeName(type: string, id: string, params?: Record<string, unknown>): string {
  if (type === 'llm.omlx' && params && params.targetLanguage !== undefined) return 'Translate';
  return SHORT_NAMES[type] ?? NODE_META[type]?.title?.split(' ')[0] ?? id;
}

export function serviceOfNode(type: string): 'web' | 'asr' | 'omlx' | 'tts' {
  if (type === 'asr.realtime') return 'asr';
  if (
    type === 'llm.omlx' ||
    type === 'translate.llm' ||
    type === 'agent.tools' ||
    type === 'turn.detector' ||
    type === 'decision.llm'
  ) {
    return 'omlx';
  }
  if (type === 'tts.sts' || type === 'asr.lfm3') return 'tts';
  return 'web';
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
  { val: 'sck', label: 'Aplicações — ScreenCaptureKit (automático)' },
  { val: 'sounddevice', label: 'Microfone — padrão do sistema (PortAudio)' },
  { val: 'chat', label: 'Chat — entrada de texto interativa' },
  { val: 'ffmpeg', label: 'ffmpeg — avfoundation (legado)' },
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
    backend: { help: 'modo de entrada: Aplicações (sck), Microfone (sounddevice) ou Chat (chat)', def: 'sck', control: 'dropdown', options: BACKENDS },
    input: { help: 'sck: nome do app da call (Teams/zoom.us/Chrome); sounddevice: device (BlackHole/Microfone); ffmpeg: índice :N', def: ':0' },
    placeholder: { help: 'texto exibido no campo de chat quando em modo Chat', def: 'Digite sua mensagem ou comando…', control: 'text' },
    initialMessage: { help: 'mensagem inicial opcional enviada automaticamente no modo Chat', def: '', control: 'textarea' },
    sampleRate: { help: 'sample rate de saída (Hz)', def: '16000', control: 'slider', min: 8000, max: 48000, step: 8000, unit: 'Hz' },
    chunkMs: { help: 'tamanho de cada frame (ms)', def: '80', control: 'slider', min: 20, max: 500, step: 20, unit: 'ms' },
    ffmpegPath: { help: 'binário ffmpeg (backend ffmpeg)', def: '/opt/homebrew/bin/ffmpeg' },
    pythonPath: { help: 'python do .venv (backend sounddevice)', def: '.venv/bin/python' },
    sidecarPath: { help: 'capture-sidecar.py (backend sounddevice)', def: 'services/capture-sidecar.py' },
    sckPath: { help: 'binário capture-sck (backend sck)', def: 'services/capture-sck' },
    isDefault: { help: 'marca este Input como padrão (controlado pelo botão de microfone na topbar)', def: 'false', control: 'toggle' },
  },
  'input.chat': {
    placeholder: { help: 'texto exibido no campo de prompt da interface', def: 'Digite sua mensagem ou comando…', control: 'text' },
    initialMessage: { help: 'mensagem inicial opcional enviada automaticamente ao iniciar o fluxo', def: '', control: 'textarea' },
  },
  'asr.realtime': {
    url: { help: 'WebSocket do server mlx-audio', def: 'ws://127.0.0.1:8090/v1/realtime' },
    model: { help: 'modelo com streaming (Voxtral Realtime)', def: 'Voxtral-Mini-4B-Realtime-2602-4bit', control: 'model' },
    inputRate: { help: 'sample rate do PCM que entra (Hz)', def: '16000', control: 'slider', min: 8000, max: 48000, step: 8000, unit: 'Hz' },
    serverVad: { help: 'VAD do servidor detecta fim de fala', def: 'true', control: 'toggle' },
    commitEveryMs: { help: 'sem serverVad: força transcrição a cada N ms', def: '900', control: 'slider', min: 200, max: 3000, step: 100, unit: 'ms' },
    silenceThresholdMs: { help: 'sem serverVad: silêncio de N ms = fim de turno', def: '800', control: 'slider', min: 200, max: 3000, step: 100, unit: 'ms' },
    maxPendingMs: { help: 'teto em ms de áudio retido antes de conectar/reconectar (anti-drift)', def: '2000', control: 'slider', min: 200, max: 10000, step: 200, unit: 'ms' },
    emitInterruptOnSpeech: { help: 'emite barge-in (interrupt) quando fala recomeça para abortar geração obsoleta', def: 'false', control: 'toggle' },
    bargeInDebounceMs: { help: 'duração mínima de fala sustentada (ms) para disparar interrupt (filtra ruído)', def: '300', control: 'slider', min: 50, max: 1500, step: 50, unit: 'ms' },
  },
  'asr.lfm3': {
    url: { help: 'sidecar de tradução (POST /asr-translate)', def: 'http://127.0.0.1:8091' },
    model: { help: 'modelo multimodal LFM3-Audio', def: 'LiquidAI--LFM3-Audio-2B-MLX-8bit', control: 'model' },
    targetLanguage: { help: 'idioma de saída (vazio = só transcreve no idioma original)', def: '', control: 'dropdown', options: [{ val: '', label: '— (só transcrever)' }, ...LANGS] },
    instruction: { help: 'instrução enviada ao LFM3-Audio com o áudio', def: 'Transcribe and translate to Brazilian Portuguese…', control: 'textarea' },
    sampleRateHz: { help: 'sample rate do PCM (Hz)', def: '16000', control: 'slider', min: 8000, max: 48000, step: 8000, unit: 'Hz' },
    flushSec: { help: 'janela de tradução (s). Janela que corta a frase faz o modelo transcrever em vez de traduzir — use ≥ duração da fala', def: '30', control: 'slider', min: 3, max: 60, step: 1, unit: 's' },
    timeoutMs: { help: 'timeout de cada tradução (ms)', def: '120000' },
    maxTranslateChars: { help: 'corta a tradução em N caracteres', def: '4000' },
  },
  'translate.llm': {
    baseUrl: { help: 'servidor OpenAI-compat (omlx)', def: 'http://127.0.0.1:8080' },
    model: { help: 'modelo LLM tradutor (use "-" para passthrough)', def: 'LiquidAI--LFM3-1.7B-MLX-4bit', control: 'model' },
    targetLanguage: { help: 'idioma de tradução (vazio = desabilitado, apenas repassa)', def: '', control: 'dropdown', options: [{ val: '', label: '— (desabilitado)' }, ...LANGS] },
    temperature: { help: 'criatividade (0.1 = tradução fiel)', def: '0.1', control: 'slider', min: 0, max: 1, step: 0.1 },
    maxTokens: { help: 'máximo de tokens gerados', def: '256', control: 'slider', min: 16, max: 2048, step: 16 },
    enableThinking: { help: 'false OBRIGATÓRIO no LFM3 (senão conteúdo vem vazio)', def: 'false', control: 'toggle' },
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
    historyCharBudget: { help: 'orçamento máximo de caracteres no histórico antes de podar pares antigos', def: '4000', control: 'slider', min: 500, max: 16000, step: 500, unit: 'chars' },
    useContext: { help: 'consulta documentos/runbooks locais via RAG BM25 e injeta trechos relevantes no system', def: 'false', control: 'toggle' },
    contextTopK: { help: 'número máximo de chunks recuperados via BM25', def: '3', control: 'slider', min: 1, max: 10, step: 1 },
    contextTags: { help: 'JSON array opcional de tags para filtrar documentos (ex.: ["nginx","ops"])', def: '[]', control: 'json' },
    contextMaxChars: { help: 'limite máximo de caracteres do bloco RAG injetado no system', def: '2400', control: 'slider', min: 400, max: 8000, step: 200, unit: 'chars' },
  },
  'agent.tools': {
    baseUrl: { help: 'servidor OpenAI-compat (omlx)', def: 'http://127.0.0.1:8080' },
    model: { help: 'modelo de texto com suporte a tool_calls no omlx', def: 'LiquidAI--LFM3-1.7B-MLX-4bit', control: 'model' },
    system: { help: 'system prompt: papel do agente e instruções de investigação', def: '(sem system)', control: 'textarea' },
    maxSteps: { help: 'limite rígido de passos de tool_calls por turno (máx 12)', def: '5', control: 'slider', min: 1, max: 12, step: 1 },
    maxToolOutputChars: { help: 'orçamento máximo de caracteres por retorno de tool (tail)', def: '8000', control: 'slider', min: 500, max: 32000, step: 500, unit: 'chars' },
    approvalPolicy: {
      help: 'política de aprovação humana antes de invocar tools',
      def: 'always',
      control: 'dropdown',
      options: [
        { val: 'always', label: 'always — aprovar toda chamada (seguro)' },
        { val: 'non_readonly', label: 'non_readonly — aprovar mutáveis ou sensíveis' },
        { val: 'never', label: 'never — executar sem gate humano' },
      ],
    },
    d1Model: { help: 'modelo d1 opcional para triagem de risco (ex.: d1-2B-MLX-4bit)', def: '' },
    enableThinking: { help: 'false OBRIGATÓRIO no LFM3 (senão conteúdo vem vazio)', def: 'false', control: 'toggle' },
    historyMax: { help: 'pares user/assistant mantidos no contexto (0 = sem memória)', def: '4', control: 'slider', min: 0, max: 20, step: 1 },
    historyCharBudget: { help: 'orçamento máximo de caracteres no histórico antes de podar', def: '4000', control: 'slider', min: 500, max: 16000, step: 500, unit: 'chars' },
    temperature: { help: 'criatividade (0.1 = objetivo)', def: '0.1', control: 'slider', min: 0, max: 1, step: 0.1 },
    maxTokens: { help: 'máximo de tokens por passo do agente', def: '512', control: 'slider', min: 64, max: 4096, step: 64 },
  },
  'turn.detector': {
    baseUrl: { help: 'servidor omlx (/v1/systemone)', def: 'http://127.0.0.1:8080' },
    model: { help: 'modelo de decisão calibrado (d1-2B)', def: 'd1-2B-MLX-4bit', control: 'model' },
    mode: { help: 'systemone = d1 semântico (~40 ms); heuristic = pontuação', def: 'systemone', control: 'dropdown', options: [{ val: 'systemone', label: 'systemone — d1 semântico' }, { val: 'heuristic', label: 'heuristic — pontuação' }] },
    minWords: { help: 'turnos com menos palavras só fecham por timeout', def: '3', control: 'slider', min: 1, max: 15, step: 1 },
    completeThreshold: { help: 'confiança mínima de complete para liberar imediatamente', def: '0.65', control: 'slider', min: 0, max: 1, step: 0.05 },
    maxWaitMs: { help: 'tempo máximo segurando turno incomplete antes de liberar', def: '2200', control: 'slider', min: 300, max: 8000, step: 100, unit: 'ms' },
    maxMergedTurns: { help: 'máximo de segmentos ASR mesclados num único turno', def: '4', control: 'slider', min: 1, max: 10, step: 1 },
  },
  'exec.command': {
    transport: { help: 'local = spawn direto (shell:false); ssh = remoto via ssh BatchMode', def: 'local', control: 'dropdown', options: [{ val: 'local', label: 'local — máquina atual' }, { val: 'ssh', label: 'ssh — servidor remoto' }] },
    mode: { help: 'readonly = prefixos seguros padrão; allowlist = lista explícita', def: 'readonly', control: 'dropdown', options: [{ val: 'readonly', label: 'readonly — diagnóstico seguro' }, { val: 'allowlist', label: 'allowlist — lista explícita' }] },
    dryRun: { help: 'SEGURO POR PADRÃO: valida e audita sem executar o comando real', def: 'true', control: 'toggle' },
    allowedPrefixes: { help: 'JSON array de prefixos de comando permitidos (ex.: ["df","uptime","journalctl"])', def: '["uname","uptime","df",...]', control: 'json' },
    allowedHosts: { help: 'JSON array obrigatório para SSH (vazio recusa SSH)', def: '[]', control: 'json' },
    defaultHost: { help: 'host SSH padrão quando payload não informar host', def: '' },
    sshUser: { help: 'usuário SSH (se vazio usa ~/.ssh/config)', def: '' },
    sshPort: { help: 'porta SSH', def: '22' },
    cwd: { help: 'diretório de trabalho (apenas transport=local)', def: '' },
    timeoutMs: { help: 'timeout de execução do processo (ms, máx 60000)', def: '15000', control: 'slider', min: 1000, max: 60000, step: 1000, unit: 'ms' },
    maxOutputBytes: { help: 'limite de bytes preservados de stdout/stderr (tail)', def: '32768' },
  },
  'rag.search': {
    toolName: { help: 'nome da tool exposta ao agent.tools', def: 'search_docs' },
    topK: { help: 'número máximo de trechos retornados por consulta BM25', def: '3', control: 'slider', min: 1, max: 10, step: 1 },
    tags: { help: 'JSON array opcional de tags padrão para filtrar documentos', def: '[]', control: 'json' },
    maxChars: { help: 'limite máximo de caracteres retornados pela busca', def: '2400', control: 'slider', min: 400, max: 8000, step: 200, unit: 'chars' },
    docsPath: { help: 'caminho do arquivo de índice de documentos', def: 'context/docs.json' },
  },
  'tool.mcp': {
    serverName: { help: 'prefixo/namespace opcional nas tools (evita colisão entre MCPs)', def: '' },
    transport: {
      help: 'transporte JSON-RPC 2.0 do servidor MCP',
      def: 'stdio',
      control: 'dropdown',
      options: [
        { val: 'stdio', label: 'stdio — processo filho local (shell:false)' },
        { val: 'http', label: 'http — Streamable HTTP' },
      ],
    },
    command: { help: 'binário para transporte stdio (ex.: npx ou caminho absoluto)', def: '' },
    args: { help: 'JSON array de argumentos para o comando stdio', def: '[]', control: 'json' },
    envAllowlist: { help: 'JSON array de nomes de variáveis de ambiente permitidas (nunca coloque segredos aqui)', def: '[]', control: 'json' },
    url: { help: 'endpoint Streamable HTTP (localhost/127.0.0.1 liberado por padrão)', def: '' },
    allowedUrls: { help: 'JSON array de URLs externas explicitamente permitidas para transporte http', def: '[]', control: 'json' },
    allowedTools: { help: 'JSON array obrigatório das tools do MCP liberadas ao agente (vazio = bloqueado)', def: '[]', control: 'json' },
    dryRun: { help: 'SEGURO POR PADRÃO: valida e audita chamadas MCP sem executar', def: 'true', control: 'toggle' },
    timeoutMs: { help: 'timeout de cada chamada RPC MCP (ms, máx 60000)', def: '15000', control: 'slider', min: 1000, max: 60000, step: 1000, unit: 'ms' },
    auditLogPath: { help: 'arquivo JSONL de auditoria das chamadas MCP', def: 'logs/exec-audit.jsonl' },
  },
  'tool.workflow': {
    flowsDir: { help: 'diretório restrito onde os workflows (.json) são lidos e salvos', def: 'apps/tui/flows', control: 'text' },
    agentsMdPath: { help: 'caminho do AGENTS.md atualizado ao salvar workflows', def: 'AGENTS.md', control: 'text' },
    dryRun: { help: 'valida e gera preview sem gravar arquivos em disco', def: 'false', control: 'toggle' },
    allowDelete: { help: 'permite remover workflows (agente-workflows é sempre protegido)', def: 'false', control: 'toggle' },
    auditLogPath: { help: 'arquivo JSONL de auditoria das operações de workflow', def: 'logs/exec-audit.jsonl', control: 'text' },
  },
  'tool.web_search': {
    endpoint: { help: 'endpoint de busca (default DuckDuckGo Instant Answer)', def: 'https://api.duckduckgo.com/', control: 'text' },
    timeoutMs: { help: 'timeout da consulta HTTP (ms, máx 30000)', def: '8000', control: 'slider', min: 1000, max: 30000, step: 1000, unit: 'ms' },
    maxResults: { help: 'número máximo de resultados retornados pela busca', def: '5', control: 'slider', min: 1, max: 15, step: 1 },
    maxChars: { help: 'limite máximo de caracteres retornados por busca ou página', def: '4000', control: 'slider', min: 500, max: 16000, step: 500, unit: 'chars' },
  },
  'tool.crawler': {
    maxPages: { help: 'número máximo de páginas visitadas no crawl (1 a 20)', def: '5', control: 'slider', min: 1, max: 20, step: 1 },
    maxDepth: { help: 'profundidade máxima de links seguidos no BFS (0 a 3)', def: '1', control: 'slider', min: 0, max: 3, step: 1 },
    sameOriginOnly: { help: 'restringe o crawl à mesma origem (protocolo + host + porta) da URL inicial', def: 'true', control: 'toggle' },
    allowedDomains: { help: 'JSON array opcional de domínios permitidos (ex.: ["example.com"]). Vazio = qualquer domínio público', def: '[]', control: 'json' },
    timeoutMs: { help: 'timeout por página HTTP (ms, 1000 a 30000)', def: '8000', control: 'slider', min: 1000, max: 30000, step: 1000, unit: 'ms' },
    maxCharsPerPage: { help: 'limite máximo de caracteres extraídos por página', def: '4000', control: 'slider', min: 500, max: 16000, step: 500, unit: 'chars' },
    maxTotalChars: { help: 'limite máximo de caracteres no relatório consolidado', def: '16000', control: 'slider', min: 1000, max: 32000, step: 1000, unit: 'chars' },
    userAgent: { help: 'cabeçalho User-Agent enviado nas requisições HTTP', def: 'FaladorCrawler/1.0 (local-on-device)', control: 'text' },
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
    outputMode: {
      help: 'modo de saída: write = apenas texto na tela; speak = texto na tela + voz sintetizada',
      def: 'write',
      control: 'dropdown',
      options: [
        { val: 'write', label: 'Escrever — apenas texto' },
        { val: 'speak', label: 'Falar — texto + voz' },
      ],
    },
    isDefault: { help: 'marca este Output como padrão (controlado pelo botão de voz na topbar)', def: 'false', control: 'toggle' },
    language: { help: 'idioma da fala quando em modo Falar', def: 'Portuguese', control: 'dropdown', options: LANGS },
    voice: { help: 'voz do modelo TTS no modo Falar', def: 'female', control: 'dropdown', options: [{ val: 'female', label: 'female' }, { val: 'male', label: 'male' }] },
    ttsUrl: { help: 'sidecar de voz (POST /tts). NÃO inclua /tts', def: 'http://127.0.0.1:8091' },
    sampleRateHz: { help: 'sample rate do WAV TTS (Hz)', def: '24000', control: 'slider', min: 16000, max: 48000, step: 8000, unit: 'Hz' },
    timeoutMs: { help: 'timeout da síntese TTS (ms)', def: '60000' },
    maxTextChars: { help: 'corta o texto falado em N caracteres', def: '1400' },
    player: { help: 'binário que toca o WAV no modo Falar', def: '/usr/bin/afplay' },
    maxQueue: { help: 'falas empilhadas além disso são descartadas', def: '4', control: 'slider', min: 1, max: 16, step: 1 },
    mode: { help: 'stdout = terminal; callback = eventos pra UI (use callback na web)', def: 'stdout', control: 'dropdown', options: [{ val: 'stdout', label: 'stdout — terminal' }, { val: 'callback', label: 'callback — UI' }] },
    showParcials: { help: 'mostra parciais ao vivo', def: 'true', control: 'toggle' },
    outputFile: { help: 'arquivo opcional para salvar somente as frases finais', def: '', control: 'text' },
  },
  'sink.playback': {
    player: { help: 'binário que toca o WAV', def: '/usr/bin/afplay' },
    tempDir: { help: 'diretório dos WAVs temporários', def: '(tmp do sistema)' },
    maxQueue: { help: 'falas empilhadas além disso são descartadas', def: '4', control: 'slider', min: 1, max: 16, step: 1 },
  },
  'human.approve': {
    mode: {
      help: 'manual = aguarda aprovação humana; auto = aprova direto (bypass)',
      def: 'manual',
      control: 'dropdown',
      options: [
        { val: 'manual', label: 'manual — aprovação humana' },
        { val: 'auto', label: 'auto — passar direto' },
      ],
    },
  },
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