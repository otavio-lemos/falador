// Deriva as ETAPAS do workflow (dropdowns por etapa da tela de execução) e
// classifica os sinks de legenda em transcrição (alimentado pelo ASR) vs sugestão.
import type { Flow } from './api';
import { accentOf } from './data';

export interface Stage {
  key: string;
  label: string;
  accent: string;
  nodeId: string;
  param: string;
  kind: 'app' | 'model-asr' | 'model-llm' | 'gate' | 'voice';
  value: string;
}

const ORDER = ['captura', 'asr', 'llm', 'gate', 'voz'];

export function deriveStages(flow: Flow): Stage[] {
  const out: Stage[] = [];
  for (const n of flow.nodes) {
    const p = n.params as Record<string, unknown>;
    if (n.type === 'capture.ffmpeg') {
      out.push({ key: 'captura', label: 'Captura', accent: accentOf(n.type), nodeId: n.id, param: 'input', kind: 'app', value: String(p.input ?? '') });
    } else if (n.type === 'asr.realtime' || n.type === 'asr.lfm3') {
      out.push({ key: 'asr', label: n.type === 'asr.realtime' ? 'ASR (Voxtral)' : 'ASR (LFM3)', accent: accentOf(n.type), nodeId: n.id, param: 'model', kind: 'model-asr', value: String(p.model ?? '') });
    } else if (n.type === 'llm.omlx') {
      out.push({ key: 'llm', label: 'LLM (Sugestão)', accent: accentOf(n.type), nodeId: n.id, param: 'model', kind: 'model-llm', value: String(p.model ?? '') });
    } else if (n.type === 'decision.llm') {
      out.push({ key: 'gate', label: 'Gate', accent: accentOf(n.type), nodeId: n.id, param: 'defaultOption', kind: 'gate', value: String(p.defaultOption ?? 'humano') });
    } else if (n.type === 'tts.sts') {
      out.push({ key: 'voz', label: 'Voz (TTS)', accent: accentOf(n.type), nodeId: n.id, param: 'voice', kind: 'voice', value: String(p.voice ?? 'female') });
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
  const base = id.split('/').pop() ?? id;
  return base.replace(/^models--/, '').replace(/--/g, '/');
}