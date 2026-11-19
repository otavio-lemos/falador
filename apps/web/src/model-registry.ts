// Registro local de modelos (ADR-004): dropdown no nó + badge ★ RECOMENDADO (medido na máquina)
// + "(NÃO VERIFICADO)" quando existe mas não rodamos aqui + "?" → GitHub/HF.
// Fontes: AGENTS.md §2/§4 (medidos), ~/.cache/huggingface/hub (local, 2026-11-19), HF (checado 2026-11-19).
export interface RegistryModel {
  id: string;
  value: string; // o que vai no param do nó (omlx id, snapshot path ou caminho HF)
  url: string; // página HF/GitHub p/ o botão "?"
  kind: 'asr' | 'tts' | 'llm' | 'decision';
  param: string; // nome do param do nó que recebe `value`
  recommended: boolean; // só verdadeiro onde MEDIDO (AGENTS.md §4)
  verified: boolean; // rodou na nossa máquina? false = NÃO VERIFICADO
  local: 'sim' | 'não' | 'omlx'; // sim = cache local · omlx = registrado no servidor agora
  notes: string;
}

const HF = (repo: string) => `https://huggingface.co/${repo}`;
const LFM3_AUDIO_SNAPSHOT = '/Users/otaviolemos/.cache/huggingface/hub/models--LiquidAI--LFM3-Audio-2B-MLX-8bit/snapshots/000ea4f93adbfdabd4b24295b5e838f6a1f0ffa8';
const VOXTRAL_SNAPSHOT = '/Users/otaviolemos/.cache/huggingface/hub/models--mlx-community--Voxtral-Mini-4B-Realtime-2602-4bit/snapshots/fdebf7b2af834a1db4b8a3c99ab7480b333adf9e';

export const MODEL_REGISTRY: RegistryModel[] = [
  // ─── ASR (streaming, WS /v1/realtime) ───
  {
    id: 'Voxtral-Mini-4B-Realtime-2602-4bit',
    value: VOXTRAL_SNAPSHOT,
    url: HF('mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit'),
    kind: 'asr', param: 'model',
    recommended: true, verified: true, local: 'sim',
    notes: 'Único ASR streaming RODANDO (RTF 0,05 medido é do LFM3-Audio offline; Voxtral: 1º delta ~1,1 s). Server :8090 residente com este modelo.',
  },
  {
    id: 'Voxtral-Mini-4B-Realtime-2602-fp16',
    value: 'mlx-community/Voxtral-Mini-4B-Realtime-2602-fp16',
    url: HF('mlx-community/Voxtral-Mini-4B-Realtime-2602-fp16'),
    kind: 'asr', param: 'model',
    recommended: false, verified: false, local: 'não',
    notes: 'Mesmo modelo em fp16 (precisa baixar). NÃO VERIFICADO no nosso pipeline WS.',
  },
  // ─── TTS (sidecar :8091 — modelo residente, trocar exige reiniciar o sidecar) ───
  {
    id: 'LFM3-Audio-2B-MLX-8bit',
    value: LFM3_AUDIO_SNAPSHOT,
    url: HF('LiquidAI/LFM3-Audio-2B-MLX-8bit'),
    kind: 'tts', param: '(sidecar)',
    recommended: true, verified: true, local: 'sim',
    notes: 'Sidecar :8091. TTS EN 4,55× / PT 5,32× rt (medido). + /asr-translate (tradução nativa ~15× rt).',
  },
  {
    id: 'LFM3-Audio-2B-MLX-4bit',
    value: 'LiquidAI/LFM3-Audio-2B-MLX-4bit',
    url: HF('LiquidAI/LFM3-Audio-2B-MLX-4bit'),
    kind: 'tts', param: '(sidecar)',
    recommended: false, verified: false, local: 'não',
    notes: 'OFICIAL LiquidAI, quant 4bit (menos RAM). NÃO VERIFICADO — download do dono (ADR-004).',
  },
  // ─── LLM texto (omlx :8080) ───
  {
    id: 'LFM3-1.7B-MLX-4bit',
    value: 'LiquidAI--LFM3-1.7B-MLX-4bit',
    url: HF('LiquidAI/LFM3-1.7B-MLX-4bit'),
    kind: 'llm', param: 'model',
    recommended: true, verified: true, local: 'sim',
    notes: 'PT oficial entre 16 idiomas. TTFT 30–60 ms warm (medido). enable_thinking:false OBRIGATÓRIO. Residente no omlx.',
  },
  {
    id: 'Qwen3.8-27B-4bit',
    value: 'mlx-community--Qwen3.8-27B-4bit',
    url: HF('mlx-community/Qwen3.8-27B-4bit'),
    kind: 'llm', param: 'model',
    recommended: false, verified: false, local: 'sim',
    notes: 'CACHE LOCAL, bem maior que o 1.7B (qualidade q/ custo). NÃO VERIFICADO no omlx local — conferir id em :8080/v1/models.',
  },
  {
    id: 'Qwen3.6-35B-A3B-4bit',
    value: 'mlx-community--Qwen3.6-35B-A3B-4bit',
    url: HF('mlx-community/Qwen3.6-35B-A3B-4bit'),
    kind: 'llm', param: 'model',
    recommended: false, verified: false, local: 'sim',
    notes: 'CACHE LOCAL (MoE A3B — ativa 3B). NÃO VERIFICADO. Boa candidata p/ assistente do Cenário 2.',
  },
  {
    id: 'Qwen3.5-9B-4bit',
    value: 'mlx-community--Qwen3.5-9B-4bit',
    url: HF('mlx-community/Qwen3.5-9B-4bit'),
    kind: 'llm', param: 'model',
    recommended: false, verified: false, local: 'sim',
    notes: 'CACHE LOCAL. NÃO VERIFICADO. Meio-termo 9B.',
  },
  {
    id: 'DeepSeek-V4.1-Flash-1017 (OsaurusAI)',
    value: 'OsaurusAI--DeepSeek-V4.1-Flash-1017-JANGHT1.4',
    url: HF('OsaurusAI/DeepSeek-V4.1-Flash-1017-JANGHT1.4'),
    kind: 'llm', param: 'model',
    recommended: false, verified: false, local: 'sim',
    notes: 'CACHE LOCAL (OsaurusAI, JANG quant). NÃO VERIFICADO.',
  },
  // ─── DECISÃO (decision.llm / alternatives) ───
  {
    id: 'd1-2B (decisão — texto/vídeo)',
    value: 'LiquidAI--d1-2B',
    url: HF('LiquidAI/d1-2B'),
    kind: 'decision', param: 'model',
    recommended: false, verified: false, local: 'não',
    notes: 'DECISÃO OFICIAL LiquidAI (calibrada, 1 forward pass). omlx 0.8.0 (o NOSSO, latest) já serve d1. Substituta direta do decision.llm zero-shot. Precisa baixar + conferir id. NÃO VERIFICADO.',
  },
  {
    id: 'd1-Omni-2B (decisão — +áudio)',
    value: 'LiquidAI--d1-Omni-2B',
    url: HF('LiquidAI/d1-Omni-2B-GGUF'),
    kind: 'decision', param: 'model',
    recommended: false, verified: false, local: 'não',
    notes: 'd1 com input de ÁUDIO (rotear fala sem transcrever). omlx 0.8.0 serve d1-Omni. NÃO VERIFICADO. Precisa baixar (download do dono).',
  },
  {
    id: 'Laya (Convai — decisão)',
    value: 'convaiinnovations/laya',
    url: HF('convaiinnovations/laya'),
    kind: 'decision', param: 'model',
    recommended: false, verified: false, local: 'não',
    notes: 'Apache-2.0 ~0,3-0,4B. Precisa sidecar Python próprio + FINE-TUNING (zero-shot erra). Provavelmente suplantada pelo d1-2B oficial (sem treinamento).',
  },
];

export function modelsFor(kind: RegistryModel['kind']): RegistryModel[] {
  return MODEL_REGISTRY.filter((m) => m.kind === kind);
}
