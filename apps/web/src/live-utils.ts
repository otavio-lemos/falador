// Deriva as ETAPAS do workflow (dropdowns por etapa da tela de execução) e
// classifica os sinks de legenda em transcrição (alimentado pelo ASR) vs sugestão.
import type { Flow, ContextDoc } from './api';
import { accentOf } from './data';

export interface Stage {
  key: string;
  label: string;
  accent: string;
  nodeId: string;
  param: string;
  kind: 'app' | 'model-asr' | 'model-llm' | 'gate' | 'voice' | 'language';
  value: string;
}

const ORDER = ['captura', 'asr', 'llm', 'gate', 'voz', 'idioma'];

export function deriveStages(flow: Flow): Stage[] {
  const out: Stage[] = [];
  for (const n of flow.nodes) {
    const p = n.params as Record<string, unknown>;
    if (n.type === 'capture.ffmpeg') {
      out.push({ key: 'captura', label: 'App da call', accent: accentOf(n.type), nodeId: n.id, param: 'input', kind: 'app', value: String(p.input ?? '') });
    } else if (n.type === 'asr.realtime' || n.type === 'asr.lfm3') {
      out.push({ key: 'asr', label: 'Transcrição', accent: accentOf(n.type), nodeId: n.id, param: 'model', kind: 'model-asr', value: String(p.model ?? '') });
    } else if (n.type === 'llm.omlx' || n.type === 'agent.tools') {
      out.push({ key: 'llm', label: n.type === 'agent.tools' ? 'Agente' : 'Sugestão / Tradução', accent: accentOf(n.type), nodeId: n.id, param: 'model', kind: 'model-llm', value: String(p.model ?? '') });
    } else if (n.type === 'decision.llm') {
      out.push({ key: 'gate', label: 'Revisão', accent: accentOf(n.type), nodeId: n.id, param: 'defaultOption', kind: 'gate', value: String(p.defaultOption ?? 'humano') });
    } else if (n.type === 'tts.sts') {
      out.push({ key: 'voz', label: 'Voz', accent: accentOf(n.type), nodeId: n.id, param: 'voice', kind: 'voice', value: String(p.voice ?? 'female') });
      out.push({ key: 'idioma', label: 'Idioma da fala', accent: accentOf(n.type), nodeId: n.id, param: 'language', kind: 'language', value: String(p.language ?? 'English') });
    }
  }
  return out.sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
}

// sinks de legenda alimentados DIRETO pelo ASR = transcrição do entrevistador;
// os demais = sugestão do assistente (o que o dono lê pra falar).
export function classifySinks(flow: Flow): { transcription: Set<string>; suggestion: Set<string> } {
  const asrIds = new Set(flow.nodes.filter((n) => n.type.startsWith('asr')).map((n) => n.id));
  const transcription = new Set<string>();
  const suggestion = new Set<string>();
  for (const n of flow.nodes) {
    if (n.type !== 'sink.captions') continue;
    const edge = flow.edges.find((e) => e.to.split('.')[0] === n.id);
    const src = edge ? edge.from.split('.')[0] : '';
    if (asrIds.has(src)) transcription.add(n.id);
    else suggestion.add(n.id);
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