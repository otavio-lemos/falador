// Deriva as ETAPAS do workflow (dropdowns por etapa da tela de execução) e
// classifica os sinks de legenda em transcrição (alimentado pelo ASR) vs sugestão.
import type { Flow, ContextDoc } from './api';
import { accentOf } from './data';

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
    | 'voice';
  value: string;
  options?: string[];
  secondaryParam?: string;
  secondaryKind?: 'language-optional' | 'language-required';
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

function topoRank(flow: Flow): Map<string, number> {
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

export function deriveStages(flow: Flow): Stage[] {
  const rank = topoRank(flow);
  const out: Stage[] = [];
  for (const n of flow.nodes) {
    if (n.enabled === false) continue;
    const p = n.params as Record<string, unknown>;
    if (n.type === 'capture.ffmpeg') {
      const backend = String(p.backend ?? 'sck');
      out.push({
        key: `captura-${n.id}`,
        label: 'Captura',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'backend',
        kind: 'app',
        value: backend === 'sounddevice' ? 'mic' : 'apps',
        secondaryParam: 'input',
        secondaryValue: String(p.input ?? ''),
        secondaryLabel: 'Origem',
      });
    } else if (n.type === 'asr.realtime') {
      out.push({
        key: `asr-${n.id}`,
        label: 'Transcrição',
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
        label: 'ASR+Trad.',
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
        label: 'Traduzir',
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
          label: 'Traduzir',
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
          label: 'Assistente',
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
        label: 'Agente',
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
        label: 'Turno',
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
        label: 'Decisão',
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
        label: 'Aprovação',
        accent: accentOf(n.type),
        nodeId: n.id,
        nodeType: n.type,
        param: 'mode',
        kind: 'approve-mode',
        value: String(p.mode ?? 'manual'),
      });
    } else if (n.type === 'tts.sts') {
      out.push({
        key: `voz-${n.id}`,
        label: 'Voz TTS',
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
  return out.sort((a, b) => {
    const ra = rank.get(a.nodeId) ?? 999;
    const rb = rank.get(b.nodeId) ?? 999;
    if (ra !== rb) return ra - rb;
    return a.key.localeCompare(b.key);
  });
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
// Baseado nos modelos suportados pelo mlx-audio (https://github.com/Neywa-Labs/mlx-audio)
// e pelos modelos servidos pelo omlx.
//
// IDs podem ter formato "org--nome-do-modelo" (omlx) ou "org/nome" (HF cache).
// Normalizamos para comparação: -- e / viram espaço, lowercase.
function norm(id: string): string {
  return id.replace(/--|[/_]/g, ' ').toLowerCase();
}

// STT / ASR — reconhecimento de fala
export function isAsrModel(id: string): boolean {
  const s = norm(id);
  return /whisper|voxtral(?!.*tts)|nemotron.*(asr|speech|transcribe)|qwen.*(asr|forced.align)|parakeet|moonshine|canary|granite.*speech|distil.*whisper|mimo.*asr|phonon.*(asr|\d)|vibevoice|medasr|moss.*transcribe|ming.*asr|sov.*transcribe|lfm3.*audio|lfm2.?5.*audio|fluid.*speech|mega.*asr/i.test(s);
}

// TTS — síntese de voz
export function isTtsModel(id: string): boolean {
  const s = norm(id);
  return /kokoro|qwen.*tts|voxtral.*tts|fish.*audio.*drama|csm.1b|miso.*tts|\bdia\b.*1\.|outetts|spark.*tts|higgs.*audio|chatterbox|melo.*tts|moss.*tts|ming.*tts|ming.*omni.*tts|rumik|voxcpm|kugelaudio|lfm3.*audio|lfm2.?5.*audio|maya.*native|soprano|reverb.*tts|longcat.*audio|omnivoice|zonos|audio8.*tts/i.test(s);
}

// STS — speech-to-speech
export function isStsModel(id: string): boolean {
  const s = norm(id);
  return /lfm3.*audio|lfm2.?5.*audio|dialogue.*sidon|fastdialogue|haru.*4b|nemotronlabs.*voice|mimo.*audio|ming.*audio|mossformer|deepfilter|sam.*audio|re.*use/i.test(s);
}

// Decisão (System-1, d1, Laya): roteamento calibrado, NÃO gera texto via chat.
export function isDecisionModel(id: string): boolean {
  const s = norm(id);
  return /\bd1\b|\bd1 |\bd1-|laya/i.test(s);
}

// Modelo de TEXTO puro (chat/completions). Exclui áudio/ASR/TTS/STS/decisão/VAD.
export function isTextModel(id: string): boolean {
  const s = norm(id);
  return !isAsrModel(id) && !isTtsModel(id) && !isStsModel(id) && !isDecisionModel(id)
    && !/silero|vad |diar |sortformer|mossformer|deepfilter|sam audio/i.test(s);
}

// Remove modelo de LLM inválido (não-texto) pra o nó usar o default de texto —
// evita run silenciosamente quebrado quando um d1/áudio foi parar no assistente.
export function sanitizeFlow(flow: Flow): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => {
      if ((n.type === 'llm.omlx' || n.type === 'agent.tools') && typeof n.params.model === 'string' && !isTextModel(n.params.model)) {
        const { model: _bad, ...rest } = n.params;
        return { ...n, params: rest };
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