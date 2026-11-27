// Deriva as ETAPAS do workflow (dropdowns por etapa da tela de execução) e
// classifica os sinks de legenda em transcrição (alimentado pelo ASR) vs sugestão.
import type { Flow, ContextDoc } from './api';
import { accentOf, shortNodeName, solutionOfNodeType } from './data';

export interface Stage {
  key: string;
  label: string;
  accent: string;
  nodeId: string;
  nodeType: string;
  param: string;
  kind:
    | 'app'
    | 'model-asr'
    | 'model-asr-lfm3'
    | 'model-llm'
    | 'model-translate'
    | 'model-decision'
    | 'approve-mode'
    | 'voice'
    | 'output-mode'
    | 'exec-mode'
    | 'conector-rag'
    | 'conector-web'
    | 'conector-crawler'
    | 'conector-mcp'
    | 'conector-workflow';
  value: string;
  isDefault?: boolean;
  options?: string[];
  secondaryParam?: string;
  secondaryKind?: 'language-optional' | 'language-required' | 'transport';
  secondaryValue?: string;
  secondaryLabel?: string;
}

export const DEFAULT_LLM_MODEL = 'LiquidAI--LFM3-1.7B-MLX-4bit';
export const DEFAULT_DECISION_MODEL = 'd1-2B-MLX-4bit';

const LANG_OPTION_LABELS: Record<string, string> = {
  Portuguese: 'Português',
  English: 'Inglês',
  Spanish: 'Espanhol',
  French: 'Francês',
  German: 'Alemão',
  Italian: 'Italiano',
  Dutch: 'Holandês',
  Polish: 'Polonês',
  Russian: 'Russo',
  Chinese: 'Chinês',
  Japanese: 'Japonês',
  Korean: 'Coreano',
  Arabic: 'Árabe',
  Hindi: 'Hindi',
  Turkish: 'Turco',
  Vietnamese: 'Vietnamita',
};

const AUDIO_LANG_IDS = ['Portuguese', 'English', 'Spanish', 'French', 'German', 'Italian', 'Japanese', 'Korean', 'Chinese'];
const LFM_TEXT_LANG_IDS = [
  'Portuguese', 'English', 'Spanish', 'French', 'German', 'Italian', 'Dutch', 'Polish',
  'Russian', 'Chinese', 'Japanese', 'Korean', 'Arabic', 'Hindi', 'Turkish', 'Vietnamese',
];
const GENERAL_LLM_LANG_IDS = [
  'Portuguese', 'English', 'Spanish', 'French', 'German', 'Italian', 'Dutch',
  'Russian', 'Chinese', 'Japanese', 'Korean', 'Arabic', 'Hindi',
];

export function supportedLanguagesForModel(modelId: string, includeDisable = true): { id: string; label: string }[] {
  const s = norm(modelId || '');
  let ids: string[];
  if (/lfm.*audio/i.test(s)) {
    ids = AUDIO_LANG_IDS;
  } else if (/lfm3|lfm2\.?5/i.test(s)) {
    ids = LFM_TEXT_LANG_IDS;
  } else {
    ids = GENERAL_LLM_LANG_IDS;
  }
  const list = ids.map((id) => ({ id, label: LANG_OPTION_LABELS[id] ?? id }));
  return includeDisable ? [{ id: '', label: '— (desabilitado)' }, ...list] : list;
}

function normalizeOptionalLang(raw: unknown): string {
  const s = String(raw ?? '').trim();
  return s === '-' || s === '—' ? '' : s;
}

function topoRank(flow: Pick<Flow, 'nodes' | 'edges'>): Map<string, number> {
  const rank = new Map<string, number>();
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const ids = new Set(flow.nodes.map((n) => n.id));
  for (const n of flow.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of flow.edges) {
    const u = e.from.split('.')[0];
    const v = e.to.split('.')[0];
    if (ids.has(u) && ids.has(v) && u !== v) {
      adj.get(u)!.push(v);
      indeg.set(v, (indeg.get(v) ?? 0) + 1);
    }
  }
  const q: string[] = [];
  for (const n of flow.nodes) if ((indeg.get(n.id) ?? 0) === 0) q.push(n.id);
  let idx = 0;
  while (q.length) {
    const u = q.shift()!;
    rank.set(u, idx++);
    for (const v of adj.get(u) ?? []) {
      const next = (indeg.get(v) ?? 1) - 1;
      indeg.set(v, next);
      if (next === 0) q.push(v);
    }
  }
  for (const n of flow.nodes) if (!rank.has(n.id)) rank.set(n.id, idx++);
  return rank;
}

export interface NodeDisplayName { label: string; number: number }

// Nome exibido de cada componente: nome curto + número da instância na ordem
// topológica (Input 1, Transcrição 1, Output 1, Output 2…). É a ÚNICA fonte do
// nome mostrado no canvas, no mini-mapa, na conversa e na barra de etapas.
export function nodeDisplayNames(
  nodes: Flow['nodes'],
  edges: Flow['edges'],
): Map<string, NodeDisplayName> {
  const rank = topoRank({ nodes, edges });
  const ordered = [...nodes].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  const count = new Map<string, number>();
  const out = new Map<string, NodeDisplayName>();
  for (const n of ordered) {
    const base = shortNodeName(n.type, n.id, n.params);
    const number = (count.get(base) ?? 0) + 1;
    count.set(base, number);
    out.set(n.id, { label: `${base} ${number}`, number });
  }
  return out;
}

export function deriveStages(flow: Flow): Stage[] {
  const rank = topoRank(flow);
  const out: Stage[] = [];
  for (const n of flow.nodes) {
    if (n.enabled === false) continue;
    const p = n.params as Record<string, unknown>;
    if (n.type === 'capture.ffmpeg') {
      const backend = String(p.backend ?? 'chat');
      const mode: 'apps' | 'mic' | 'chat' =
        backend === 'chat' || p.muted === true
          ? 'chat'
          : backend === 'sounddevice'
            ? 'mic'
            : 'apps';
      out.push({
        key: `input-${n.id}`,
        label: 'Input',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'backend',
        kind: 'app',
        value: mode,
        isDefault: p.isDefault === true,
      });
    } else if (n.type === 'sink.captions') {
      out.push({
        key: `output-${n.id}`,
        label: 'Output',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'outputMode',
        kind: 'output-mode',
        value: p.outputMode === 'speak' ? 'speak' : 'write',
        isDefault: p.isDefault === true,
      });
    } else if (n.type === 'asr.realtime') {
      out.push({
        key: `asr-${n.id}`,
        label: 'Transcription',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'model',
        kind: 'model-asr',
        value: String(p.model ?? ''),
      });
    } else if (n.type === 'asr.lfm3') {
      out.push({
        key: `asr-lfm3-${n.id}`,
        label: 'Speech Translation',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'model',
        kind: 'model-asr-lfm3',
        value: String(p.model ?? 'LiquidAI--LFM3-Audio-2B-MLX-8bit'),
        secondaryParam: 'targetLanguage',
        secondaryKind: 'language-optional',
        secondaryValue: p.targetLanguage !== undefined
          ? normalizeOptionalLang(p.targetLanguage)
          : (p.instruction ? 'Portuguese' : ''),
        secondaryLabel: 'Idioma',
      });
    } else if (n.type === 'translate.llm') {
      out.push({
        key: `translate-${n.id}`,
        label: 'Translate',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'model',
        kind: 'model-translate',
        value: p.model !== undefined ? String(p.model) : DEFAULT_LLM_MODEL,
        secondaryParam: 'targetLanguage',
        secondaryKind: 'language-optional',
        secondaryValue: normalizeOptionalLang(p.targetLanguage),
        secondaryLabel: 'Idioma',
      });
    } else if (n.type === 'llm.omlx') {
      if (p.targetLanguage !== undefined) {
        out.push({
          key: `llm-${n.id}`,
          label: 'Translate',
          accent: accentOf(n.type),
          nodeId: n.id,
          nodeType: n.type,
          param: 'model',
          kind: 'model-llm',
          value: String(p.model ?? DEFAULT_LLM_MODEL),
          secondaryParam: 'targetLanguage',
          secondaryKind: 'language-optional',
          secondaryValue: normalizeOptionalLang(p.targetLanguage),
          secondaryLabel: 'Idioma',
        });
      } else {
        out.push({
          key: `llm-${n.id}`,
          label: 'LLM',
          accent: accentOf(n.type),
          nodeId: n.id,
          nodeType: n.type,
          param: 'model',
          kind: 'model-llm',
          value: String(p.model ?? DEFAULT_LLM_MODEL),
        });
      }
    } else if (n.type === 'agent.tools') {
      out.push({
        key: `agent-${n.id}`,
        label: 'Agent',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'model',
        kind: 'model-llm',
        value: String(p.model ?? DEFAULT_LLM_MODEL),
      });
    } else if (n.type === 'turn.detector') {
      out.push({
        key: `turn-${n.id}`,
        label: 'Turn Detector',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'model',
        kind: 'model-decision',
        value: String(p.model ?? DEFAULT_DECISION_MODEL),
      });
    } else if (n.type === 'decision.llm') {
      out.push({
        key: `decision-${n.id}`,
        label: 'Decision',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'model',
        kind: 'model-decision',
        value: String(p.model ?? (p.mode === 'systemone' ? DEFAULT_DECISION_MODEL : DEFAULT_LLM_MODEL)),
      });
    } else if (n.type === 'human.approve') {
      out.push({
        key: `approve-${n.id}`,
        label: 'Approval',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'mode',
        kind: 'approve-mode',
        value: String(p.mode ?? 'non_readonly'),
      });
    } else if (n.type === 'goal.validator') {
      out.push({
        key: `validator-${n.id}`,
        label: 'Validator',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'model',
        kind: 'model-llm',
        value: String(p.model ?? DEFAULT_LLM_MODEL),
      });
    } else if (n.type === 'exec.command') {
      out.push({
        key: `exec-${n.id}`,
        label: 'Exec/SSH',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'dryRun',
        kind: 'exec-mode',
        value: p.dryRun === false ? 'ativo' : 'dry-run',
        secondaryParam: 'transport',
        secondaryKind: 'transport',
        secondaryValue: String(p.transport ?? 'local'),
        secondaryLabel: 'Transport',
      });
    } else if (n.type === 'rag.search') {
      out.push({
        key: `rag-${n.id}`,
        label: 'RAG',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'topK',
        kind: 'conector-rag',
        value: String(p.topK ?? '3'),
      });
    } else if (n.type === 'tool.web_search') {
      out.push({
        key: `websearch-${n.id}`,
        label: 'WebSearch',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'maxResults',
        kind: 'conector-web',
        value: String(p.maxResults ?? '5'),
      });
    } else if (n.type === 'tool.crawler') {
      out.push({
        key: `crawler-${n.id}`,
        label: 'Crawler',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'maxPages',
        kind: 'conector-crawler',
        value: String(p.maxPages ?? '5'),
      });
    } else if (n.type === 'tool.mcp') {
      out.push({
        key: `mcp-${n.id}`,
        label: 'MCP',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'transport',
        kind: 'conector-mcp',
        value: String(p.transport ?? 'stdio'),
      });
    } else if (n.type === 'tool.workflow') {
      out.push({
        key: `workflow-${n.id}`,
        label: 'Workflows',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'dryRun',
        kind: 'conector-workflow',
        value: p.dryRun === false ? 'ativo' : 'dry-run',
      });
    } else if (n.type === 'tts.sts') {
      out.push({
        key: `voz-${n.id}`,
        label: 'TTS',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'voice',
        kind: 'voice',
        value: String(p.voice ?? 'female'),
        secondaryParam: 'language',
        secondaryKind: 'language-required',
        secondaryValue: String(p.language ?? 'English'),
        secondaryLabel: 'Idioma',
      });
    }
  }

  // Se o flow contém agent.tools mas não possui nós dedicados de Decision, Approval ou Validator,
  // expõe essas etapas a partir dos parâmetros de capability do próprio agente.
  const agentNode = flow.nodes.find((n) => n.enabled !== false && n.type === 'agent.tools');
  if (agentNode) {
    const ap = agentNode.params as Record<string, unknown>;
    if (!out.some((s) => s.label === 'Decision')) {
      out.push({
        key: `decision-${agentNode.id}`,
        label: 'Decision',
        accent: '#f59e0b',
        nodeId: agentNode.id,
        nodeType: 'decision.llm',
        param: 'd1Model',
        kind: 'model-decision',
        value: String(ap.d1Model ?? DEFAULT_DECISION_MODEL),
      });
    }
    if (!out.some((s) => s.label === 'Approval')) {
      const rawPolicy = String(ap.approvalPolicy ?? 'non_readonly');
      const mappedMode =
        rawPolicy === 'always' || rawPolicy === 'ask_all'
          ? 'ask_all'
          : rawPolicy === 'never' || rawPolicy === 'approve_all'
            ? 'approve_all'
            : 'non_readonly';
      out.push({
        key: `approve-${agentNode.id}`,
        label: 'Approval',
        accent: '#f59e0b',
        nodeId: agentNode.id,
        nodeType: 'human.approve',
        param: 'approvalPolicy',
        kind: 'approve-mode',
        value: mappedMode,
      });
    }
    if (!out.some((s) => s.label === 'Validator')) {
      out.push({
        key: `validator-${agentNode.id}`,
        label: 'Validator',
        accent: '#10b981',
        nodeId: agentNode.id,
        nodeType: 'goal.validator',
        param: 'validatorModel',
        kind: 'model-llm',
        value: String(ap.validatorModel ?? DEFAULT_LLM_MODEL),
      });
    }
  }

  const STAGE_ORDER: Record<string, number> = {
    'Input': 10,
    'Transcription': 20,
    'Speech Translation': 25,
    'Agent': 30,
    'LLM': 32,
    'Translate': 35,
    'Turn Detector': 40,
    'Decision': 45,
    'Approval': 50,
    'Validator': 55,
    'Exec/SSH': 60,
    'RAG': 70,
    'WebSearch': 72,
    'Crawler': 74,
    'MCP': 76,
    'Workflows': 78,
    'Output': 90,
    'TTS': 92,
  };

  return out.sort((a, b) => {
    const orderA = STAGE_ORDER[a.label] ?? 80;
    const orderB = STAGE_ORDER[b.label] ?? 80;
    if (orderA !== orderB) return orderA - orderB;
    const ra = rank.get(a.nodeId) ?? 999;
    const rb = rank.get(b.nodeId) ?? 999;
    if (ra !== rb) return ra - rb;
    return a.key.localeCompare(b.key);
  });
}

export interface StageInstance extends Stage {
  number: number;
  isDefault: boolean;
}

export interface StageGroup {
  key: string;
  label: string;
  accent: string;
  solution: string | null;
  instances: StageInstance[];
  defaultNodeId: string;
}

export function deriveStageGroups(flow: Flow): StageGroup[] {
  const stages = deriveStages(flow);
  const names = nodeDisplayNames(flow.nodes, flow.edges);
  const groupsMap = new Map<string, Stage[]>();
  for (const s of stages) {
    const arr = groupsMap.get(s.label) ?? [];
    arr.push(s);
    groupsMap.set(s.label, arr);
  }
  const out: StageGroup[] = [];
  for (const [label, list] of groupsMap) {
    const instances: StageInstance[] = list.map((s) => ({
      ...s,
      number: names.get(s.nodeId)?.number ?? 1,
      isDefault: Boolean(s.isDefault),
    }));
    const def = instances.find((i) => i.isDefault) ?? instances[0];
    out.push({
      key: `grp-${list[0].key}`,
      label,
      accent: list[0].accent,
      solution: solutionOfNodeType(list[0].nodeType),
      instances,
      defaultNodeId: def.nodeId,
    });
  }
  return out;
}

export function resolveDefaultNodeId(flow: Flow, nodeType: string): string | null {
  const matching = flow.nodes.filter((n) => n.enabled !== false && n.type === nodeType);
  if (matching.length === 0) return null;
  const def = matching.find((n) => n.params?.isDefault === true);
  return (def ?? matching[0]).id;
}

export function inferOutputLanguage(flow: Flow, outputNodeId: string): string {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, string[]>();
  for (const e of flow.edges) {
    const to = e.to.split('.')[0];
    const from = e.from.split('.')[0];
    const list = incoming.get(to) ?? [];
    list.push(from);
    incoming.set(to, list);
  }
  const seen = new Set<string>([outputNodeId]);
  const queue = [...(incoming.get(outputNodeId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    if ((n.type === 'translate.llm' || n.type === 'llm.omlx' || n.type === 'asr.lfm3') && typeof n.params?.targetLanguage === 'string') {
      const lang = n.params.targetLanguage.trim();
      if (lang && lang !== '-' && lang !== '—') return lang;
    }
    for (const prev of incoming.get(id) ?? []) {
      if (!seen.has(prev)) queue.push(prev);
    }
  }
  return 'Portuguese';
}

// sinks de legenda alimentados DIRETO pelo ASR (ou ASR → Traduzir → Exibir) = transcrição do entrevistador;
// os demais = sugestão do assistente (o que o dono lê pra falar).
export function classifySinks(flow: Flow): { transcription: Set<string>; suggestion: Set<string> } {
  const asrIds = new Set(flow.nodes.filter((n) => n.type.startsWith('asr')).map((n) => n.id));
  const translateIds = new Set(flow.nodes.filter((n) => n.type === 'translate.llm').map((n) => n.id));
  const directParent = new Map<string, string>();
  for (const e of flow.edges) {
    const toId = e.to.split('.')[0];
    if (!directParent.has(toId)) directParent.set(toId, e.from.split('.')[0]);
  }
  const transcription = new Set<string>();
  const suggestion = new Set<string>();
  for (const n of flow.nodes) {
    if (n.type !== 'sink.captions') continue;
    const src = directParent.get(n.id) ?? '';
    const srcParent = directParent.get(src) ?? '';
    if (asrIds.has(src) || (translateIds.has(src) && asrIds.has(srcParent))) {
      transcription.add(n.id);
    } else {
      suggestion.add(n.id);
    }
  }
  return { transcription, suggestion };
}

export function shortModel(id: string): string {
  if (!id) return '—';
  // path do cache HF: .../models--org--nome/snapshots/hash → org/nome (legível)
  const m = id.match(/models--([^/]+)/);
  if (m) return m[1].replace(/--/g, '/');
  const base = id.split('/').pop() ?? id;
  return base.replace(/^models--/, '').replace(/--/g, '/');
}

// ── Classificação de modelos por capacidade ──────────────────────────────────
// Prioriza o `model_type` retornado diretamente por `GET /v1/models` do omlx
// ("llm" | "vlm" | "decision" | "audio_stt" | "audio_tts" | "audio_sts" | "embedding" | "reranker")
// e usa o nome do modelo apenas quando o model_type não está presente ou para
// distinguir modelos multimodais de áudio (LFM3-Audio / silero-vad) que rodam na engine vlm/llm.
function norm(id: string): string {
  return id.replace(/--|[/_]/g, ' ').toLowerCase();
}

export function isVadModel(id: string): boolean {
  const s = norm(id);
  return /silero|vad\b|diar |sortformer/i.test(s);
}

// STT / ASR — reconhecimento de fala
export function isAsrModel(id: string, modelType?: string): boolean {
  if (modelType === 'audio_stt') return true;
  if (modelType && modelType !== 'vlm') return false;
  const s = norm(id);
  return /whisper|voxtral(?!.*tts)|nemotron.*(asr|speech|transcribe)|qwen.*(asr|forced.align)|parakeet|moonshine|canary|granite.*speech|distil.*whisper|mimo.*asr|phonon.*(asr|\d)|vibevoice|medasr|moss.*transcribe|ming.*asr|sov.*transcribe|lfm3.*audio|lfm2.?5.*audio|fluid.*speech|mega.*asr/i.test(s);
}

// TTS — síntese de voz
export function isTtsModel(id: string, modelType?: string): boolean {
  if (modelType === 'audio_tts') return true;
  if (modelType && modelType !== 'vlm') return false;
  const s = norm(id);
  return /kokoro|qwen.*tts|voxtral.*tts|fish.*audio.*drama|csm.1b|miso.*tts|\bdia\b.*1\.|outetts|spark.*tts|higgs.*audio|chatterbox|melo.*tts|moss.*tts|ming.*tts|ming.*omni.*tts|rumik|voxcpm|kugelaudio|lfm3.*audio|lfm2.?5.*audio|maya.*native|soprano|reverb.*tts|longcat.*audio|omnivoice|zonos|audio8.*tts/i.test(s);
}

// STS — speech-to-speech
export function isStsModel(id: string, modelType?: string): boolean {
  if (modelType === 'audio_sts') return true;
  if (modelType && modelType !== 'vlm') return false;
  const s = norm(id);
  return /lfm3.*audio|lfm2.?5.*audio|dialogue.*sidon|fastdialogue|haru.*4b|nemotronlabs.*voice|mimo.*audio|ming.*audio|mossformer|deepfilter|sam.*audio|re.*use/i.test(s);
}

// Decisão (System-1, d1, Laya): roteamento calibrado (/v1/systemone), NÃO gera texto via chat.
export function isDecisionModel(id: string, modelType?: string): boolean {
  if (modelType === 'decision') return true;
  if (modelType) return false;
  const s = norm(id);
  return /\bd1\b|\bd1 |\bd1-|laya/i.test(s);
}

// Modelo de CHAT / TEXTO / MoE / VLM (chat/completions). Exclui áudio/ASR/TTS/STS/decisão/VAD/embedding/reranker.
export function isTextModel(id: string, modelType?: string): boolean {
  if (modelType && modelType !== 'llm' && modelType !== 'vlm') return false;
  if (isVadModel(id)) return false;
  return !isAsrModel(id, modelType) && !isTtsModel(id, modelType) && !isStsModel(id, modelType) && !isDecisionModel(id, modelType);
}

// Remove/substitui modelo de LLM inválido (não-texto ou inexistente no /v1/models do omlx)
// antes de iniciar o run — garante que o payload enviado ao /api/run usa exatamente o ID do /v1/models.
export function sanitizeFlow(
  flow: Flow,
  models?: { omlx: string[]; cache: string[]; details?: { id: string; model_type: string }[] },
): Flow {
  const omlxList = models?.omlx ?? [];
  const typeById = new Map<string, string>((models?.details ?? []).map((d) => [d.id, d.model_type]));
  const chatModels = omlxList.filter((m) => isTextModel(m, typeById.get(m)));
  const decisionModels = omlxList.filter((m) => isDecisionModel(m, typeById.get(m)));
  const resolveId = (val: unknown, allowed: string[], fallback?: string): string | undefined => {
    if (typeof val !== 'string' || !val) return fallback;
    if (allowed.length === 0) return isTextModel(val) ? val : fallback;
    if (allowed.includes(val)) return val;
    const shortVal = shortModel(val);
    const match = allowed.find((m) => shortModel(m) === shortVal || m.endsWith(`--${val}`) || m.endsWith(`/${val}`));
    return match ?? fallback;
  };
  return {
    ...flow,
    nodes: flow.nodes.map((n) => {
      if (n.type === 'llm.omlx' || n.type === 'agent.tools' || n.type === 'goal.validator') {
        const cur = typeof n.params.model === 'string' ? n.params.model : undefined;
        if (chatModels.length > 0) {
          const resolved = resolveId(cur, chatModels, chatModels[0]);
          if (resolved && resolved !== cur) {
            return { ...n, params: { ...n.params, model: resolved } };
          }
        } else if (cur && !isTextModel(cur)) {
          const { model: _bad, ...rest } = n.params;
          return { ...n, params: rest };
        }
      }
      if ((n.type === 'decision.llm' || n.type === 'turn.detector') && decisionModels.length > 0) {
        const cur = typeof n.params.model === 'string' ? n.params.model : undefined;
        const allowed = n.type === 'decision.llm' ? [...decisionModels, ...chatModels] : decisionModels;
        const resolved = resolveId(cur, allowed, decisionModels[0]);
        if (resolved && resolved !== cur) {
          return { ...n, params: { ...n.params, model: resolved } };
        }
      }
      return n;
    }),
  };
}

// RAG legado: injeta pontos-chave dos documentos no system prompt apenas quando o nó
// llm.omlx não usa o retriever BM25 nativo (useContext: true) e não é um tradutor puro.
export function applyContext(flow: Flow, docs: ContextDoc[]): Flow {
  if (!docs.length) return flow;
  const points = docs.flatMap((d) => d.points.map((p) => `- ${p}`));
  if (!points.length) return flow;
  const ctx = `Contexto dos documentos carregados:\n${points.join('\n')}`;
  return {
    ...flow,
    nodes: flow.nodes.map((n) => {
      if (n.type !== 'llm.omlx') return n;
      if (n.params.useContext === true || n.params.useContext === false || n.params.targetLanguage) return n;
      return { ...n, params: { ...n.params, system: [ctx, n.params.system].filter(Boolean).join('\n\n') } };
    }),
  };
}