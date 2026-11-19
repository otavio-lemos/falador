// Registro local de modelos (ADR-004): dropdown no nó + badge RECOMENDADO + "?" → GitHub.
// Fonte dos fatos: AGENTS.md §2/§4 (verificados na máquina). extra.recommended = verdadeiro só onde medido.
export interface RegistryModel {
  id: string;
  url: string; // HF repo id
  kind: 'asr' | 'tts' | 'llm';
  param: string; // nome do param do nó que recebe o valor
  recommended: boolean;
  notes: string;
}

export const MODEL_REGISTRY: RegistryModel[] = [
  {
    id: 'LFM3-Audio-2B-MLX-8bit',
    url: 'https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-8bit',
    kind: 'tts',
    param: 'text',
    recommended: true,
    notes: 'TTS EN 4,55× / PT 5,32× realtime (medido). ASR offline + tradução chat+audio tipado.',
  },
  {
    id: 'Voxtral-Mini-4B-Realtime-4bit',
    url: 'https://huggingface.co/mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit',
    kind: 'asr',
    param: 'model',
    recommended: true,
    notes: 'Único streaming ASR rodando (WS /v1/realtime). Não traduz — mais um nó de tradução.',
  },
  {
    id: 'LFM3-1.7B-MLX-4bit',
    url: 'https://huggingface.co/LiquidAI/LFM3-1.7B-MLX-4bit',
    kind: 'llm',
    param: 'model',
    recommended: true,
    notes: 'PT oficial entre 16 idiomas. TTFT 30-60ms warm. enable_thinking:false OBRIGATÓRIO.',
  },
];

export function modelsFor(kind: RegistryModel['kind']): RegistryModel[] {
  return MODEL_REGISTRY.filter((m) => m.kind === kind);
}
