// falador-nodes — ponto de entrada: registro dos nós reais
import type { Registry } from '../../falador-graph/src/index.ts';
import { llmOmlx } from './llm-omlx.ts';
import { translateLlm } from './translate-llm.ts';
import { ttsSts } from './tts-sts.ts';
import { asrRealtime, LFM3_AUDIO_SNAPSHOT } from './asr-realtime.ts';
import { asrLfm3 } from './asr-lfm3.ts';
import { captureFfmpeg } from './capture-ffmpeg.ts';
import { sinkCaptions, sinkPlayback } from './sinks.ts';
import { humanApprove } from './human-approve.ts';
import { decisionLlm } from './decision-llm.ts';
import { turnDetector } from './turn-detector.ts';
import { execCommand } from './exec-command.ts';
import { agentTools } from './agent-tools.ts';
import { ragSearch } from './rag-search.ts';
import { toolMcp } from './tool-mcp.ts';
import { inputChat } from './input-chat.ts';
import { toolWorkflow } from './tool-workflow.ts';
import { toolWebSearch } from './tool-web-search.ts';
import { toolCrawler } from './tool-crawler.ts';
import { goalValidator } from './goal-validator.ts';

export { llmOmlx, type ContextProvider } from './llm-omlx.ts';
export { translateLlm } from './translate-llm.ts';
export { ttsSts, type AudioChunkPayload } from './tts-sts.ts';
export { asrRealtime, LFM3_AUDIO_SNAPSHOT, VOXTRAL_SNAPSHOT } from './asr-realtime.ts';
export { asrLfm3 } from './asr-lfm3.ts';
export { captureFfmpeg } from './capture-ffmpeg.ts';
export { sinkCaptions, sinkPlayback } from './sinks.ts';
export { humanApprove, type GateHolder, type GateMeta } from './human-approve.ts';
export { decisionLlm } from './decision-llm.ts';
export { turnDetector } from './turn-detector.ts';
export {
  execCommand,
  DEFAULT_READONLY_PREFIXES,
  INTERACTIVE_DENY_BINARIES,
  parseArgv,
  extractCommand,
  validateCommand,
  type ExecPolicy,
  type ExtractResult,
  type ValidateResult,
  type AuditEntry,
} from './exec-command.ts';
export {
  chunkDocument,
  searchChunks,
  formatContextBlock,
  tokenize,
  type ContextChunk,
  type ContextDocument,
  type ChunkOptions,
  type SearchOptions,
} from './context-store.ts';
export {
  agentTools,
  type ApprovalPolicy,
  type AgentGateMeta,
  type AgentGateHolder,
  type AgentStepEvent,
} from './agent-tools.ts';
export { ragSearch } from './rag-search.ts';
export { toolMcp, validateMcpCommand, validateMcpUrl, buildFilteredEnv } from './tool-mcp.ts';
export { inputChat, type ChatSendFn } from './input-chat.ts';
export {
  toolWorkflow,
  sanitizeFlowName,
  resolveSafeFlowPath,
  type WorkflowAuditEntry,
} from './tool-workflow.ts';
export { toolWebSearch, validateExternalUrl, type FetcherFn } from './tool-web-search.ts';
export {
  toolCrawler,
  extractPageData,
  isDomainAllowed,
  type ExtractedPageData,
} from './tool-crawler.ts';
export { inheritTrace, type TraceMeta } from './trace.ts';
export { goalValidator, validateGoal, type GoalValidation } from './goal-validator.ts';
export {
  GENESIS_HASH,
  canonicalJson,
  computeAuditHash,
  chainAuditEvent,
  verifyAuditChain,
  parsePlanItems,
  preview,
  type AuditChainVerification,
  type AuditEvent,
  type PlanItem,
  type GoalValidationResult,
} from './audit.ts';
export { redactSecrets, redactUnknown, createLineRedactor, type RedactResult, type LineRedactor } from './redact.ts';
export { postJsonBytes, postSse, payloadText, omlxAuthHeaders } from './sse.ts';

/** Registra todos os nós reais no registry dado. */
export function registerFaladorNodes(registry: Registry): Registry {
  return registry
    .register(llmOmlx)
    .register(translateLlm)
    .register(ttsSts)
    .register(asrRealtime)
    .register(asrLfm3)
    .register(captureFfmpeg)
    .register(sinkCaptions)
    .register(sinkPlayback)
    .register(humanApprove)
    .register(decisionLlm)
    .register(turnDetector)
    .register(execCommand)
    .register(agentTools)
    .register(ragSearch)
    .register(toolMcp)
    .register(inputChat)
    .register(toolWorkflow)
    .register(toolWebSearch)
    .register(toolCrawler)
    .register(goalValidator);
}
