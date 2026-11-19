// falador-nodes — ponto de entrada: registro dos nós reais
import type { Registry } from '../../falador-graph/src/index.ts';
import { llmOmlx } from './llm-omlx.ts';
import { ttsSts } from './tts-sts.ts';
import { asrRealtime, LFM3_AUDIO_SNAPSHOT } from './asr-realtime.ts';
import { captureFfmpeg } from './capture-ffmpeg.ts';
import { sinkCaptions, sinkPlayback } from './sinks.ts';
import { humanApprove } from './human-approve.ts';
import { decisionLlm } from './decision-llm.ts';

export { llmOmlx } from './llm-omlx.ts';
export { ttsSts, type AudioChunkPayload } from './tts-sts.ts';
export { asrRealtime, LFM3_AUDIO_SNAPSHOT, VOXTRAL_SNAPSHOT } from './asr-realtime.ts';
export { captureFfmpeg } from './capture-ffmpeg.ts';
export { sinkCaptions, sinkPlayback } from './sinks.ts';
export { humanApprove, type GateHolder } from './human-approve.ts';
export { decisionLlm } from './decision-llm.ts';
export { postJsonBytes, postSse, payloadText } from './sse.ts';

/** Registra todos os nós reais no registry dado. */
export function registerFaladorNodes(registry: Registry): Registry {
  return registry.register(llmOmlx).register(ttsSts).register(asrRealtime).register(captureFfmpeg).register(sinkCaptions).register(sinkPlayback).register(humanApprove).register(decisionLlm);
}
