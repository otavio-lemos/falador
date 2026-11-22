// Tela de EXECUÇÃO — LIVE MODE + latência com breakdown + DRY-RUN/EXEC ATIVO + Limpar contexto +
// Exportar sessão (.md / webhook) + card rico de aprovação (comandos/host/risco d1) +
// sidebar de Documentos/Runbooks (RAG BM25 com tags e chunks).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  AccordionItem,
  Button,
  Dropdown,
  Modal,
  Tag,
  TextArea,
  TextInput,
} from '@carbon/react';
import {
  Pause,
  Play,
  Stop,
  Renew,
  Edit,
  Checkmark,
  Close,
  Document,
  Add,
  TrashCan,
  Download,
  Reset,
  Terminal,
  Chip,
  Meter,
  Time,
  Sun,
  Moon,
  Microphone,
  MicrophoneOff,
  VolumeUp,
  VolumeMute,
} from '@carbon/icons-react';
import type { Runner, Gate, AgentStep, Caption } from '../useRunner';
import { exportSession, type Flow, type ContextDoc, type ServiceStatusMap } from '../api';
import {
  deriveStages,
  classifySinks,
  shortModel,
  supportedLanguagesForModel,
  isTextModel,
  isAsrModel,
  isDecisionModel,
  DEFAULT_LLM_MODEL,
  DEFAULT_DECISION_MODEL,
  type Stage,
} from '../live-utils';
import { WorkflowMiniMap } from '../components/WorkflowMiniMap';
import { LogsPanel } from '../components/LogsPanel';
import { shortNodeName } from '../data';

const WEBHOOK_STORAGE_KEY = 'falador.webhookUrl';
const THOUGHTS_STORAGE_KEY = 'falador.showThoughts';

interface Props {
  runner: Runner;
  flow: Flow;
  scenarioName: string;
  theme: 'g100' | 'white';
  onToggleTheme: () => void;
  micMuted: boolean;
  speakerMuted: boolean;
  onToggleMicMute: () => void;
  onToggleSpeakerMute: () => void;
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  contextDocs: ContextDoc[];
  onUploadDoc: (file: File, tags?: string[]) => void;
  onRemoveDoc: (name: string) => void;
  onStart: (flow: Flow) => void;
  flows: { name: string; description: string }[];
  currentFlow: string;
  onSwitchFlow: (name: string) => void;
  onUpdateStage: (nodeId: string, param: string, value: unknown) => void;
  onRegenerate: () => void;
  onRefreshApps: () => void;
  onServiceStatus?: (status: ServiceStatusMap) => void;
  onNotify?: (msg: string) => void;
  onGoBuilder: () => void;
  onExit: () => void;
  onReset: () => void;
  resetSignal: number;
}

interface Item { id: string; label: string }

interface ConversationEntry {
  id: string;
  kind: 'user' | 'stt' | 'agent' | 'audio' | 'thought';
  nodeId: string;
  title: string;
  subtitle: string;
  text: string;
  ts: number;
  live?: boolean;
}

function stageItems(stage: Stage, models: { omlx: string[]; cache: string[] }, apps: string[]): Item[] {
  if (stage.kind === 'approve-mode') {
    return [{ id: 'manual', label: 'Manual' }, { id: 'auto', label: 'Auto (bypass)' }];
  }
  if (stage.kind === 'voice') return [{ id: 'female', label: 'Feminino' }, { id: 'male', label: 'Masculino' }];
  if (stage.kind === 'app') {
    const items: Item[] = [{ id: 'auto', label: 'Automático (áudio ativo)' }];
    for (const a of apps) {
      if (a && !items.some((i) => i.id === a)) items.push({ id: a, label: a });
    }
    if (stage.value && stage.value !== 'auto' && !/^:\d+$/.test(stage.value) && !items.some((i) => i.id === stage.value)) {
      items.push({ id: stage.value, label: stage.value });
    }
    return items;
  }
  let vals: string[] = [];
  if (stage.kind === 'model-asr') {
    // asr.realtime só aceita modelos streaming (voxtral / nemotron_asr); evita IDs omlx com -- ou LFM3-Audio não-streaming
    vals = models.cache.filter((m) => isAsrModel(m) && /voxtral|nemotron.*asr/i.test(m));
  } else if (stage.kind === 'model-asr-lfm3') {
    const combined = [...models.omlx, ...models.cache.filter((m) => !models.omlx.includes(m))];
    vals = combined.filter((m) => /lfm.*audio/i.test(m));
    if (vals.length === 0) vals = ['LiquidAI--LFM3-Audio-2B-MLX-8bit'];
  } else if (stage.kind === 'model-llm' || stage.kind === 'model-translate') {
    vals = models.omlx.filter(isTextModel);
    if (vals.length === 0 && stage.kind === 'model-llm') vals = [DEFAULT_LLM_MODEL];
  } else if (stage.kind === 'model-decision') {
    const dec = models.omlx.filter(isDecisionModel);
    vals = stage.nodeType === 'decision.llm' ? [...dec, ...models.omlx.filter(isTextModel)] : dec;
    if (vals.length === 0) vals = [DEFAULT_DECISION_MODEL];
  }

  const seenLabels = new Set<string>();
  const items: Item[] = [];
  for (const v of vals.filter(Boolean)) {
    const label = shortModel(v);
    if (!seenLabels.has(label)) {
      seenLabels.add(label);
      items.push({ id: v, label });
    }
  }

  const isDisabledVal = !stage.value || stage.value === '-' || stage.value === '—';
  const validCurrent = !isDisabledVal && (
    stage.kind === 'model-asr' ||
    stage.kind === 'model-asr-lfm3' ||
    ((stage.kind === 'model-llm' || stage.kind === 'model-translate') && isTextModel(stage.value)) ||
    (stage.kind === 'model-decision' && (isDecisionModel(stage.value) || (stage.nodeType === 'decision.llm' && isTextModel(stage.value))))
  );
  if (validCurrent && !items.some((i) => i.id === stage.value)) {
    const label = shortModel(stage.value);
    const filtered = items.filter((i) => i.label !== label);
    filtered.unshift({ id: stage.value, label });
    if (stage.kind === 'model-translate') {
      return [{ id: '-', label: '— (desabilitado)' }, ...filtered];
    }
    return filtered;
  }
  if (stage.kind === 'model-translate') {
    if (items.length === 0) items.push({ id: DEFAULT_LLM_MODEL, label: shortModel(DEFAULT_LLM_MODEL) });
    return [{ id: '-', label: '— (desabilitado)' }, ...items];
  }
  return items.length ? items : [{ id: stage.value || '—', label: stage.value || '—' }];
}

function parseGateCommand(gate: Gate | undefined): {
  isCommand: boolean;
  tool?: string;
  host: string;
  command: string;
  decision?: string;
  reason?: string;
} {
  if (!gate) return { isCommand: false, host: 'local', command: '' };
  const meta = gate.meta;
  let tool = meta?.tool;
  let host = meta?.host;
  let command = meta?.command;
  let decision = meta?.decision;
  let reason = meta?.reason;

  if (!command || !tool) {
    try {
      const trimmed = gate.text.trim();
      const candidate = trimmed.startsWith('{')
        ? trimmed
        : (trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? '');
      if (candidate.startsWith('{')) {
        const obj = JSON.parse(candidate) as Record<string, unknown>;
        if (typeof obj.tool === 'string' && !tool) tool = obj.tool;
        if (typeof obj.command === 'string' && !command) command = obj.command;
        if (typeof obj.host === 'string' && !host) host = obj.host;
        if (typeof obj.reason === 'string' && !reason) reason = obj.reason;
        if (typeof obj.decision === 'string' && !decision) decision = obj.decision;
      }
    } catch { /* não é JSON */ }
  }

  const isCommand = Boolean(command || tool || meta?.host || meta?.command || meta?.reason || meta?.tool);
  return {
    isCommand,
    tool,
    host: host || 'local',
    command: command ?? gate.text,
    decision,
    reason,
  };
}

function agentStepStatus(s: AgentStep): { label: string; tagType: 'blue' | 'green' | 'red' | 'magenta' | 'cyan' | 'warm-gray' } {
  if (s.phase === 'calling') return { label: 'chamando', tagType: 'blue' };
  if (s.phase === 'rejected') return { label: 'rejeitado', tagType: 'magenta' };
  if (s.phase === 'repeated') return { label: 'repetido', tagType: 'warm-gray' };
  if (s.dryRun) return { label: 'dry-run', tagType: 'cyan' };
  if (s.ok === false) return { label: 'erro', tagType: 'red' };
  return { label: 'ok', tagType: 'green' };
}

function riskTagType(decision?: string): 'green' | 'warm-gray' | 'red' | 'magenta' | 'purple' {
  if (!decision) return 'purple';
  const d = decision.toLowerCase();
  if (d.includes('segur') || d === 'auto') return 'green';
  if (d.includes('sensiv') || d === 'humano') return 'magenta';
  if (d.includes('bloq')) return 'red';
  return 'purple';
}

export function LiveView({
  runner, flow, scenarioName, theme, onToggleTheme,
  micMuted, speakerMuted, onToggleMicMute, onToggleSpeakerMute,
  models, apps, contextDocs,
  onUploadDoc, onRemoveDoc, onStart, flows, currentFlow,
  onSwitchFlow, onUpdateStage, onRegenerate, onRefreshApps, onServiceStatus, onNotify,  onGoBuilder, onExit, onReset, resetSignal,
}: Props) {
  const stages = useMemo(() => deriveStages(flow), [flow]);
  const sinks = useMemo(() => classifySinks(flow), [flow]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [cmdDraft, setCmdDraft] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [showThoughts, setShowThoughts] = useState(() => {
    try { return localStorage.getItem(THOUGHTS_STORAGE_KEY) === 'true'; } catch { return false; }
  });
  const [docsOpen, setDocsOpen] = useState(false);
  const [uploadTags, setUploadTags] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState(() => {
    try { return localStorage.getItem(WEBHOOK_STORAGE_KEY) ?? ''; } catch { return ''; }
  });
  const fileRef = useRef<HTMLInputElement>(null);

  const lastOf = (set: Set<string>) => [...runner.captions].reverse().find((c) => set.has(c.nodeId));
  const transcription = lastOf(sinks.transcription)?.text ?? '';
  const gate = runner.gates[0];
  const gateInfo = useMemo(() => parseGateCommand(gate), [gate]);

  // Sincroniza rascunho editável do comando sempre que chegar um novo gate de comando
  useEffect(() => {
    if (gate && gateInfo.isCommand) {
      setCmdDraft(gateInfo.command);
    }
  }, [gate, gateInfo.isCommand, gateInfo.command]);

  const suggestion = gate ? gate.text : (lastOf(sinks.suggestion)?.text ?? '');

  // NADA FIXO: painéis e indicadores derivam dos nós presentes no workflow.
  const hasGate = flow.nodes.some(
    (n) => n.type === 'human.approve' || (n.type === 'agent.tools' && n.params.approvalPolicy !== 'never'),
  );
  const hasCapture = flow.nodes.some((n) => n.type === 'capture.ffmpeg');
  const hasAudioOut = flow.nodes.some((n) => n.type === 'sink.playback' || n.type === 'tts.sts');
  const hasTTS = flow.nodes.some((n) => n.type === 'tts.sts');
  const hasLLM = flow.nodes.some((n) => n.type === 'llm.omlx' || n.type === 'agent.tools');
  const execNodes = flow.nodes.filter((n) => n.type === 'exec.command' || n.type === 'tool.mcp');
  const hasExec = execNodes.length > 0;
  const execActive = execNodes.some((n) => n.params.dryRun === false);
  const hasAgent = flow.nodes.some((n) => n.type === 'agent.tools');
  const isAssisted = flow.nodes.some(
    (n) => n.type === 'decision.llm' || n.type === 'human.approve' || n.type === 'exec.command' || n.type === 'agent.tools',
  );
  const isInterview = flow.nodes.some((n) => (n.type === 'decision.llm' || n.type === 'human.approve')) && !hasExec && !hasAgent;
  const allSinks = new Set([...sinks.transcription, ...sinks.suggestion]);

  const heroText = isAssisted ? (gate ? gate.text : (lastOf(sinks.suggestion)?.text ?? '')) : (lastOf(allSinks)?.text ?? '');
  const heroLabel = hasExec || hasAgent
    ? 'Diagnóstico / Comando sugerido'
    : isInterview
      ? 'Sugestão de resposta (para você falar)'
      : 'Tradução ao vivo';

  const lastError = [...runner.events].reverse().find((e) => {
    if (e.type === 'flow_invalid') return true;
    if (e.type !== 'node_error') return false;
    const code = String((e as { code?: string }).code ?? '');
    return code !== 'log_info' && code !== 'log_warn';
  }) as { message?: string; error?: string; nodeId?: string } | undefined;

  const approve = () => {
    if (!gate) return;
    if (gateInfo.isCommand) {
      const payload = gateInfo.host && gateInfo.host !== 'local'
        ? JSON.stringify({ command: cmdDraft, host: gateInfo.host, ...(gateInfo.reason ? { reason: gateInfo.reason } : {}) })
        : cmdDraft;
      runner.gate(gate.nodeId, payload);
      return;
    }
    runner.gate(gate.nodeId, editing ? draft : suggestion);
    setEditing(false);
  };
  const rejectGate = () => {
    if (!gate) return;
    runner.gate(gate.nodeId, null);
    setEditing(false);
  };
  const startEdit = () => { setDraft(suggestion); setEditing(true); };

  const sawResetRef = useRef(resetSignal);
  useEffect(() => {
    if (sawResetRef.current === resetSignal) return;
    sawResetRef.current = resetSignal;
    setEditing(false);
    setDraft('');
    setCmdDraft('');
    setChatInput('');
    setExportResult(null);
    setDocsOpen(false);
  }, [resetSignal]);

  const chatNode = flow.nodes.find((n) => n.type === 'input.chat');
  const chatPlaceholder = chatNode
    ? ((typeof chatNode.params?.placeholder === 'string' && chatNode.params.placeholder.trim()) ||
      'Digite sua mensagem ou comando (Enter para enviar)...')
    : 'Este workflow não possui entrada de texto (input.chat).';

  // Conversa única: texto, STT, respostas, áudio e pensamento derivados dos eventos
  // e dos nós realmente presentes no workflow — sem papéis ou mensagens fixas.
  const suggestionCaption = lastOf(sinks.suggestion);
  const transcriptionCaption = [...runner.captions].reverse().find(
    (c) => c.kind === 'stt' || sinks.transcription.has(c.nodeId),
  );
  const liveAgent = suggestionCaption && !suggestionCaption.final && runner.running ? suggestionCaption : null;
  const liveStt = transcriptionCaption && !transcriptionCaption.final && runner.running ? transcriptionCaption : null;
  const conversation = useMemo<ConversationEntry[]>(() => {
    const items: ConversationEntry[] = [];
    const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
    const directParent = new Map<string, string>();
    for (const e of flow.edges) {
      const to = e.to.split('.')[0];
      if (!directParent.has(to)) directParent.set(to, e.from.split('.')[0]);
    }
    const label = (nodeId: string) => {
      const n = nodes.get(nodeId);
      return n ? shortNodeName(n.type, n.id, n.params) : nodeId;
    };
    const sourceLabel = (sinkId: string) => label(directParent.get(sinkId) ?? sinkId);
    const pushLive = (caption: Caption, kind: 'stt' | 'agent') => {
      const sourceId = directParent.get(caption.nodeId) ?? caption.nodeId;
      const source = nodes.get(sourceId);
      items.push({
        id: `${kind}-live-${caption.nodeId}`,
        kind,
        nodeId: sourceId,
        title: label(sourceId),
        subtitle: kind === 'stt'
          ? (source?.type === 'asr.lfm3' ? 'STT + tradução · ao vivo' : 'STT · ao vivo')
          : 'Resposta · ao vivo',
        text: caption.text,
        ts: caption.ts,
        live: true,
      });
    };

    for (const [i, m] of runner.chatMessages.entries()) {
      items.push({
        id: `chat-${m.ts}-${i}`, kind: 'user', nodeId: m.nodeId,
        title: 'Você', subtitle: 'Entrada escrita', text: m.text, ts: m.ts,
      });
    }
    for (const [i, c] of runner.captions.entries()) {
      if (!c.final) continue;
      const isStt = c.kind === 'stt' || sinks.transcription.has(c.nodeId);
      if (!isStt && !sinks.suggestion.has(c.nodeId)) continue;
      const sourceId = directParent.get(c.nodeId) ?? c.nodeId;
      const source = nodes.get(sourceId);
      items.push({
        id: `caption-${c.ts}-${i}`,
        kind: isStt ? 'stt' : 'agent',
        nodeId: sourceId,
        title: sourceLabel(c.nodeId),
        subtitle: isStt
          ? (source?.type === 'asr.lfm3' ? 'STT + tradução' : 'STT')
          : source?.type === 'translate.llm' || (source?.type === 'llm.omlx' && source.params.targetLanguage !== undefined)
            ? 'Tradução'
            : 'Resposta',
        text: c.text,
        ts: c.ts,
      });
    }
    for (const [i, ev] of runner.events.entries()) {
      const nodeId = String(ev.nodeId ?? '');
      const type = nodes.get(nodeId)?.type;
      if (ev.type !== 'node_error' || ev.code !== 'log_info' || (type !== 'tts.sts' && type !== 'sink.playback')) continue;
      const text = String(ev.message ?? '').trim();
      if (!text) continue;
      items.push({
        id: `audio-${i}`, kind: 'audio', nodeId,
        title: label(nodeId),
        subtitle: type === 'tts.sts' ? 'Síntese de voz' : 'Reprodução de áudio',
        text, ts: Number(ev._uiTs ?? 0),
      });
    }
    if (showThoughts) {
      for (const t of runner.thoughts) {
        items.push({
          id: `thought-${t.thoughtId}`, kind: 'thought', nodeId: t.nodeId,
          title: label(t.nodeId), subtitle: t.final ? 'Pensamento' : 'Pensamento · em andamento',
          text: t.text, ts: t.ts,
        });
      }
      const latestSteps = new Map<string, AgentStep>();
      for (const s of runner.agentSteps) {
        const key = `${s.nodeId}:${s.step}`;
        latestSteps.set(key, { ...s, ts: latestSteps.get(key)?.ts ?? s.ts });
      }
      for (const [key, s] of latestSteps) {
        const phase = s.phase === 'calling' ? 'chamando' : s.phase === 'rejected' ? 'rejeitada' : s.phase === 'repeated' ? 'repetida' : s.ok === false ? 'erro' : 'concluída';
        const args = s.args && Object.keys(s.args).length > 0 ? `\n${JSON.stringify(s.args)}` : '';
        const duration = typeof s.durationMs === 'number' ? ` · ${Math.round(s.durationMs)} ms` : '';
        items.push({
          id: `agent-step-${key}`, kind: 'thought', nodeId: s.nodeId,
          title: label(s.nodeId), subtitle: `Passo ${s.step} · ${phase}`,
          text: `${s.tool}${duration}${s.dryRun ? ' · dry-run' : ''}${args}`, ts: s.ts,
        });
      }
    }
    if (liveStt) pushLive(liveStt, 'stt');
    if (liveAgent) pushLive(liveAgent, 'agent');
    return items.sort((a, b) => a.ts - b.ts);
  }, [flow.nodes, flow.edges, runner.chatMessages, runner.captions, runner.events, runner.thoughts, runner.agentSteps, sinks, showThoughts, liveAgent, liveStt]);
  const chatLogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation]);

  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text || !runner.running || sendingChat || !chatNode) return;
    setSendingChat(true);
    try {
      await runner.sendChat(text, chatNode?.id);
      setChatInput('');
    } catch (e) {
      onNotify?.(`Erro ao enviar: ${(e as Error).message}`);
    } finally {
      setSendingChat(false);
    }
  };

  const handleExport = async (sendWebhook: boolean) => {
    setExporting(true);
    setExportResult(null);
    try {
      const trimmedUrl = webhookUrl.trim();
      try { localStorage.setItem(WEBHOOK_STORAGE_KEY, trimmedUrl); } catch { /* ignore */ }
      const res = await exportSession({
        saveMarkdown: true,
        flowName: currentFlow || scenarioName,
        ...(sendWebhook && trimmedUrl ? { webhookUrl: trimmedUrl } : {}),
      });
      const parts: string[] = [];
      if (res.markdownPath) parts.push(`Markdown salvo: ${res.markdownPath}`);
      if (res.webhookStatus !== undefined) parts.push(`Webhook HTTP ${res.webhookStatus}`);
      if (res.webhookError) parts.push(`Erro webhook: ${res.webhookError}`);
      const summary = parts.join(' · ') || 'Sessão exportada';
      setExportResult(summary);
      onNotify?.(summary);
    } catch (e) {
      const msg = `Erro ao exportar: ${(e as Error).message}`;
      setExportResult(msg);
      onNotify?.(msg);
    } finally {
      setExporting(false);
    }
  };

  const bd = runner.latencyBreakdown;

  // Card de aprovação de comando (exec.command / agent.tools) — compartilhado pelo layout
  // de chat (flows com input.chat) e pelo layout clássico de sugestão.
  const commandGateCard = gate && gateInfo.isCommand ? (
    <div className="cmd-gate-card">
      <div className="cmd-gate-head">
        <span className="cmd-gate-title"><Terminal size={16} /> Aprovação de Comando ({gate.nodeId})</span>
        <div className="cmd-gate-badges">
          {gateInfo.tool && (
            <Tag type="teal" size="sm">Tool: {gateInfo.tool}</Tag>
          )}
          <Tag type="cyan" size="sm">Host: {gateInfo.host}</Tag>
          {gateInfo.decision && (
            <Tag type={riskTagType(gateInfo.decision)} size="sm">Risco d1: {gateInfo.decision}</Tag>
          )}
          {hasExec && (
            <Tag type={execActive ? 'red' : 'blue'} size="sm">{execActive ? 'EXEC ATIVO' : 'DRY-RUN'}</Tag>
          )}
        </div>
      </div>
      {gateInfo.reason && <p className="cmd-gate-reason">{gateInfo.reason}</p>}
      <TextArea
        id="cmd-gate-input"
        labelText="Comando (editável antes da execução)"
        rows={3}
        className="cmd-gate-textarea"
        value={cmdDraft}
        onChange={(e) => setCmdDraft(e.target.value)}
      />
      <div className="live2-actions">
        <Button kind="primary" size="sm" renderIcon={Checkmark} className="approve-btn" onClick={approve}>
          Aprovar e Executar
        </Button>
        <Button kind="danger--tertiary" size="sm" renderIcon={Close} onClick={rejectGate}>
          Rejeitar
        </Button>
      </div>
    </div>
  ) : null;

  const sessionStats = useMemo(() => {
    const CONTEXT_WINDOW = 32768;
    let chars = 0;
    for (const n of flow.nodes) {
      if ((n.type === 'llm.omlx' || n.type === 'agent.tools') && typeof n.params.system === 'string') {
        chars += n.params.system.length;
      }
    }
    for (const d of contextDocs) chars += d.chars ?? (d.points?.join(' ').length ?? 0);
    for (const c of runner.captions) if (c.final) chars += c.text.length;
    for (const m of runner.chatMessages) chars += m.text.length;

    const contextTokens = chars > 0 ? Math.ceil(chars / 4) : 0;
    const contextPct = Math.min(100, Math.round((contextTokens / CONTEXT_WINDOW) * 100));
    const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

    const lastLlm = [...runner.captions].reverse().find(
      (c) => c.final && c.trace && typeof c.trace.tLlmFinalMs === 'number',
    );
    let tps: number | null = null;
    let responseSec: string | null = null;
    if (lastLlm?.trace?.tLlmFinalMs != null) {
      const tStart = lastLlm.trace.tLlmTtftMs ?? lastLlm.trace.tTurnMs ?? lastLlm.trace.tAsrFinalMs;
      if (tStart != null && lastLlm.trace.tLlmFinalMs > tStart) {
        const dtSec = (lastLlm.trace.tLlmFinalMs - tStart) / 1000;
        const outTok = Math.max(1, Math.ceil(lastLlm.text.length / 4));
        tps = Math.round(outTok / dtSec);
        responseSec = `${dtSec.toFixed(2)}s`;
      }
    }
    if (!responseSec && runner.latency != null) {
      responseSec = `${(runner.latency / 1000).toFixed(2)}s`;
    }

    return {
      contextTokens,
      contextWindow: CONTEXT_WINDOW,
      contextLabel: `${fmtTok(contextTokens)} (${contextPct}%)`,
      tpsLabel: tps != null ? `${tps} tok/s` : '—',
      responseLabel: responseSec ?? '—',
    };
  }, [flow.nodes, contextDocs, runner.captions, runner.chatMessages, runner.latency]);

  // Nós ativos em tempo real para destaque no mini-mapa do cabeçalho (suporta 1 ou 2+ simultâneos).
  const activeNodeIds = useMemo(() => {
    const active = new Set<string>();
    if (!runner.running) return active;
    for (const g of runner.gates) active.add(g.nodeId);
    for (const s of runner.agentSteps.slice(-4)) {
      if (s.phase === 'calling') active.add(s.nodeId);
    }
    const recentEvents = runner.events.slice(-6);
    for (let i = recentEvents.length - 1; i >= 0; i--) {
      const ev = recentEvents[i] as { type?: string; nodeId?: string };
      if (ev.nodeId && (ev.type === 'caption' || ev.type === 'agent_step' || ev.type === 'gate' || ev.type === 'node_started')) {
        active.add(ev.nodeId);
        if (active.size >= 2) break;
      }
    }
    if (active.size === 0) {
      for (const n of flow.nodes) {
        if (n.enabled !== false && (n.type === 'capture.ffmpeg' || n.type === 'input.chat')) {
          active.add(n.id);
        }
      }
    }
    return active;
  }, [runner.running, runner.gates, runner.agentSteps, runner.events, flow.nodes]);

  // Métricas executivas por stage (o que não existir naquele nó fica apenas "—").
  const stageMetrics = (s: Stage): { ctx: string; tps: string; time: string } => {
    const nodeSnap = runner.metrics[s.nodeId];
    const timers = nodeSnap?.timers ? Object.values(nodeSnap.timers) : [];
    const firstTimer = timers[0];
    if (s.kind === 'model-llm') {
      return {
        ctx: sessionStats.contextLabel,
        tps: sessionStats.tpsLabel,
        time: sessionStats.responseLabel,
      };
    }
    if (s.kind === 'model-asr' || s.kind === 'model-asr-lfm3') {
      const ms = bd?.asrMs ?? firstTimer?.lastMs;
      return {
        ctx: '—',
        tps: '—',
        time: ms != null ? `${(ms / 1000).toFixed(2)}s` : '—',
      };
    }
    if (s.kind === 'model-decision') {
      const ms = bd?.decisionMs ?? firstTimer?.lastMs;
      return {
        ctx: '—',
        tps: '—',
        time: ms != null ? `${(ms / 1000).toFixed(2)}s` : '—',
      };
    }
    return {
      ctx: '—',
      tps: '—',
      time: firstTimer?.lastMs != null ? `${(firstTimer.lastMs / 1000).toFixed(2)}s` : '—',
    };
  };

  return (
    <div className="live2">
      <header className="live2-top">
        <div className="live2-left-controls">
          <div className="live2-workflow-col">
            <div className="nav-mode-tabs" role="tablist" aria-label="Modo da interface">
              <Button kind="tertiary" size="sm" onClick={onGoBuilder}>
                Builder
              </Button>
              <Button kind="primary" size="sm" aria-current="page">
                Workflow
              </Button>
            </div>
            <div className="live-flow-select">
              <Dropdown
                id="live-flow" size="sm" titleText="Workflow" hideLabel label="Workflow"
                items={flows.map((f) => ({ id: f.name, label: f.name }))}
                itemToString={(it) => (it ? it.label : '')}
                selectedItem={flows.map((f) => ({ id: f.name, label: f.name })).find((i) => i.id === currentFlow) ?? null}
                onChange={({ selectedItem }) => selectedItem && onSwitchFlow(selectedItem.id)}
              />
            </div>
          </div>

          <div className="live2-aux-col">
            <div className="docs-trigger-wrap">
              <Button
                kind="tertiary"
                size="sm"
                renderIcon={Document}
                onClick={() => setDocsOpen(true)}
                className="live2-docs-btn"
              >
                Docs{contextDocs.length > 0 ? ` (${contextDocs.length})` : ''}
              </Button>
              <div className="docs-hover-list" role="tooltip">
                <div className="docs-hover-title">Documentos anexados ({contextDocs.length})</div>
                {contextDocs.length > 0 ? (
                  <ul>
                    {contextDocs.map((d) => <li key={d.name}>{d.name}</li>)}
                  </ul>
                ) : (
                  <div className="docs-hover-empty">Nenhum documento anexado</div>
                )}
              </div>
            </div>

            <div className="live2-audio-mutes" aria-label="Tema e controles de mudo">
              <Button
                kind="tertiary"
                size="sm"
                hasIconOnly
                renderIcon={theme === 'g100' ? Sun : Moon}
                iconDescription={theme === 'g100' ? 'Tema claro' : 'Tema escuro'}
                tooltipPosition="bottom"
                onClick={onToggleTheme}
              />
              <Button
                kind={micMuted ? 'danger--tertiary' : 'tertiary'}
                size="sm"
                hasIconOnly
                renderIcon={micMuted ? MicrophoneOff : Microphone}
                iconDescription={!hasCapture ? 'Workflow sem entrada de voz' : (micMuted ? 'Ativar captura de voz' : 'Mutar captura de voz')}
                tooltipPosition="bottom"
                disabled={!hasCapture}
                onClick={onToggleMicMute}
              />
              <Button
                kind={speakerMuted ? 'danger--tertiary' : 'tertiary'}
                size="sm"
                hasIconOnly
                renderIcon={speakerMuted ? VolumeMute : VolumeUp}
                iconDescription={!hasAudioOut ? 'Workflow sem saída de áudio' : (speakerMuted ? 'Ativar alto-falante' : 'Mutar alto-falante')}
                tooltipPosition="bottom"
                disabled={!hasAudioOut}
                onClick={onToggleSpeakerMute}
              />
            </div>
          </div>
        </div>

        <div className="live2-minimap-slot">
          <WorkflowMiniMap flow={flow} activeNodeIds={activeNodeIds} running={runner.running} />
        </div>

        <div className="live2-top-actions">
          <Button kind="tertiary" size="sm" renderIcon={Download} onClick={() => { setExportResult(null); setExportOpen(true); }}>
            Exportar
          </Button>
          <Button
            kind={runner.running ? 'secondary' : 'primary'}
            size="sm"
            renderIcon={runner.running ? Pause : Play}
            onClick={() => (runner.running ? runner.stop() : onStart(flow))}
          >
            {runner.running ? 'Pausar' : 'Iniciar'}
          </Button>
          <Button kind="tertiary" size="sm" renderIcon={Reset} onClick={onReset} title="Encerra o run e limpa tela, contexto e logs">
            Reset
          </Button>
          <Button kind="danger" size="sm" renderIcon={Stop} onClick={onExit}>
            Encerrar
          </Button>
        </div>
      </header>

      {stages.length > 0 && (
        <section className="live2-stages-bar" aria-label="Parâmetros e métricas por etapa">
          <div className="live2-stages">
            {stages.map((s) => {
              const items = stageItems(s, models, apps);
              const m = stageMetrics(s);
              const primaryValue = s.kind === 'model-translate' && (!s.value || s.value === '—') ? '-' : s.value;
              const isDual = Boolean(s.secondaryParam);
              const langItems = isDual
                ? supportedLanguagesForModel(
                    s.kind === 'voice' ? 'LFM3-Audio' : s.value,
                    s.secondaryKind === 'language-optional',
                  )
                : [];
              const curLang = s.secondaryValue === '-' || s.secondaryValue === '—' ? '' : (s.secondaryValue ?? '');
              const langDisabled = s.kind === 'model-translate' && (!s.value || s.value === '-' || s.value === '—');
              const finalLangItems = curLang && !langItems.some((l) => l.id === curLang)
                ? [{ id: curLang, label: curLang }, ...langItems]
                : langItems;
              return (
                <div key={s.key} className={`stage-dd${isDual ? ' stage-dd--dual' : ''}`} style={{ ['--accent' as string]: s.accent }}>
                  <span className="stage-dd-label">{s.label}</span>
                  <div className={`stage-dd-ctrl${isDual ? ' stage-dd-ctrl--dual' : ''}`}>
                    {s.kind === 'app' && (
                      <Button kind="ghost" size="sm" hasIconOnly renderIcon={Renew} iconDescription="Recarregar apps de áudio" tooltipPosition="bottom" onClick={onRefreshApps} />
                    )}
                    <Dropdown
                      id={`stage-${s.key}`} size="sm" titleText={s.label} hideLabel label={s.label}
                      items={items} itemToString={(it) => (it ? it.label : '')}
                      selectedItem={items.find((i) => i.id === primaryValue) ?? items[0]}
                      onChange={({ selectedItem }) => selectedItem && selectedItem.id !== '—' && onUpdateStage(s.nodeId, s.param, selectedItem.id)}
                    />
                    {s.secondaryParam && (
                      <Dropdown
                        id={`stage-${s.key}-sec`}
                        size="sm"
                        titleText={s.secondaryLabel ?? 'Idioma'}
                        hideLabel
                        label={s.secondaryLabel ?? 'Idioma'}
                        disabled={langDisabled}
                        items={finalLangItems}
                        itemToString={(it) => (it ? it.label : '')}
                        selectedItem={
                          langDisabled
                            ? { id: '', label: '— (desabilitado)' }
                            : (finalLangItems.find((i) => i.id === curLang) ?? finalLangItems[0])
                        }
                        onChange={({ selectedItem }) =>
                          selectedItem && onUpdateStage(s.nodeId, s.secondaryParam!, selectedItem.id)
                        }
                      />
                    )}
                  </div>
                  <div className="stage-metrics-bar" title={`${s.label} · Contexto / Velocidade / Tempo`}>
                    <span className="stage-metric-item"><Chip size={14} /><span>{m.ctx}</span></span>
                    <span className="stage-metric-sep" aria-hidden="true">|</span>
                    <span className="stage-metric-item"><Meter size={14} /><span>{m.tps}</span></span>
                    <span className="stage-metric-sep" aria-hidden="true">|</span>
                    <span className="stage-metric-item"><Time size={14} /><span>{m.time}</span></span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="live2-body">
        <main className="live2-main">
          {lastError && <div className="live2-error">⚠ {lastError.nodeId ? `[${lastError.nodeId}] ` : ''}{lastError.message ?? lastError.error}</div>}
          {!lastError && runner.lastRunError && <div className="live2-error">⚠ {runner.lastRunError}</div>}

          <>
              {commandGateCard}
              <div className="live-chat">
                <div className="live2-label">Conversa</div>
                <div className="live-chat-log" ref={chatLogRef}>
                  {conversation.length === 0 && !liveAgent && (
                    <p className="live-chat-empty">
                      {runner.running ? 'Envie uma mensagem para conversar com o agente.' : 'Inicie a sessão para conversar com o agente.'}
                    </p>
                  )}
                  {conversation.map((m) => (
                    m.kind === 'thought' ? (
                      <Accordion key={m.id} className="live-chat-thought" data-node-id={m.nodeId}>
                        <AccordionItem
                          title={(
                            <span className="live-chat-thought-heading">
                              <span><strong>{m.title}</strong> · {m.subtitle}</span>
                              <time>{new Date(m.ts).toLocaleTimeString()}</time>
                            </span>
                          )}
                        >
                          <div className="live-chat-thought-text">{m.text}</div>
                        </AccordionItem>
                      </Accordion>
                    ) : (
                      <article key={m.id} className={`live-chat-entry live-chat-entry--${m.kind}`} data-node-id={m.nodeId}>
                        <header className="live-chat-entry-head">
                          <span className="live-chat-entry-role">
                            <strong>{m.title}</strong>
                            <span>{m.subtitle}</span>
                          </span>
                          <time>{new Date(m.ts).toLocaleTimeString()}</time>
                        </header>
                        <div className="live-chat-entry-text">
                          {m.text}
                          {m.live && <span className="live-cursor" />}
                        </div>
                      </article>
                    )
                  ))}
                </div>
                {hasGate && gate && !gateInfo.isCommand && (
                  <section className="live-chat-suggestion" aria-label="Sugestão de resposta pendente">
                    <div className="live-chat-suggestion-head">
                      <strong>Sugestão de resposta</strong>
                      <Tag type="warm-gray" size="sm">Revisão pendente</Tag>
                    </div>
                    {editing ? (
                      <TextArea
                        id="edit-chat-suggestion"
                        labelText="Editar sugestão"
                        hideLabel
                        rows={3}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    ) : (
                      <div className="live-chat-suggestion-text">{suggestion}</div>
                    )}
                    <div className="live2-actions live-chat-gate-actions">
                      {editing ? (
                        <>
                          <Button kind="primary" size="sm" renderIcon={Checkmark} onClick={approve}>Enviar editada</Button>
                          <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>Cancelar</Button>
                        </>
                      ) : (
                        <>
                          <Button kind="primary" size="sm" renderIcon={Checkmark} className="approve-btn" onClick={approve}>
                            {hasTTS ? 'Aprovar & Falar' : 'Aprovar'}
                          </Button>
                          <Button kind="tertiary" size="sm" renderIcon={Edit} onClick={startEdit}>Editar</Button>
                          {hasLLM && <Button kind="tertiary" size="sm" renderIcon={Renew} onClick={onRegenerate}>Regerar</Button>}
                          <Button kind="danger--tertiary" size="sm" renderIcon={Close} onClick={rejectGate}>Rejeitar</Button>
                        </>
                      )}
                    </div>
                  </section>
                )}
                <div className="live-chat-input">
                  <TextArea
                    id="live-chat-input"
                    labelText="Mensagem"
                    hideLabel
                    rows={2}
                    placeholder={runner.running ? chatPlaceholder : 'Inicie a sessão para conversar...'}
                    value={chatInput}
                    disabled={!runner.running || sendingChat || !chatNode}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleSendChat();
                      }
                    }}
                  />
                  <Button
                    kind="primary"
                    size="md"
                    renderIcon={Play}
                    disabled={!runner.running || sendingChat || !chatInput.trim() || !chatNode}
                    onClick={() => void handleSendChat()}
                  >
                    Enviar
                  </Button>
                </div>
              </div>
            </>
        </main>
      </div>

      <Modal
        open={docsOpen}
        passiveModal
        modalHeading="Documentos & Runbooks (RAG)"
        onRequestClose={() => setDocsOpen(false)}
      >
        <div className="docs-modal-body">
          <input
            ref={fileRef}
            type="file"
            accept=".md,.markdown,.txt,.pdf,.yaml,.yml,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                const tags = uploadTags.split(',').map((t) => t.trim()).filter(Boolean);
                onUploadDoc(f, tags);
                setUploadTags('');
              }
              e.target.value = '';
            }}
          />
          <div className="ctx-upload">
            <TextInput
              id="ctx-tags-input"
              size="sm"
              labelText="Tags opcionais (separadas por vírgula)"
              placeholder="ex.: nginx, ops, runbook"
              value={uploadTags}
              onChange={(e) => setUploadTags(e.target.value)}
            />
            <Button kind="primary" size="sm" renderIcon={Add} onClick={() => fileRef.current?.click()}>
              Carregar documento
            </Button>
          </div>

          {contextDocs.map((d) => (
            <div key={d.name} className="ctx-doc">
              <Document size={18} />
              <div className="ctx-doc-body">
                <div className="ctx-doc-name">{d.name}</div>
                <div className="ctx-doc-sub ctx-doc-sub--ok">
                  <Checkmark size={12} /> {d.chunksCount ?? 0} chunks · {d.points.length} pontos
                </div>
                {d.tags && d.tags.length > 0 && (
                  <div className="ctx-chips" style={{ marginTop: 4 }}>
                    {d.tags.map((t, i) => <Tag key={i} type="cool-gray" size="sm">{t}</Tag>)}
                  </div>
                )}
                {d.points.length > 0 && <ul className="ctx-points">{d.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
              </div>
              <button className="ctx-doc-remove" onClick={() => onRemoveDoc(d.name)} title="Remover documento"><TrashCan size={14} /></button>
            </div>
          ))}
          {contextDocs.length === 0 && (
            <div className="ctx-doc ctx-doc--empty">
              <Document size={18} />
              <div>
                <div className="ctx-doc-name">Runbooks / Documentos locais</div>
                <div className="ctx-doc-sub">Carregue .md, .pdf, .txt, .yaml ou .json para busca BM25 on-device</div>
              </div>
            </div>
          )}
        </div>
      </Modal>

      <LogsPanel
        flowNodes={flow.nodes}
        onServiceStatus={onServiceStatus}
        resetSignal={resetSignal}
        thoughtsOn={showThoughts}
        onToggleThoughts={(next) => {
          setShowThoughts(next);
          try { localStorage.setItem(THOUGHTS_STORAGE_KEY, String(next)); } catch { /* ignore */ }
        }}
      />

      <Modal
        open={exportOpen}
        modalHeading="Exportar sessão"
        primaryButtonText={exporting ? 'Exportando…' : (webhookUrl.trim() ? 'Salvar .md e Enviar Webhook' : 'Salvar .md local')}
        secondaryButtonText="Fechar"
        primaryButtonDisabled={exporting}
        onRequestClose={() => setExportOpen(false)}
        onRequestSubmit={() => void handleExport(Boolean(webhookUrl.trim()))}
      >
        <p className="export-modal-desc">
          Salva a ata estruturada da sessão em <code>sessions/</code> (protegido no <code>.gitignore</code>).
          Opcionalmente, informe um Webhook URL (ex.: n8n local) para enviar o JSON da sessão.
        </p>
        <TextInput
          id="export-webhook-url"
          labelText="Webhook URL (opcional, opt-in)"
          placeholder="http://127.0.0.1:5678/webhook/falador"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
        />
        {exportResult && <p className="export-modal-result">{exportResult}</p>}
      </Modal>
    </div>
  );
}
