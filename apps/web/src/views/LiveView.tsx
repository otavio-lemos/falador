// Tela de EXECUÇÃO — LIVE MODE + latência com breakdown + DRY-RUN/EXEC ATIVO + Limpar contexto +
// Exportar sessão (.md / webhook) + card rico de aprovação (comandos/host/risco d1) +
// sidebar de Documentos/Runbooks (RAG BM25 com tags e chunks).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Dropdown,
  Modal,
  Tag,
  TextArea,
  TextInput,
  Toggletip,
  ToggletipButton,
  ToggletipContent,
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
  Warning,
  Information,
  Microphone,
  Add,
  TrashCan,
  Download,
  Reset,
  Terminal,
} from '@carbon/icons-react';
import type { Runner, Gate, AgentStep } from '../useRunner';
import { exportSession, fetchLogs, fetchTopics, resetHistory, type Flow, type ContextDoc } from '../api';
import { deriveStages, classifySinks, shortModel, isTextModel, isAsrModel, type Stage } from '../live-utils';
import { LANGS } from '../data';

const WEBHOOK_STORAGE_KEY = 'falador.webhookUrl';

const LOG_SERVICES = [
  { id: 'omlx', label: 'LLM (omlx :8080)' },
  { id: 'asr', label: 'ASR (:8090)' },
  { id: 'tts', label: 'TTS (:8091)' },
  { id: 'web', label: 'Host/UI (:8787)' },
];

interface Props {
  runner: Runner;
  flow: Flow;
  scenarioName: string;
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
  onNotify?: (msg: string) => void;
  onExit: () => void;
}

interface Item { id: string; label: string }

function stageItems(stage: Stage, models: { omlx: string[]; cache: string[] }, apps: string[]): Item[] {
  if (stage.kind === 'gate') return [{ id: 'humano', label: 'Manual' }, { id: 'auto', label: 'Auto' }];
  if (stage.kind === 'voice') return [{ id: 'female', label: 'Feminino' }, { id: 'male', label: 'Masculino' }];
  if (stage.kind === 'language') return LANGS.map((l) => ({ id: l.val, label: l.label }));
  let vals: string[] = [];
  if (stage.kind === 'app') vals = apps.length ? apps : [stage.value];
  else if (stage.kind === 'model-asr') vals = [...models.omlx, ...models.cache.filter((m) => !models.omlx.includes(m))].filter(isAsrModel);
  else if (stage.kind === 'model-llm') vals = models.omlx.filter(isTextModel);
  const items = vals.filter(Boolean).map((v) => ({ id: v, label: stage.kind.startsWith('model') ? shortModel(v) : v }));
  const validCurrent = stage.value && (stage.kind !== 'model-llm' || isTextModel(stage.value));
  if (validCurrent && !items.some((i) => i.id === stage.value)) {
    items.unshift({ id: stage.value, label: stage.kind.startsWith('model') ? shortModel(stage.value) : stage.value });
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
  runner, flow, scenarioName, models, apps, contextDocs,
  onUploadDoc, onRemoveDoc, onStart, flows, currentFlow,
  onSwitchFlow, onUpdateStage, onRegenerate, onRefreshApps, onNotify, onExit,
}: Props) {
  const stages = useMemo(() => deriveStages(flow), [flow]);
  const sinks = useMemo(() => classifySinks(flow), [flow]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [cmdDraft, setCmdDraft] = useState('');
  const [chatInput, setChatInput] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [topics, setTopics] = useState<string[]>([]);
  const [uploadTags, setUploadTags] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [webhookUrl, setWebhookUrl] = useState(() => {
    try { return localStorage.getItem(WEBHOOK_STORAGE_KEY) ?? ''; } catch { return ''; }
  });
  const fileRef = useRef<HTMLInputElement>(null);
  const logsRef = useRef<HTMLPreElement>(null);
  const [logService, setLogService] = useState('web');
  const [logs, setLogs] = useState<string[]>([]);

  // Logs dos 4 serviços residentes (logs/<nome>.log): poll do serviço selecionado no dropdown.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetchLogs(logService, 300);
        if (alive) setLogs(r.lines);
      } catch {
        if (alive) setLogs([`(falha ao ler logs/${logService}.log)`]);
      }
    };
    void load();
    const t = setInterval(() => void load(), 1500);
    return () => { alive = false; clearInterval(t); };
  }, [logService]);

  // auto-scroll do terminal para o fim
  useEffect(() => {
    const el = logsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

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
  const captureApp = stages.find((s) => s.kind === 'app')?.value ?? '—';

  // NADA FIXO: painéis e indicadores derivam dos nós presentes no workflow.
  const hasGate = flow.nodes.some(
    (n) => n.type === 'human.approve' || (n.type === 'agent.tools' && n.params.approvalPolicy !== 'never'),
  );
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

  const lastError = [...runner.events].reverse().find(
    (e) => e.type === 'node_error' && !String((e as { code?: string }).code ?? '').startsWith('log_'),
  ) as { message?: string; nodeId?: string } | undefined;

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

  const handleResetHistory = async () => {
    try {
      const r = await resetHistory('*');
      onNotify?.(r.sent ? 'Contexto conversacional limpo' : 'Nenhum run ativo para limpar contexto');
    } catch {
      onNotify?.('Falha ao limpar contexto');
    }
  };

  const chatNode = flow.nodes.find((n) => n.type === 'input.chat');
  const chatPlaceholder =
    (typeof chatNode?.params?.placeholder === 'string' && chatNode.params.placeholder.trim()) ||
    'Digite sua mensagem ou comando (Enter para enviar)...';

  // Conversa do CHAT (flow com nó input.chat): prompts do usuário + respostas FINAIS do
  // agente (captions de sugestão), intercalados por ts. A última legenda de sugestão ainda
  // não-final vira uma bolha de agente "ao vivo" no fim.
  const suggestionCaption = lastOf(sinks.suggestion);
  const liveAgent = suggestionCaption && !suggestionCaption.final && runner.running ? suggestionCaption : null;
  const conversation = useMemo(() => {
    const items: { role: 'user' | 'agent'; text: string; ts: number }[] = [];
    for (const m of runner.chatMessages) items.push({ role: 'user', text: m.text, ts: m.ts });
    for (const c of runner.captions) {
      if (c.final && sinks.suggestion.has(c.nodeId)) items.push({ role: 'agent', text: c.text, ts: c.ts });
    }
    return items.sort((a, b) => a.ts - b.ts);
  }, [runner.chatMessages, runner.captions, sinks.suggestion]);
  const chatLogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = chatLogRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.length, liveAgent?.text]);

  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text || !runner.running || sendingChat) return;
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

  // tópicos ao vivo: detecta da transcrição (debounce 2,5 s)
  useEffect(() => {
    if (!runner.running || transcription.trim().length < 20) return;
    const t = setTimeout(() => {
      fetchTopics(transcription).then((tp) => { if (tp.length) setTopics(tp); }).catch(() => {});
    }, 2500);
    return () => clearTimeout(t);
  }, [transcription, runner.running]);

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

  return (
    <div className="live2">
      <header className="live2-top">
        <div className="live2-mode">
          <span className={`live-dot${runner.running ? ' live-dot--on' : ''}`} />
          <span className="live2-mode-label">LIVE MODE</span>
          <span className="live2-scenario">— {scenarioName}</span>
          <div className="live-flow-select">
            <Dropdown
              id="live-flow" size="sm" titleText="Workflow" hideLabel label="Workflow"
              items={flows.map((f) => ({ id: f.name, label: f.name }))}
              itemToString={(it) => (it ? it.label : '')}
              selectedItem={flows.map((f) => ({ id: f.name, label: f.name })).find((i) => i.id === currentFlow) ?? null}
              onChange={({ selectedItem }) => selectedItem && onSwitchFlow(selectedItem.id)}
            />
          </div>
          {hasExec && (
            <Tag type={execActive ? 'red' : 'blue'} size="md" className="exec-mode-tag">
              {execActive ? 'EXEC ATIVO' : 'DRY-RUN'}
            </Tag>
          )}
        </div>

        <div className="live2-metrics-bar">
          <Toggletip align="bottom">
            <ToggletipButton label="Detalhes de latência por etapa" className="latency-trigger">
              <Tag type="green" size="md" className="latency-pill">
                Latência: {runner.latency != null ? `${Math.round(runner.latency)}ms` : '—'}
              </Tag>
            </ToggletipButton>
            <ToggletipContent>
              <div className="latency-breakdown">
                <div className="latency-breakdown-title">Latência do último turno</div>
                {bd ? (
                  <ul className="latency-breakdown-list">
                    {bd.asrMs != null && <li><span>ASR</span><strong>{bd.asrMs} ms</strong></li>}
                    {bd.turnMs != null && <li><span>Turn Detector</span><strong>{bd.turnMs} ms</strong></li>}
                    {bd.llmTtftMs != null && <li><span>LLM TTFT</span><strong>{bd.llmTtftMs} ms</strong></li>}
                    {bd.decisionMs != null && <li><span>Decisão d1</span><strong>{bd.decisionMs} ms</strong></li>}
                    {bd.totalMs != null && <li className="latency-total"><span>Total</span><strong>{bd.totalMs} ms</strong></li>}
                  </ul>
                ) : (
                  <p className="latency-empty">Aguardando trace do primeiro turno completo.</p>
                )}
              </div>
            </ToggletipContent>
          </Toggletip>
        </div>

        <div className="live2-top-actions">
          {hasLLM && (
            <Button kind="ghost" size="sm" renderIcon={Reset} onClick={handleResetHistory} title="Limpa memória conversacional do LLM sem reiniciar o fluxo">
              Limpar contexto
            </Button>
          )}
          <Button kind="ghost" size="sm" renderIcon={Download} onClick={() => { setExportResult(null); setExportOpen(true); }}>
            Exportar sessão
          </Button>
          <Button kind="secondary" size="sm" renderIcon={runner.running ? Pause : Play} onClick={() => (runner.running ? runner.stop() : onStart(flow))}>
            {runner.running ? 'Pausar' : 'Retomar'}
          </Button>
          <Button kind="danger" size="sm" renderIcon={Stop} onClick={onExit}>Encerrar Sessão</Button>
        </div>
      </header>

      <div className="live2-body">
        <main className="live2-main">
          {lastError && <div className="live2-error">⚠ [{lastError.nodeId}] {lastError.message}</div>}
          {!lastError && runner.lastRunError && <div className="live2-error">⚠ {runner.lastRunError}</div>}
          {isAssisted && (
            <>
              <div className="live2-label">{hasExec ? 'Solicitação por voz (transcrição ao vivo)' : 'Transcrição ao vivo (entrevistador)'}</div>
              <div className="live2-transcription">{transcription || (runner.running ? 'Ouvindo...' : '—')}</div>
            </>
          )}

          <div className="live2-stages">
            {stages.map((s) => {
              const items = stageItems(s, models, apps);
              return (
                <div key={s.key} className="stage-dd" style={{ ['--accent' as string]: s.accent }}>
                  <span className="stage-dd-label">{s.label}</span>
                  <Dropdown
                    id={`stage-${s.key}`} size="sm" titleText={s.label} hideLabel label={s.label}
                    items={items} itemToString={(it) => (it ? it.label : '')}
                    selectedItem={items.find((i) => i.id === s.value) ?? items[0]}
                    onChange={({ selectedItem }) => selectedItem && onUpdateStage(s.nodeId, s.param, selectedItem.id)}
                  />
                  {s.kind === 'app' && (
                    <Button kind="ghost" size="sm" hasIconOnly renderIcon={Renew} iconDescription="Recarregar apps" tooltipPosition="bottom" onClick={onRefreshApps} />
                  )}
                </div>
              );
            })}
          </div>

          {chatNode ? (
            <>
              {commandGateCard}
              {hasGate && gate && !gateInfo.isCommand && (
                <div className="live2-actions live-chat-gate-actions">
                  {editing ? (
                    <>
                      <TextArea labelText="Editar sugestão" hideLabel rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
                      <Button kind="primary" size="sm" renderIcon={Checkmark} onClick={approve}>Enviar editada</Button>
                      <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>Cancelar</Button>
                    </>
                  ) : (
                    <>
                      <Button kind="ghost" size="sm" renderIcon={Edit} onClick={startEdit}>Editar</Button>
                      <Button kind="primary" size="sm" renderIcon={Checkmark} className="approve-btn" onClick={approve}>
                        {hasTTS ? 'Aprovar & Falar' : 'Aprovar'}
                      </Button>
                      <Button kind="danger--tertiary" size="sm" renderIcon={Close} onClick={rejectGate}>Rejeitar</Button>
                    </>
                  )}
                </div>
              )}

              <div className="live-chat">
                <div className="live2-label">Conversa</div>
                <div className="live-chat-log" ref={chatLogRef}>
                  {conversation.length === 0 && !liveAgent && (
                    <p className="live-chat-empty">
                      {runner.running ? 'Envie uma mensagem para conversar com o agente.' : 'Inicie a sessão para conversar com o agente.'}
                    </p>
                  )}
                  {conversation.map((m, idx) => (
                    <div key={`${m.ts}-${idx}`} className={`live-chat-bubble live-chat-bubble--${m.role}`}>
                      <span className="live-chat-ts">{new Date(m.ts).toLocaleTimeString()}</span>
                      <span className="live-chat-text">{m.text}</span>
                    </div>
                  ))}
                  {liveAgent && (
                    <div className="live-chat-bubble live-chat-bubble--agent live-chat-bubble--live">
                      <span className="live-chat-ts">{new Date(liveAgent.ts).toLocaleTimeString()}</span>
                      <span className="live-chat-text">{liveAgent.text}<span className="live-cursor" /></span>
                    </div>
                  )}
                </div>
                <div className="live-chat-input">
                  <TextArea
                    id="live-chat-input"
                    labelText="Mensagem"
                    hideLabel
                    rows={2}
                    placeholder={runner.running ? chatPlaceholder : 'Inicie a sessão para enviar mensagens...'}
                    value={chatInput}
                    disabled={!runner.running || sendingChat}
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
                    disabled={!runner.running || sendingChat || !chatInput.trim()}
                    onClick={() => void handleSendChat()}
                  >
                    Enviar
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="live2-label">{heroLabel}</div>
              {commandGateCard ? commandGateCard : (
                <>
                  <div className="live2-suggestion">
                    {editing && hasGate ? (
                      <TextArea labelText="Editar sugestão" hideLabel rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
                    ) : (
                      <div className="live2-suggestion-text">
                        {heroText || (runner.running ? (isAssisted ? 'Gerando resposta...' : 'Aguardando áudio...') : 'Inicie a sessão.')}
                        {runner.running && !editing && <span className="live-cursor" />}
                      </div>
                    )}
                  </div>
                  {(hasLLM || hasGate) && (
                    <div className="live2-actions">
                      {hasLLM && <Button kind="ghost" size="sm" renderIcon={Renew} onClick={onRegenerate}>Regerar</Button>}
                      {hasGate && (editing ? (
                        <>
                          <Button kind="primary" size="sm" renderIcon={Checkmark} onClick={approve} disabled={!gate}>Enviar editada</Button>
                          <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>Cancelar</Button>
                        </>
                      ) : (
                        <>
                          <Button kind="ghost" size="sm" renderIcon={Edit} onClick={startEdit} disabled={!gate}>Editar</Button>
                          <Button kind="primary" size="sm" renderIcon={Checkmark} className="approve-btn" onClick={approve} disabled={!gate}>
                            {hasTTS ? 'Aprovar & Falar' : 'Aprovar'}
                          </Button>
                          {gate && (
                            <Button kind="danger--tertiary" size="sm" renderIcon={Close} onClick={rejectGate}>Rejeitar</Button>
                          )}
                        </>
                      ))}
                    </div>
                  )}
                  {hasGate && !gate && runner.running && (
                    <p className="live2-hint">Roteamento automático — sem gate humano pendente.</p>
                  )}
                </>
              )}
            </>
          )}

          {runner.agentSteps.length > 0 && (
            <section className="agent-timeline" aria-label="Passos do agente">
              <div className="live2-label">Passos do agente ({runner.agentSteps.length})</div>
              <div className="agent-timeline-list">
                {runner.agentSteps.map((s, idx) => {
                  const st = agentStepStatus(s);
                  return (
                    <div key={`${s.nodeId}-${s.step}-${s.phase}-${idx}`} className="agent-step-row">
                      <span className="agent-step-num">Passo {s.step}</span>
                      <code className="agent-step-tool">{s.tool}</code>
                      <Tag type={st.tagType} size="sm">{st.label}</Tag>
                      {typeof s.durationMs === 'number' && (
                        <span className="agent-step-dur">{Math.round(s.durationMs)} ms</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </main>

        <aside className="live2-side">
          <div className="live2-side-title">Documentos &amp; Runbooks (RAG)</div>

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
            <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => fileRef.current?.click()}>
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

          <div className="ctx-block">
            <div className="ctx-block-title">Tópicos detectados</div>
            <div className="ctx-chips">
              {topics.length
                ? topics.map((t, i) => <Tag key={i} type="purple" size="sm">{t}</Tag>)
                : <span className="ctx-empty">{runner.running ? 'detectando…' : 'aparecem durante a fala'}</span>}
            </div>
          </div>

          {isInterview && (
            <>
              <div className="ctx-block">
                <div className="ctx-block-title"><Information size={16} /> Dica de estrutura</div>
                <p className="ctx-text">Use o método <strong>STAR</strong> (Situação, Tarefa, Ação, Resultado) para responder.</p>
              </div>

              <div className="ctx-block ctx-block--warn">
                <div className="ctx-block-title"><Warning size={16} /> Pontos de atenção</div>
                <p className="ctx-text">Não fale mal de monolitos — cite os trade-offs.</p>
              </div>
            </>
          )}

          <div className="ctx-mic">
            <Microphone size={18} />
            <div className="ctx-mic-info">
              <div className="ctx-mic-name">Capturando: {captureApp}</div>
              <div className={`ctx-level${runner.running ? ' ctx-level--on' : ''}`}>
                {Array.from({ length: 12 }).map((_, i) => <span key={i} style={{ ['--i' as string]: i }} />)}
              </div>
            </div>
          </div>
        </aside>
      </div>

      <section className="logs-panel" aria-label="Logs dos serviços">
        <div className="logs-panel-head">
          <span className="logs-panel-title"><Terminal size={16} /> Logs dos serviços</span>
          <Dropdown
            id="logs-service-dd" size="sm" titleText="Serviço" hideLabel label="Serviço"
            items={LOG_SERVICES}
            itemToString={(it) => (it ? it.label : '')}
            selectedItem={LOG_SERVICES.find((s) => s.id === logService) ?? LOG_SERVICES[0]}
            onChange={({ selectedItem }) => setLogService(selectedItem?.id ?? 'web')}
          />
          <Tag type="green" size="sm">auto 1,5s</Tag>
          <span className="logs-panel-hint">logs/&lt;serviço&gt;.log · estilo terminal</span>
        </div>
        <pre ref={logsRef} className="logs-terminal">{logs.length ? logs.join('\n') : 'sem linhas ainda...'}</pre>
      </section>

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
