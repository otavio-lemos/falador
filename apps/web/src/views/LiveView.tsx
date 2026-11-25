// Tela de EXECUÇÃO — LIVE MODE + latência com breakdown + DRY-RUN/EXEC ATIVO + Limpar contexto +
// Exportar sessão (.md / webhook) + card rico de aprovação (comandos/host/risco d1) +
// sidebar de Documentos/Runbooks (RAG BM25 com tags e chunks).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AILabel,
  AILabelContent,
  Button,
  ButtonSet,
  ContainedList,
  ContainedListItem,
  Dropdown,
  Modal,
  Tag,
  TextArea,
  TextInput,
  Select,
  SelectItem,
  preview__IconIndicator as IconIndicator,
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
  Chat,
  User,
  Bot,
  Router,
  Sun,
  Moon,
  Microphone,
  MicrophoneOff,
  VolumeUp,
  VolumeMute,
  VoiceActivate,
  ErrorFilled,
  Send,
  Launch,
} from '@carbon/icons-react';
import type { Runner, Gate, AgentStep, Caption, AuditEvent } from '../useRunner';
import { exportSession, gateAction, type Flow, type ContextDoc, type ServiceStatusMap } from '../api';
import { openPopout, type PopoutPanel } from '../popout';
import {
  deriveStages,
  deriveStageGroups,
  classifySinks,
  nodeDisplayNames,
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

const WEBHOOK_STORAGE_KEY = 'falador.webhookUrl';
const THOUGHTS_STORAGE_KEY = 'falador.showThoughts';
const SUGGESTED_PROMPTS = [
  'O que está rodando agora?',
  'Mostre o último erro do run',
  'Resuma a auditoria desta sessão',
];

interface AuditFocus { nodeId: string; token: number }

interface Props {
  runner: Runner;
  flow: Flow;
  scenarioName: string;
  theme: 'g100' | 'white';
  onToggleTheme: () => void;
  inputMode: 'apps' | 'mic' | 'chat';
  outputMode: 'write' | 'speak';
  inputResetTick?: number;
  outputResetTick?: number;
  onToggleMicMute: () => void;
  onToggleOutputMode: () => void;
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  mics?: { id: number; name: string; sampleRate: number }[];
  contextDocs: ContextDoc[];
  onUploadDoc: (file: File, tags?: string[]) => void;
  onRemoveDoc: (name: string) => void;
  onStart: (flow: Flow) => void;
  flows: { name: string; description: string }[];
  currentFlow: string;
  onSwitchFlow: (name: string) => void;
  onUpdateStage: (nodeId: string, param: string, value: unknown) => void;
  onSetApprovalLevel?: (level: string) => void;
  onRegenerate: () => void;
  onRefreshApps?: () => void;
  onServiceStatus?: (status: ServiceStatusMap) => void;
  onNotify?: (msg: string) => void;
  onGoBuilder: () => void;
  onExit: () => void;
  onReset: () => void;
  resetSignal: number;
  /** Modo janela pop-out: renderiza só um painel (idêntico), para outra tela. */
  popout?: 'chat' | 'terminal' | 'logs' | 'audit' | 'log';
  /** Service ID para popout 'log' individual (ex.: 'omlx', 'asr', 'tts', 'web'). */
  popoutServiceId?: string;
}

interface Item { id: string; label: string }

interface GateHistoryItem {
  id: string;
  nodeId: string;
  status: 'Aprovado' | 'Editado' | 'Rejeitado';
  command: string;
  tool?: string;
  host?: string;
  ts: number;
}

const TOOL_TO_NODE_ID: Record<string, string> = {
  exec_ssh: 'exec_ssh',
  search_runbooks: 'rag_search',
  web_search: 'web_search',
  crawler: 'crawler',
  tool_mcp: 'tool_mcp',
  tool_workflow: 'tool_workflow',
};

interface ConversationEntry {
  id: string;
  kind: 'user' | 'stt' | 'agent' | 'audio' | 'thought' | 'decision' | 'agent-step' | 'goal-validation' | 'gate-history';
  nodeId: string;
  title: string;
  subtitle: string;
  text: string;
  ts: number;
  live?: boolean;
  tag?: string;
  nodeType?: string;
  tool?: string;
  step?: number;
  agentStep?: AgentStep;
  auditEvent?: AuditEvent;
  gateStatus?: GateHistoryItem['status'];
  gateHost?: string;
  gateTool?: string;
}

function stageItems(stage: Stage, models: { omlx: string[]; cache: string[] }, apps: string[]): Item[] {
  if (stage.kind === 'approve-mode') {
    return [
      { id: 'always', label: 'Always' },
      { id: 'manual', label: 'Manual' },
      { id: 'non_readonly', label: 'Non-readonly' },
      { id: 'auto', label: 'Auto (bypass)' },
      { id: 'never', label: 'Never' },
    ];
  }
  if (stage.kind === 'output-mode') {
    return [{ id: 'write', label: 'Escrever' }, { id: 'speak', label: 'Falar' }];
  }
  if (stage.kind === 'exec-mode') {
    return [{ id: 'dry-run', label: 'DRY-RUN' }, { id: 'ativo', label: 'EXEC ATIVO' }];
  }
  if (stage.kind === 'conector-rag') {
    return [{ id: '1', label: '1 chunk' }, { id: '3', label: '3 chunks' }, { id: '5', label: '5 chunks' }, { id: '10', label: '10 chunks' }];
  }
  if (stage.kind === 'conector-web') {
    return [{ id: '3', label: '3 resultados' }, { id: '5', label: '5 resultados' }, { id: '10', label: '10 resultados' }];
  }
  if (stage.kind === 'conector-crawler') {
    return [{ id: '3', label: '3 páginas' }, { id: '5', label: '5 páginas' }, { id: '10', label: '10 páginas' }];
  }
  if (stage.kind === 'conector-mcp') {
    return [{ id: 'stdio', label: 'stdio' }, { id: 'http', label: 'http' }];
  }
  if (stage.kind === 'conector-workflow') {
    return [{ id: 'dry-run', label: 'dry-run' }, { id: 'ativo', label: 'gravar' }];
  }
  if (stage.kind === 'voice') return [{ id: 'female', label: 'Feminino' }, { id: 'male', label: 'Masculino' }];
  if (stage.kind === 'app') {
    // primary dropdown = origem de captura
    if (stage.param === 'backend') {
      return [
        { id: 'apps', label: 'Aplicações' },
        { id: 'mic', label: 'Microfone' },
        { id: 'chat', label: 'Chat' },
      ];
    }
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
  isAskUser: boolean;
  prompt?: string;
  tool?: string;
  host: string;
  command: string;
  decision?: string;
  reason?: string;
  options: string[];
  context?: string;
  fields?: { name: string; label: string; type?: string; placeholder?: string; options?: string[]; required?: boolean }[];
} {
  if (!gate) return { isCommand: false, isAskUser: false, host: 'local', command: '', options: [], fields: [] };
  const meta = gate.meta;
  let tool = meta?.tool;
  let host = meta?.host;
  let command = meta?.command;
  let decision = meta?.decision;
  let reason = meta?.reason;
  let prompt: string | undefined;

  const trimmed = gate.text.trim();
  let ctxVal: string | undefined;
  let fieldsVal: any;
  const candidate = trimmed.startsWith('{')
    ? trimmed
    : (trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? '');
  if (candidate.startsWith('{')) {
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof obj.tool === 'string' && !tool) tool = obj.tool;
      if (typeof obj.command === 'string' && !command) command = obj.command;
      if (typeof obj.host === 'string' && !host) host = obj.host;
      if (typeof obj.reason === 'string' && !reason) reason = obj.reason;
      if (typeof obj.decision === 'string' && !decision) decision = obj.decision;
      if (typeof obj.prompt === 'string') prompt = obj.prompt;
      else if (typeof obj.question === 'string') prompt = obj.question;
      else if (obj.args && typeof (obj.args as Record<string, unknown>).prompt === 'string') {
        prompt = (obj.args as Record<string, unknown>).prompt as string;
      }
      if (typeof obj.context === 'string') ctxVal = obj.context;
      else if (obj.args && typeof (obj.args as Record<string, unknown>).context === 'string') ctxVal = (obj.args as Record<string, unknown>).context as string;
      if (Array.isArray(obj.fields)) fieldsVal = obj.fields;
      else if (obj.args && Array.isArray((obj.args as Record<string, unknown>).fields)) fieldsVal = (obj.args as Record<string, unknown>).fields;
    } catch { /* não é JSON */ }
  }

  const isAskUser = tool === 'ask_user' || meta?.tool === 'ask_user' || gate.nodeId.includes('ask_user') || trimmed.includes('"ask_user"');
  if (isAskUser && !prompt) {
    prompt = reason || trimmed;
  }
  const isCommand = !isAskUser && Boolean(command || tool || meta?.host || meta?.command || meta?.reason || meta?.tool);
  const metaOptions = meta?.args?.options;
  if (!ctxVal && typeof meta?.args?.context === 'string') ctxVal = meta.args.context as string;
  if (!fieldsVal && Array.isArray(meta?.args?.fields)) fieldsVal = meta.args.fields;
  const options = Array.isArray(metaOptions)
    ? metaOptions.filter((o): o is string => typeof o === 'string' && o.trim() !== '')
    : [];
  return {
    isCommand,
    isAskUser,
    options,
    prompt,
    tool,
    host: host || 'local',
    command: command ?? gate.text,
    decision,
    reason,
    context: ctxVal,
    fields: Array.isArray(fieldsVal) ? fieldsVal : [],
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

type ChatTagType = 'gray' | 'cyan' | 'green' | 'blue' | 'purple' | 'teal' | 'red' | 'magenta' | 'warm-gray';

// Shell ÚNICO de toda ocorrência na conversa (referência do dono, 2026-11-23):
// barra de acento, avatar, papel em negrito, Tag, hora e corpo. Vale para mensagem,
// transcrição, resposta, áudio, passo, decisão, erro e aprovação.
function ChatCard({
  kind, nodeId, role, tag, tagType, accent, icon, ts, meta, aiLabel, body, ariaLabel, onOpenAudit,
}: {
  kind: string;
  nodeId: string;
  role: string;
  tag: string;
  tagType: ChatTagType;
  accent: string;
  icon: ReactNode;
  ts?: number;
  meta?: ReactNode;
  aiLabel?: boolean;
  body: ReactNode;
  ariaLabel?: string;
  onOpenAudit?: () => void;
}) {
  return (
    <article
      className={`live-chat-entry live-chat-entry--${kind}`}
      data-node-id={nodeId}
      style={{ ['--accent' as string]: accent }}
      aria-label={ariaLabel || (onOpenAudit ? `Ver auditoria de ${nodeId}` : undefined)}
      role={onOpenAudit ? 'button' : undefined}
      tabIndex={onOpenAudit ? 0 : undefined}
      onClick={onOpenAudit ? (e) => {
        if ((e.target as HTMLElement).closest('button, a, input, textarea, summary')) return;
        onOpenAudit();
      } : undefined}
      onKeyDown={onOpenAudit ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenAudit(); }
      } : undefined}
    >
      <span className="live-chat-accent" aria-hidden="true" />
      <span className="live-chat-avatar" aria-hidden="true">{icon}</span>
      <div className="live-chat-block-body">
        {ts != null && <time className="live-chat-entry-time">{new Date(ts).toLocaleTimeString()}</time>}
        <strong className="live-chat-entry-role">{role}</strong>
        {tag ? <Tag type={tagType} size="sm">{tag}</Tag> : null}
        {aiLabel && (
          <AILabel kind="inline" size="mini" autoAlign>
            <AILabelContent>
              <p className="secondary">Gerado por IA</p>
            </AILabelContent>
          </AILabel>
        )}
        {meta}
        <span className="live-chat-entry-body">{body}</span>
      </div>
    </article>
  );
}

export function LiveView({
  runner, flow, scenarioName, theme, onToggleTheme,
  inputMode, outputMode, inputResetTick = 0, outputResetTick = 0, onToggleMicMute, onToggleOutputMode,
  models, apps, contextDocs,
  onUploadDoc, onRemoveDoc, onStart, flows, currentFlow,
  onSwitchFlow, onUpdateStage, onSetApprovalLevel, onRegenerate, onServiceStatus, onNotify, onGoBuilder, onExit, onReset, resetSignal, popout, popoutServiceId,
}: Props) {
  const stages = useMemo(() => deriveStages(flow), [flow]);
  const stageGroups = useMemo(() => deriveStageGroups(flow), [flow]);
  const names = useMemo(() => nodeDisplayNames(flow.nodes, flow.edges), [flow]);
  const [selectedByGroup, setSelectedByGroup] = useState<Record<string, string>>({});
  const sinks = useMemo(() => classifySinks(flow), [flow]);

  useEffect(() => {
    setSelectedByGroup({});
  }, [currentFlow]);

  useEffect(() => {
    if (inputResetTick === 0) return;
    setSelectedByGroup((prev) => {
      if (!('Input' in prev)) return prev;
      const next = { ...prev };
      delete next.Input;
      return next;
    });
  }, [inputResetTick]);

  useEffect(() => {
    if (outputResetTick === 0) return;
    setSelectedByGroup((prev) => {
      if (!('Output' in prev)) return prev;
      const next = { ...prev };
      delete next.Output;
      return next;
    });
  }, [outputResetTick]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [cmdDraft, setCmdDraft] = useState('');
  const [editingCmd, setEditingCmd] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string,string>>({});
  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [showThoughts, setShowThoughts] = useState(() => {
    try { return localStorage.getItem(THOUGHTS_STORAGE_KEY) === 'true'; } catch { return false; }
  });
  const [docsOpen, setDocsOpen] = useState(false);
  const [uploadTags, setUploadTags] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [gateHistory, setGateHistory] = useState<GateHistoryItem[]>([]);
  const [auditFocus, setAuditFocus] = useState<AuditFocus | null>(null);
  // Uma janela de browser real, reaproveitada. Nunca about:blank, nunca innerHTML.
  const consoleWinRef = useRef<Window | null>(null);
  const consoleBcRef = useRef<BroadcastChannel | null>(null);
  const openConsole = () => {
    // Aciona a aba Terminal embutida no painel inferior da tela (sem popup solto)
    window.dispatchEvent(new CustomEvent('falador-open-terminal'));
  };

  // A janela do Console aprova gates; a conversa espelha o histórico sem reenviar o POST.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bc = new BroadcastChannel('falador-console');
    consoleBcRef.current = bc;
    bc.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; nodeId?: string; text?: string | null; ts?: number; status?: GateHistoryItem['status'] };
      if (m?.type !== 'gate_answered' || !m.nodeId) return;
      const nodeId = m.nodeId;
      const ts = m.ts ?? Date.now();
      setGateHistory((prev) => [...prev, {
        id: `gate-${nodeId}-${ts}-${prev.length}`,
        nodeId,
        status: m.status ?? (m.text === null ? 'Rejeitado' : 'Aprovado'),
        command: m.text ?? '',
        ts,
      }]);
    };
    return () => { bc.close(); consoleBcRef.current = null; };
  }, []);

  const wasRunningRef = useRef(runner.running);
  useEffect(() => {
    if (!wasRunningRef.current && runner.running) {
      setGateHistory([]);
    }
    if (wasRunningRef.current && !runner.running) {
      consoleBcRef.current?.postMessage({ type: 'gate_active', gate: null, ts: Date.now() });
    }
    wasRunningRef.current = runner.running;
  }, [runner.running]);
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
  // Ao trocar/resolver o gate, sai do modo de edição do comando.
  useEffect(() => { setEditingCmd(false); }, [gate?.nodeId]);

  // Contrato com a janela do Console: sempre que o gate pendente muda (inclusive
  // null no fim/reset do run), publica no mesmo canal. NÃO reenvia POST /api/gate.
  useEffect(() => {
    consoleBcRef.current?.postMessage({
      type: 'gate_active',
      gate: gate
        ? { nodeId: gate.nodeId, text: gate.text, ts: gate.ts, ...(gate.meta ? { meta: gate.meta } : {}) }
        : null,
      ts: Date.now(),
    });
  }, [gate, runner.running]);

  // Sincroniza rascunho editável do comando sempre que chegar um novo gate de comando
  useEffect(() => {
    if (gate && (gateInfo.isCommand || gateInfo.isAskUser)) {
      setCmdDraft(gateInfo.isAskUser ? "" : gateInfo.command);
      setFieldValues({});
    }
  }, [gate, gateInfo.isCommand, gateInfo.isAskUser, gateInfo.command]);

  const suggestion = gate ? gate.text : (lastOf(sinks.suggestion)?.text ?? '');

  // NADA FIXO: painéis e indicadores derivam dos nós presentes no workflow.
  const hasGate = flow.nodes.some(
    (n) => n.type === 'human.approve' || (n.type === 'agent.tools' && n.params.approvalPolicy !== 'never'),
  );
  const hasInput = flow.nodes.some((n) => n.type === 'capture.ffmpeg' || n.type === 'input.chat');
  const hasOutput = flow.nodes.some((n) => n.enabled !== false && (n.type === 'sink.captions' || n.type === 'sink.playback' || n.type === 'tts.sts'));
  const hasTTS = flow.nodes.some((n) => n.type === 'tts.sts' || (n.type === 'sink.captions' && n.params?.outputMode === 'speak'));
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
    return code !== 'log_info' && code !== 'log_warn' && code !== 'log_debug';
  }) as { message?: string; error?: string; nodeId?: string; _uiTs?: number } | undefined;

  const approve = (value?: string | { type: string }) => {
    if (!gate) return;
    if (gateInfo.isAskUser) {
      const fields = gateInfo.fields ?? [];
      const answer = typeof value === 'string'
        ? value
        : (fields.length > 0
            ? JSON.stringify(fieldValues)
            : (cmdDraft as string));
      // Remove entrada histórica anterior do mesmo nó (não deixa duplicados na conversa).
      setGateHistory((prev) => [
        ...prev.filter((h) => h.nodeId !== gate.nodeId),
        {
          id: `gate-${gate.nodeId}-${Date.now()}-${prev.length}`,
          nodeId: gate.nodeId,
          status: 'Aprovado',
          command: answer,
          tool: 'ask_user',
          ts: Date.now(),
        },
      ]);
      runner.gate(gate.nodeId, answer);
      setCmdDraft('');
      setFieldValues({});
      return;
    }
    if (gateInfo.isCommand) {
      // fallback: usa o comando do gate quando nada digitado (evita EXEC_POLICY_DENIED "Comando vazio")
      const cmd = cmdDraft.trim() !== '' ? cmdDraft : gateInfo.command;
      const wasEdited = cmd.trim() !== gateInfo.command.trim();
      setGateHistory((prev) => [
        ...prev.filter((h) => h.nodeId !== gate.nodeId),
        {
          id: `gate-${gate.nodeId}-${Date.now()}-${prev.length}`,
          nodeId: gate.nodeId,
          status: wasEdited ? 'Editado' : 'Aprovado',
          command: cmd,
          tool: gateInfo.tool,
          host: gateInfo.host,
          ts: Date.now(),
        },
      ]);
      const payload = gateInfo.host && gateInfo.host !== 'local'
        ? JSON.stringify({ command: cmd, host: gateInfo.host, ...(gateInfo.reason ? { reason: gateInfo.reason } : {}) })
        : cmd;
      runner.gate(gate.nodeId, payload);
      return;
    }
    const finalText = editing ? draft : suggestion;
    const wasEdited = editing && draft.trim() !== suggestion.trim();
      setGateHistory((prev) => [
        ...prev.filter((h) => h.nodeId !== gate.nodeId),
        {
          id: `gate-${gate.nodeId}-${Date.now()}-${prev.length}`,
          nodeId: gate.nodeId,
          status: wasEdited ? 'Editado' : 'Aprovado',
          command: finalText,
          ts: Date.now(),
        },
      ]);
      runner.gate(gate.nodeId, finalText);
      setEditing(false);
    };
    const rejectGate = () => {
      if (!gate) return;
      if (gateInfo.isAskUser) {
        setGateHistory((prev) => [
          ...prev.filter((h) => h.nodeId !== gate.nodeId),
          {
            id: `gate-${gate.nodeId}-${Date.now()}-${prev.length}`,
            nodeId: gate.nodeId,
            status: 'Rejeitado',
            command: cmdDraft,
            tool: 'ask_user',
            ts: Date.now(),
          },
        ]);
        void gateAction(gate.nodeId, null, cmdDraft);
        setCmdDraft('');
        return;
      }
      setGateHistory((prev) => [
        ...prev.filter((h) => h.nodeId !== gate.nodeId),
        {
          id: `gate-${gate.nodeId}-${Date.now()}-${prev.length}`,
          nodeId: gate.nodeId,
          status: 'Rejeitado',
          command: gateInfo.isCommand ? cmdDraft : suggestion,
          tool: gateInfo.tool,
          host: gateInfo.host,
          ts: Date.now(),
        },
      ]);
    void gateAction(gate.nodeId, null, gateInfo.isCommand ? cmdDraft : editing ? draft : '');
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
    setFieldValues({});
    setChatInput('');
    setGateHistory([]);
    setAuditFocus(null);
    setExportResult(null);
    setDocsOpen(false);
  }, [resetSignal]);

  const chatNode = flow.nodes.find((n) => n.type === 'input.chat' || n.type === 'capture.ffmpeg');
  const captureAppNode = flow.nodes.find(
    (n) => n.type === 'capture.ffmpeg' && typeof n.params.input === 'string' && n.params.input.trim(),
  );
  const captureApp = typeof captureAppNode?.params.input === 'string' ? captureAppNode.params.input : '';
  const chatPlaceholder = chatNode
    ? ((typeof chatNode.params?.placeholder === 'string' && chatNode.params.placeholder.trim()) ||
      'Digite sua mensagem ou comando (Enter para enviar)...')
    : 'Este workflow não possui entrada (Input).';

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
    const label = (nodeId: string) => names.get(nodeId)?.label ?? nodeId;
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
        tag: kind === 'stt' ? (captureApp || 'ASR') : 'Resposta',
        nodeType: source?.type,
      });
    };

    for (const [i, m] of runner.chatMessages.entries()) {
      items.push({
        id: `chat-${m.ts}-${i}`, kind: 'user', nodeId: m.nodeId,
        title: 'Você', subtitle: 'Entrada escrita', text: m.text, ts: m.ts,
        tag: captureApp || 'Chat', nodeType: chatNode?.type,
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
        tag: isStt
          ? (captureApp || (source?.type === 'asr.lfm3' ? 'Tradução' : 'ASR'))
          : (source?.type === 'agent.tools' ? 'Especialista' : source?.type === 'translate.llm' ? 'Tradução' : 'Resposta'),
        nodeType: source?.type,
      });
    }
    for (const [i, ev] of runner.events.entries()) {
      const nodeId = String(ev.nodeId ?? '');
      const type = nodes.get(nodeId)?.type;
      if (ev.type === 'node_error' && (ev.code === 'log_info' || ev.code === 'log_warn') && (type === 'decision.llm' || type === 'turn.detector')) {
        const text = String(ev.message ?? '').trim();
        if (!text) continue;
        items.push({
          id: `decision-${i}`,
          kind: 'decision',
          nodeId,
          title: label(nodeId),
          subtitle: type === 'turn.detector' ? 'Fim de turno' : 'Decisão',
          text,
          ts: Number(ev._uiTs ?? 0),
          tag: type === 'turn.detector' ? 'Turno' : 'Decisão',
          nodeType: type,
        });
        continue;
      }
      if (ev.type !== 'node_error' || ev.code !== 'log_info') continue;
      const text = String(ev.message ?? '').trim();
      if (!text) continue;
      const isCaptionSpeak = type === 'sink.captions' && (text.startsWith('fala:') || text.startsWith('playback ok'));
      if (type !== 'tts.sts' && type !== 'sink.playback' && !isCaptionSpeak) continue;
      const isTts = type === 'tts.sts' || text.startsWith('fala:');
      items.push({
        id: `audio-${i}`, kind: 'audio', nodeId,
        title: label(nodeId),
        subtitle: isTts ? 'Síntese de voz' : 'Reprodução de áudio',
        text, ts: Number(ev._uiTs ?? 0),
        tag: isTts ? 'TTS' : 'Playback', nodeType: type,
      });
    }
    const latestSteps = new Map<string, AgentStep>();
    for (const s of runner.agentSteps) {
      const key = `${s.nodeId}:${s.step}`;
      latestSteps.set(key, { ...s, ts: latestSteps.get(key)?.ts ?? s.ts });
    }
    for (const [key, s] of latestSteps) {
      const phase = s.phase === 'calling' ? 'chamando' : s.phase === 'rejected' ? 'rejeitada' : s.phase === 'repeated' ? 'repetida' : s.ok === false ? 'erro' : 'concluída';
      const isSearchTool = s.tool === 'rag.search' || s.tool === 'rag_search' || s.tool === 'tool.web_search' || s.tool === 'tool_web_search' || s.tool === 'tool.crawler' || s.tool === 'tool_crawler';
      const argStr = (!isSearchTool && s.args && Object.keys(s.args).length > 0)
        ? ` · ${Object.entries(s.args).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ')}`
        : '';
      const duration = typeof s.durationMs === 'number' ? ` · ${Math.round(s.durationMs)} ms` : '';
      items.push({
        id: `agent-step-${key}`, kind: 'agent-step', nodeId: s.nodeId,
        title: label(s.nodeId), subtitle: `Passo ${s.step} · ${phase}`,
        text: `${s.tool}${duration}${s.dryRun ? ' · dry-run' : ''}${argStr}`, ts: s.ts,
        tag: `Passo ${s.step}`, nodeType: nodes.get(s.nodeId)?.type,
        tool: s.tool, step: s.step, agentStep: s,
      });
    }
    for (const ev of runner.audit) {
      if (ev.op === 'goal_validation' && ev.validation) {
        items.push({
          id: `audit-val-${ev.runId}-${ev.seq}`,
          kind: 'goal-validation',
          nodeId: ev.nodeId,
          title: 'Validação de Objetivo',
          subtitle: ev.validation.achieved ? 'Objetivo atingido' : 'Objetivo pendente',
          text: ev.goal ?? '',
          ts: ev.ts,
          tag: ev.validation.achieved ? 'Atingido' : 'Pendente',
          auditEvent: ev,
        });
      } else if (ev.op === 'agent_final' && ev.maxStepsReached) {
        items.push({
          id: `audit-final-${ev.runId}-${ev.seq}`,
          kind: 'goal-validation',
          nodeId: ev.nodeId,
          title: 'Validação de Objetivo',
          subtitle: 'Limite de passos atingido',
          text: ev.text ?? 'Limite máximo de passos atingido.',
          ts: ev.ts,
          tag: 'Limite de passos',
          auditEvent: ev,
        });
      }
    }
    for (const h of gateHistory) {
      items.push({
        id: h.id,
        kind: 'gate-history',
        nodeId: h.nodeId,
        title: 'Aprovação',
        subtitle: h.status,
        text: h.command,
        ts: h.ts,
        tag: h.status,
        gateStatus: h.status,
        gateHost: h.host,
        gateTool: h.tool,
      });
    }
    if (showThoughts) {
      for (const t of runner.thoughts) {
        items.push({
          id: `thought-${t.thoughtId}`, kind: 'thought', nodeId: t.nodeId,
          title: label(t.nodeId), subtitle: t.final ? 'Pensamento' : 'Pensamento · em andamento',
          text: t.text, ts: t.ts,
          tag: 'Roteamento', nodeType: nodes.get(t.nodeId)?.type,
        });
      }
    }
    if (liveStt) pushLive(liveStt, 'stt');
    if (liveAgent) pushLive(liveAgent, 'agent');
    return items.sort((a, b) => a.ts - b.ts);
  }, [flow.nodes, flow.edges, runner.chatMessages, runner.captions, runner.events, runner.thoughts, runner.agentSteps, runner.audit, gateHistory, sinks, showThoughts, liveAgent, liveStt, captureApp, chatNode]);

  const latestPlan = useMemo(() => {
    for (let i = runner.audit.length - 1; i >= 0; i--) {
      const a = runner.audit[i];
      if (a.op === 'plan' && Array.isArray(a.plan) && a.plan.length > 0) return a.plan;
    }
    return null;
  }, [runner.audit]);
  const chatLogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation, gate, lastError, runner.lastRunError]);

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

  const lastCaption = runner.captions[runner.captions.length - 1];
  const agentBusy = runner.agentSteps.some((s) => s.phase === 'calling') || Boolean(lastCaption && !lastCaption.final);
  const turnStatus = gate
    ? gateInfo.isAskUser
      ? { label: 'Aguardando resposta', type: 'cyan' as const, hint: 'Responda à pergunta do agente abaixo para continuar.' }
      : { label: 'Aguardando aprovação', type: 'teal' as const, hint: 'Revise e aprove ou rejeite a ação abaixo.' }
    : !runner.running
      ? { label: 'Parado', type: 'gray' as const, hint: 'Inicie a sessão para conversar com o agente.' }
      : agentBusy
        ? { label: 'Pensando', type: 'blue' as const, hint: 'Processando a resposta…' }
        : { label: 'Pronto', type: 'green' as const, hint: 'Sessão ativa — envie uma mensagem.' };

  const openAuditFor = (nodeId: string) => setAuditFocus(nodeId ? { nodeId, token: Date.now() } : null);

  // Aprovação/comando pendente: card de conversa à esquerda, ações (Responder /
  // Aprovar e Executar / Editar / Rejeitar) para fora, ao lado direito do card,
  // nunca sobrepondo o corpo nem coladas ao carimbo de hora.
  const gateCard = hasGate && gate ? (
    <>
      <div className="live-chat-gate-wrapper">
        <ChatCard
          kind="gate"
          nodeId={gate.nodeId}
          role={gateInfo.isAskUser ? 'Pergunta do Agente' : 'Aprovação'}
          tag={gateInfo.isAskUser ? '' : (gateInfo.isCommand ? 'Comando' : 'Revisão')}
          tagType={gateInfo.isAskUser ? 'cyan' : gateInfo.isCommand ? 'teal' : 'purple'}
          accent={gateInfo.isAskUser ? 'var(--cds-support-info)' : 'var(--cds-support-warning, #f1c21b)'}
          icon={gateInfo.isAskUser ? <Chat size={18} /> : <Checkmark size={18} />}
          ts={gate.ts}
          ariaLabel={gateInfo.isAskUser ? 'Pergunta guiada pendente' : gateInfo.isCommand ? 'Aprovação de comando pendente' : 'Aprovação de resposta pendente'}
          body={(
            <>
              <div className="live-chat-gate-tags">
                {gateInfo.isCommand && gateInfo.tool && <Tag type="teal" size="sm">Tool: {gateInfo.tool}</Tag>}
                {gateInfo.isCommand && gateInfo.host && <Tag type="cyan" size="sm">Host: {gateInfo.host}</Tag>}
                {gateInfo.isCommand && gateInfo.decision && (
                  <Tag type={riskTagType(gateInfo.decision)} size="sm">Risco d1: {gateInfo.decision}</Tag>
                )}
                {runner.testMode && <Tag type="magenta" size="sm">TESTE</Tag>}
              </div>
              {gateInfo.isAskUser ? (
                <>
                  <p className="live-chat-entry-text" style={{ fontWeight: 500 }}>
                    {gateInfo.prompt || gate.text}
                  </p>

                  {gateInfo.options.length > 0 && (
                    <div className="live-chat-gate-options" role="group" aria-label="Opções sugeridas">
                      {gateInfo.options.map((opt, i) => (
                        <Button key={`${i}-${opt}`} kind="tertiary" size="sm" onClick={() => approve(opt)}>
                          {opt}
                        </Button>
                      ))}
                    </div>
                  )}
                  {(gateInfo.fields ?? []).length > 0 ? (
                    <div className="live-chat-askuser-fields">
                      {(gateInfo.fields ?? []).map((f) => (
                        f.type === 'select' ? (
                          <Select
                            key={f.name}
                            id={`field-${f.name}`}
                            labelText={f.label}
                            hideLabel
                            size="sm"
                            value={fieldValues[f.name] ?? ''}
                            onChange={(e) => setFieldValues((v) => ({ ...v, [f.name]: e.target.value }))}
                          >
                            <SelectItem value="" text={f.placeholder ?? f.label} />
                            {(f.options ?? []).map((o) => <SelectItem key={o} value={o} text={o} />)}
                          </Select>
                        ) : (
                          <TextInput
                            key={f.name}
                            id={`field-${f.name}`}
                            labelText={f.label}
                            hideLabel
                            type={f.type === 'password' ? 'password' : 'text'}
                            size="sm"
                            placeholder={f.placeholder ?? f.label}
                            value={fieldValues[f.name] ?? ''}
                            onChange={(e) => setFieldValues((v) => ({ ...v, [f.name]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); approve(); } }}
                          />
                        )
                      ))}
                      <Button kind="primary" size="sm" renderIcon={Send} className="approve-btn" onClick={() => approve()}>Enviar</Button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                      <TextInput
                        id="ask-user-gate-input"
                        labelText=""
                        size="sm"
                        placeholder="Digite sua resposta para o agente continuar..."
                        value={cmdDraft}
                        onChange={(e) => setCmdDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); approve(); } }}
                        style={{ flex: 1 }}
                      />
                      <Button kind="primary" size="sm" renderIcon={Checkmark} className="approve-btn" onClick={approve}>
                        Responder
                      </Button>
                    </div>
                  )}
                </>
              ) : gateInfo.isCommand ? (
                <>
                  {gateInfo.reason && <span className="live-chat-entry-reason">{gateInfo.reason}</span>}
                  {editingCmd ? (
                    <TextInput
                      id="cmd-gate-input"
                      labelText="Comando"
                      hideLabel
                      size="sm"
                      className="cmd-gate-input"
                      value={cmdDraft}
                      onChange={(e) => setCmdDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); approve(); } }}
                    />
                  ) : (
                    <code className="live-chat-entry-code" title={cmdDraft}>{cmdDraft}</code>
                  )}
                  <ButtonSet className="gate-actions">
                    <Button kind="primary" size="sm" renderIcon={Checkmark} className="approve-btn" onClick={approve}>
                      Aprovar e Executar
                    </Button>
                    <Button kind="tertiary" size="sm" renderIcon={Edit} onClick={() => setEditingCmd(true)}>
                      Editar
                    </Button>
                    <Button kind="danger--tertiary" size="sm" renderIcon={Close} onClick={rejectGate}>
                      Rejeitar
                    </Button>
                  </ButtonSet>
                </>
              ) : editing ? (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                  <TextArea
                    id="edit-chat-suggestion"
                    labelText="Editar sugestão"
                    hideLabel
                    rows={2}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <ButtonSet className="gate-actions">
                    <Button kind="primary" size="sm" renderIcon={Checkmark} onClick={approve}>Enviar editada</Button>
                    <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>Cancelar</Button>
                  </ButtonSet>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
                  <div className="live-chat-entry-text" style={{ flex: 1 }}>{suggestion}</div>
                  <ButtonSet className="gate-actions">
                    <Button kind="primary" size="sm" renderIcon={Checkmark} className="approve-btn" onClick={approve}>
                      {hasTTS ? 'Aprovar & Falar' : 'Aprovar'}
                    </Button>
                    <Button kind="tertiary" size="sm" renderIcon={Edit} onClick={startEdit}>Editar</Button>
                    {hasLLM && <Button kind="tertiary" size="sm" renderIcon={Renew} onClick={onRegenerate}>Regerar</Button>}
                    <Button kind="danger--tertiary" size="sm" renderIcon={Close} onClick={rejectGate}>Rejeitar</Button>
                  </ButtonSet>
                </div>
              )}
            </>
          )}
        />
      </div>
    </>
  ) : null;

  const errorText = lastError
    ? `${lastError.nodeId ? `[${lastError.nodeId}] ` : ''}${lastError.message ?? lastError.error ?? 'Erro na execução'}`
    : runner.lastRunError ?? '';
  const errorCard = errorText ? (
    <ChatCard
      kind="error"
      nodeId={lastError?.nodeId ?? 'runner'}
      role="Erro"
      tag={lastError?.nodeId ? (names.get(lastError.nodeId)?.label ?? lastError.nodeId) : 'Execução'}
      tagType="red"
      accent="var(--cds-support-error)"
      icon={<ErrorFilled size={16} />}
      ts={typeof lastError?._uiTs === 'number' ? lastError._uiTs : undefined}
      ariaLabel="Erro na execução"
      body={<div className="live-chat-entry-text">{errorText}</div>}
    />
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
    const flowNodeIds = new Set(flow.nodes.map((n) => n.id));
    for (const g of runner.gates) {
      active.add(g.nodeId);
      if (flowNodeIds.has('gate_humano')) active.add('gate_humano');
    }
    for (const s of runner.agentSteps.slice(-4)) {
      if (s.phase === 'calling') {
        active.add(s.nodeId);
        if (flowNodeIds.has('decisor_d1')) active.add('decisor_d1');
        const mapped = TOOL_TO_NODE_ID[s.tool]
          ?? (s.tool.includes('mcp') && flowNodeIds.has('tool_mcp') ? 'tool_mcp' : undefined)
          ?? flow.nodes.find((n) => n.id === s.tool || n.params?.toolName === s.tool)?.id;
        if (mapped && flowNodeIds.has(mapped)) active.add(mapped);
      }
    }
    const recentAudit = runner.audit.slice(-3);
    for (const a of recentAudit) {
      if (a.op === 'goal_validation' && flowNodeIds.has('validador_objetivo')) {
        active.add('validador_objetivo');
      }
      if (a.risk != null && flowNodeIds.has('decisor_d1')) {
        active.add('decisor_d1');
      }
    }
    const recentEvents = runner.events.slice(-6);
    for (let i = recentEvents.length - 1; i >= 0; i--) {
      const ev = recentEvents[i] as { type?: string; nodeId?: string };
      if (ev.nodeId && (ev.type === 'caption' || ev.type === 'agent_step' || ev.type === 'gate' || ev.type === 'node_started' || ev.type === 'decision' || ev.type === 'goal_validation')) {
        active.add(ev.nodeId);
        if (ev.nodeId === 'decisor_d1' || ev.nodeId === 'gate_humano' || ev.nodeId === 'validador_objetivo') {
          active.add(ev.nodeId);
        }
        if (active.size >= 4) break;
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
  }, [runner.running, runner.gates, runner.agentSteps, runner.audit, runner.events, flow.nodes]);

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

  const metricsByNode: Record<string, string> = {};
  for (const s of stages) {
    const mm = stageMetrics(s);
    const parts = [mm.ctx, mm.tps, mm.time].filter((v) => v && v !== '—');
    if (parts.length > 0) metricsByNode[s.nodeId] = parts.join(' · ');
  }

  const renderConversationEntry = (m: ConversationEntry) => {
    // Nome exibido = nome do COMPONENTE (display name do nó, ADR-011), não um
    // rótulo genérico por tipo. 'Você' é a única exceção (mensagem do humano).
    const role = m.kind === 'user' ? 'Você' : (m.title || m.subtitle || '—');
    const tag = m.tag ?? m.subtitle;
    let tagType: ChatTagType = 'gray';
    let accent = 'var(--cds-support-info)';
    let icon = <User size={18} />;
    if (m.kind === 'stt') {
      tagType = 'cyan'; accent = 'var(--cds-support-info)'; icon = <Microphone size={18} />;
    } else if (m.kind === 'agent') {
      tagType = 'green'; accent = 'var(--cds-support-success-inverse)'; icon = <Bot size={18} />;
    } else if (m.kind === 'audio') {
      tagType = 'blue'; accent = 'var(--cds-interactive)'; icon = <VolumeUp size={18} />;
    } else if (m.kind === 'thought' || m.kind === 'decision') {
      tagType = m.kind === 'decision' ? 'blue' : 'purple';
      accent = 'var(--cds-support-purple, var(--cds-interactive))'; icon = <Router size={18} />;
    } else if (m.kind === 'agent-step') {
      tagType = 'warm-gray'; accent = 'var(--cds-support-info)'; icon = <Terminal size={18} />;
    }
    const meta = metricsByNode[m.nodeId] ? (
      <span className="live-chat-metrics" title="Contexto / Tokens por segundo / Tempo">
        {metricsByNode[m.nodeId]}
      </span>
    ) : undefined;
    const style = { ['--accent' as string]: accent };
    if (m.kind === 'thought') {
      return (
        <ChatCard
          key={m.id}
          kind="thought"
          nodeId={m.nodeId}
          role={role}
          tag={tag}
          tagType={tagType}
          accent={accent}
          icon={icon}
          ts={m.ts}
          meta={meta}
          body={<span className="live-chat-entry-text" title={m.text}>{m.text}</span>}
        />
      );
    }
    if (m.kind === 'goal-validation' && m.auditEvent) {
      const ev = m.auditEvent;
      const v = ev.validation;
      const isMaxSteps = ev.op === 'agent_final' && ev.maxStepsReached;
      const achieved = Boolean(v?.achieved);
      return (
        <ChatCard
          key={m.id}
          kind="goal-validation"
          nodeId={m.nodeId}
          role="Validação de Objetivo"
          tag={m.tag ?? (achieved ? 'Atingido' : 'Pendente')}
          tagType={achieved ? 'green' : isMaxSteps ? 'red' : 'magenta'}
          accent={achieved ? 'var(--cds-support-success)' : isMaxSteps ? 'var(--cds-support-error)' : 'var(--cds-support-warning)'}
          icon={achieved ? <Checkmark size={18} /> : isMaxSteps ? <ErrorFilled size={18} /> : <Bot size={18} />}
          ts={m.ts}
          aiLabel={true}
          ariaLabel="Validação de Objetivo"
          body={(
            <span className="live-chat-entry-text" title={m.text}>
              {v
                ? `${v.achieved ? 'atingido' : 'pendente'} · confiança ${Math.round(v.confidence * 100)}% · lacunas: ${v.gaps.length ? v.gaps.join('; ') : 'nenhuma'}`
                : (ev.text || 'Limite de passos atingido')}
            </span>
          )}
        />
      );
    }
    if (m.kind === 'gate-history') {
      const status = m.gateStatus ?? 'Aprovado';
      return (
        <ChatCard
          key={m.id}
          kind="gate-history"
          nodeId={m.nodeId}
          role="Aprovação"
          tag={status}
          tagType={status === 'Aprovado' ? 'green' : status === 'Editado' ? 'cyan' : 'red'}
          accent={status === 'Rejeitado' ? 'var(--cds-support-error)' : 'var(--cds-support-success)'}
          icon={status === 'Rejeitado' ? <Close size={16} /> : <Checkmark size={16} />}
          ts={m.ts}
          ariaLabel={`Gate ${status}`}
          onOpenAudit={() => openAuditFor(m.nodeId)}
          body={(
            <>
              {m.gateTool && <Tag type="teal" size="sm">Tool: {m.gateTool}</Tag>}
              {m.gateHost && <Tag type="cyan" size="sm">Host: {m.gateHost}</Tag>}
              <code className="live-chat-entry-code" title={m.text}>{m.text}</code>
            </>
          )}
        />
      );
    }
    const isExecStep = m.kind === 'agent-step' && Boolean(m.tool && (m.tool.startsWith('exec_') || m.tool.includes('mcp')));
    const isStructuredSearch = m.kind === 'agent-step' && Boolean(
      m.tool && (
        m.tool === 'rag.search' || m.tool === 'rag_search' ||
        m.tool === 'tool.web_search' || m.tool === 'tool_web_search' ||
        m.tool === 'tool.crawler' || m.tool === 'tool_crawler'
      )
    );
    const searchArgs = m.agentStep?.args;
    return (
      <ChatCard
        key={m.id}
        kind={m.kind}
        nodeId={m.nodeId}
        role={role}
        tag={tag}
        tagType={tagType}
        accent={accent}
        icon={icon}
        ts={m.ts}
        meta={meta}
        aiLabel={m.kind === 'agent' || m.kind === 'decision'}
        onOpenAudit={m.kind === 'agent-step' || m.kind === 'decision' ? () => openAuditFor(m.nodeId) : undefined}
        body={(
          <>
            <span className="live-chat-entry-text" title={m.text}>
              {m.text}
              {m.live && <span className="live-cursor" />}
            </span>
            {(isExecStep || (isStructuredSearch && searchArgs && Object.keys(searchArgs).length > 0)) && (
              <Button
                kind="ghost"
                size="sm"
                hasIconOnly
                renderIcon={Terminal}
                iconDescription="Abrir no Console"
                onClick={openConsole}
              />
            )}
          </>
        )}
      />
    );
  };

  const openPanelPopout = (panel: PopoutPanel) => { openPopout(panel, currentFlow); };

  const liveBody = (
      <div className="live2-body">
        <main className="live2-main">
          {!popout && (
            <div className="live2-popout-bar">
              <Button
                kind="ghost"
                size="sm"
                hasIconOnly
                renderIcon={Launch}
                iconDescription="Abrir conversa em janela"
                tooltipPosition="bottom"
                onClick={() => openPanelPopout('chat')}
              />
            </div>
          )}
          <>
              <div className="live-chat">
                {(gate || runner.running) && (
                  <p className="live-chat-empty" style={{ marginTop: '-0.25rem' }}>{turnStatus.hint}</p>
                )}
                {latestPlan && (
                  <div className="live-plan-panel">
                    <ContainedList
                      size="sm"
                      kind="on-page"
                      label={`Plano de execução (${latestPlan.filter((p) => p.status === 'verified').length}/${latestPlan.length} verificados)`}
                    >
                      {latestPlan.map((p) => (
                        <ContainedListItem
                          key={p.id}
                          action={
                            <IconIndicator
                              kind={p.status === 'verified' ? 'succeeded' : p.status === 'failed' ? 'failed' : 'in-progress'}
                              label={p.status === 'verified' ? 'verificado' : p.status === 'failed' ? 'falhou' : 'pendente'}
                              size={16}
                            />
                          }
                        >
                          <span className="live-plan-item">
                            <strong>{p.description}</strong>
                            <span className="live-plan-verify">
                              {p.verification}{p.evidence ? ` · evidência: ${p.evidence}` : ''}
                            </span>
                          </span>
                        </ContainedListItem>
                      ))}
                    </ContainedList>
                  </div>
                )}
                <div className="live-chat-log" ref={chatLogRef}>
                  {conversation.length === 0 && !liveAgent && !gateCard && !errorCard && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem' }}>
                      <p className="live-chat-empty" style={{ margin: 0 }}>
                        {runner.running ? 'Envie uma mensagem para conversar com o agente.' : 'Inicie a sessão para conversar com o agente.'}
                      </p>
                      {inputMode === 'chat' && !runner.running && (
                        <>
                          {SUGGESTED_PROMPTS.map((p) => (
                            <Button
                              key={p}
                              kind="ghost"
                              size="sm"
                              onClick={() => setChatInput(p)}
                            >
                              {p}
                            </Button>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                  {conversation.map(renderConversationEntry)}
                  {gateCard}
                  {errorCard}
                </div>
                {runner.testMode && !runner.running && (
                  <section className="live-test-checklist" aria-label="Resultado do teste">
                    <strong>Resultado do teste</strong>
                    <ul>
                      {flow.nodes.map((n) => {
                        const hadError = runner.events.some((e) => e.type === 'node_error' && e.nodeId === n.id);
                        return (
                          <li key={n.id}>
                            {hadError ? '✗' : '✓'} {n.id} ({n.type})
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                )}
                {inputMode === 'chat' && (
                  <div className="live-chat-input">
                    <TextInput
                      id="live-chat-input"
                      labelText="Mensagem"
                      hideLabel
                      size="sm"
                      placeholder={runner.running ? chatPlaceholder : 'Inicie a sessão para conversar...'}
                      value={chatInput}
                      disabled={!runner.running || sendingChat || !chatNode}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleSendChat();
                        }
                      }}
                    />
                    <Button
                      kind="primary"
                      size="sm"
                      renderIcon={Play}
                      disabled={!runner.running || sendingChat || !chatInput.trim() || !chatNode}
                      onClick={() => void handleSendChat()}
                    >
                      Enviar
                    </Button>
                  </div>
                )}
              </div>
            </>
        </main>
      </div>
  );

  const logsPanel = (
      <LogsPanel
        forceView={
          popout === 'terminal'
            ? 'terminal'
            : popout === 'audit'
              ? 'audit'
              : popout === 'logs' || popout === 'log'
                ? 'logs'
                : undefined
        }
        forceService={popout === 'log' ? popoutServiceId : popout === 'terminal' ? popoutServiceId : undefined}
        onPopout={popout ? undefined : openPanelPopout}
        onLogPopout={popout ? undefined : (svc) => { openPopout('log', currentFlow, { serviceId: svc }); }}
        flowNodes={flow.nodes}
        onServiceStatus={onServiceStatus}
        turnStatus={turnStatus}
        approvalLevel={flow.approvalLevel}
        onSetApprovalLevel={onSetApprovalLevel}
        resetSignal={resetSignal}
        thoughtsOn={showThoughts}
        thoughts={runner.thoughts}
        onToggleThoughts={(next) => {
          setShowThoughts(next);
          try { localStorage.setItem(THOUGHTS_STORAGE_KEY, String(next)); } catch { /* ignore */ }
        }}
        hasAgent={hasAgent}
        onOpenConsole={openConsole}
        audit={runner.audit}
        auditFocus={auditFocus}
        executions={runner.executions}
        gates={runner.gates}
        onApproveGate={(g, text) => {
          void gateAction(g.nodeId, text);
        }}
        onRejectGate={(g, reason) => {
          void gateAction(g.nodeId, null, reason);
        }}
      />
  );

  if (popout) {
    return (
      <div className={`live2 live2--popout live2--popout-${popout}`}>
        {popout === 'chat' ? (
          liveBody
        ) : popout === 'terminal' ? (
          <>
            {logsPanel}
            {inputMode === 'chat' && (
              <div className="live-chat-input">
                <TextInput
                  id="live-chat-input"
                  labelText="Mensagem"
                  hideLabel
                  size="sm"
                  placeholder={runner.running ? chatPlaceholder : 'Inicie a sessão para conversar...'}
                  value={chatInput}
                  disabled={!runner.running || sendingChat || !chatNode}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSendChat();
                    }
                  }}
                />
                <Button
                  kind="primary"
                  size="sm"
                  renderIcon={Play}
                  disabled={!runner.running || sendingChat || !chatInput.trim() || !chatNode}
                  onClick={() => void handleSendChat()}
                >
                  Enviar
                </Button>
              </div>
            )}
          </>
        ) : logsPanel}
      </div>
    );
  }

  return (
      <div className="live2">
        {runner.testMode && (
          <div className="live2-test-banner">
            ⚠ MODO TESTE — dryRun forçado, nenhum comando real será executado
          </div>
        )}
        <header className="live2-top">
        <div className="live2-left-controls">
          <div className="live2-workflow-col">
            <div className="nav-mode-tabs" role="group" aria-label="Modo da interface">
              <Button kind="tertiary" size="sm" onClick={onGoBuilder}>
                Builder
              </Button>
              <Button kind="primary" size="sm" aria-current="page">
                Runner
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
                kind={inputMode === 'chat' ? 'danger--tertiary' : 'tertiary'}
                size="sm"
                hasIconOnly
                renderIcon={inputMode === 'chat' ? MicrophoneOff : Microphone}
                aria-pressed={inputMode !== 'chat'}
                iconDescription={!hasInput ? 'Workflow sem entrada' : inputMode === 'chat' ? 'Usar voz' : 'Usar chat'}
                tooltipPosition="bottom"
                disabled={!hasInput}
                onClick={onToggleMicMute}
              />
              <Button
                kind={outputMode === 'write' ? 'danger--tertiary' : 'tertiary'}
                size="sm"
                hasIconOnly
                renderIcon={outputMode === 'write' ? VolumeMute : VoiceActivate}
                aria-pressed={outputMode === 'speak'}
                iconDescription={!hasOutput ? 'Workflow sem saída (Output)' : (outputMode === 'speak' ? 'Só escrever' : 'Falar')}
                tooltipPosition="bottom"
                disabled={!hasOutput}
                onClick={onToggleOutputMode}
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

      {stageGroups.length > 0 && (
        <section className="live2-stages-bar" aria-label="Parâmetros e métricas por etapa">
          <div className="live2-stages">
            {stageGroups.map((grp) => {
              const selId = selectedByGroup[grp.label];
              const s = grp.instances.find((i) => i.nodeId === selId)
                ?? grp.instances.find((i) => i.nodeId === grp.defaultNodeId)
                ?? grp.instances[0];
              const instanceItems: Item[] = grp.instances.map((i) => ({
                id: i.nodeId,
                label: String(i.number),
              }));
              const items = stageItems(s, models, apps);
              const primaryValue = s.kind === 'model-translate' && (!s.value || s.value === '—') ? '-' : s.value;
              const selectedId = s.kind === 'app' && s.param === 'backend'
                ? (s.isDefault ? inputMode : s.value)
                : s.kind === 'output-mode'
                  ? (s.isDefault ? outputMode : s.value)
                  : primaryValue;
              const isDual = Boolean(s.secondaryParam);
              const langItems = isDual
                ? s.secondaryKind === 'transport'
                  ? [{ id: 'local', label: 'Local' }, { id: 'ssh', label: 'SSH' }]
                  : supportedLanguagesForModel(
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
                <div key={grp.key} className={`stage-dd ${isDual ? 'stage-dd--triple' : 'stage-dd--dual'}`} style={{ ['--accent' as string]: grp.accent }}>
                  <span className="stage-dd-label">
                    {grp.label}
                    {grp.solution && (
                      <span className="stage-dd-solution">{grp.solution}</span>
                    )}
                  </span>
                  <div className={`stage-dd-ctrl ${isDual ? 'stage-dd-ctrl--triple' : 'stage-dd-ctrl--dual'}`}>
                    <Dropdown
                      id={`stage-inst-${grp.key}`}
                      className="stage-inst-select"
                      size="sm"
                      titleText={`${grp.label} instância`}
                      hideLabel
                      label={`${grp.label} instância`}
                      items={instanceItems}
                      itemToString={(it) => (it ? it.label : '')}
                      selectedItem={instanceItems.find((i) => i.id === s.nodeId) ?? instanceItems[0]}
                      onChange={({ selectedItem }) => selectedItem && setSelectedByGroup((prev) => ({ ...prev, [grp.label]: selectedItem.id }))}
                    />
                    <Dropdown
                      id={`stage-${s.key}`}
                      className="stage-main-select"
                      size="sm" titleText={grp.label} hideLabel label={grp.label}
                      items={items} itemToString={(it) => (it ? it.label : '')}
                      selectedItem={items.find((i) => i.id === selectedId) ?? items[0]}
                      onChange={({ selectedItem }) => selectedItem && selectedItem.id !== '—' && onUpdateStage(s.nodeId, s.param, selectedItem.id)}
                    />
                    {s.secondaryParam && (
                      <Dropdown
                        id={`stage-${s.key}-sec`}
                        className={`stage-sec-select ${s.secondaryParam === 'transport' ? 'stage-sec-select--ssh' : ''}`}
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
                </div>
              );
            })}
          </div>
        </section>
      )}

      {liveBody}

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
                  <div className="ctx-chips">
                    {d.tags.map((t, i) => <Tag key={i} type="cool-gray" size="sm">{t}</Tag>)}
                  </div>
                )}
                {d.points.length > 0 && <ul className="ctx-points">{d.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
              </div>
              <Button
                kind="ghost"
                size="sm"
                hasIconOnly
                renderIcon={TrashCan}
                iconDescription="Remover documento"
                tooltipPosition="left"
                className="ctx-doc-remove"
                onClick={() => onRemoveDoc(d.name)}
              />
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

      {logsPanel}

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
