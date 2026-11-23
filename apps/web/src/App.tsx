// App — shell com duas telas (Criação | Execução). A criação usa a TopBar padrão;
// a execução (LiveView) tem header próprio (LIVE MODE). Estado de execução (useRunner)
// e o flow ao vivo são compartilhados; trocar uma etapa atualiza o param real e reinicia.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Theme, ToastNotification } from '@carbon/react';
import { ReactFlowProvider } from '@xyflow/react';
import { TopBar } from './components/TopBar';
import { BuilderView } from './views/BuilderView';
import { LiveView } from './views/LiveView';
import { useRunner } from './useRunner';
import { fetchCatalog, fetchFlows, fetchFlow, fetchModels, fetchApps, fetchContext, saveFlow, deleteFlow, uploadDoc, removeDoc, clearLogs, resetHistory, type Catalog, type Flow, type ContextDoc, type ServiceStatusMap } from './api';
import { applyContext, inferOutputLanguage, isDecisionModel, resolveDefaultNodeId, sanitizeFlow } from './live-utils';

type InputMode = 'apps' | 'mic' | 'chat';
type OutputMode = 'write' | 'speak';

function readSavedInputMode(): InputMode | null {
  try {
    const v = localStorage.getItem('falador.inputMode');
    if (v === 'apps' || v === 'mic' || v === 'chat') return v;
  } catch { /* ignore */ }
  return null;
}

function readSavedOutputMode(): OutputMode | null {
  try {
    const v = localStorage.getItem('falador.outputMode');
    if (v === 'write' || v === 'speak') return v;
  } catch { /* ignore */ }
  return null;
}

function modeFromFlow(f: Flow): InputMode {
  const defId = resolveDefaultNodeId(f, 'capture.ffmpeg');
  const cap = (defId ? f.nodes.find((n) => n.id === defId) : undefined) ?? f.nodes.find((n) => n.type === 'capture.ffmpeg');
  if (cap) {
    const backend = String(cap.params?.backend ?? 'sck');
    if (backend === 'chat' || cap.params?.muted === true || cap.enabled === false) return 'chat';
    if (backend === 'sounddevice') return 'mic';
    return 'apps';
  }
  if (f.nodes.some((n) => n.type === 'input.chat')) return 'chat';
  return 'apps';
}

function outputModeFromFlow(f: Flow): OutputMode {
  const defId = resolveDefaultNodeId(f, 'sink.captions');
  const out = (defId ? f.nodes.find((n) => n.id === defId) : undefined) ?? f.nodes.find((n) => n.type === 'sink.captions');
  if (out) return out.params?.outputMode === 'speak' ? 'speak' : 'write';
  return 'write';
}

function scenarioLabel(name: string): string {
  if (name === 'agente-workflows') return 'Agente de Workflows';
  if (name.includes('entrevista') || name.startsWith('cenario2')) return 'Entrevista Técnica';
  if (name.includes('ops') || name.includes('servidor')) return 'Ops / Revisão de Servidor';
  if (name.includes('traducao') || name.includes('transcricao') || name.includes('tradutor')) return 'Tradução / Transcrição';
  if (name.includes('legendas') || name.startsWith('cenario1')) return 'Legendas ao vivo';
  if (name.includes('transcricao')) return 'Transcrição ao vivo';
  if (name.includes('tradutor-voz')) return 'Tradutor de voz';
  return name || 'Sessão';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function App() {
  const [view, setView] = useState<'builder' | 'live'>('builder');
  const [theme, setTheme] = useState<'g100' | 'white'>(() => {
    try { return localStorage.getItem('falador.theme') === 'white' ? 'white' : 'g100'; } catch { return 'g100'; }
  });
  const [inputMode, setInputMode] = useState<InputMode>(() => readSavedInputMode() ?? 'apps');
  const lastVoiceModeRef = useRef<'apps' | 'mic'>(inputMode === 'mic' ? 'mic' : 'apps');
  const [outputMode, setOutputMode] = useState<OutputMode>(() => readSavedOutputMode() ?? 'write');
  const [inputResetTick, setInputResetTick] = useState(0);
  const [outputResetTick, setOutputResetTick] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [flows, setFlows] = useState<{ name: string; description: string }[]>([]);
  const [currentFlow, setCurrentFlow] = useState('');
  const [readyFlow, setReadyFlow] = useState<string | null>(null);
  const [editFlowOpen, setEditFlowOpen] = useState(false);
  const [liveFlow, setLiveFlow] = useState<Flow | null>(null);
  const [models, setModels] = useState<{ omlx: string[]; cache: string[] }>({ omlx: [], cache: [] });
  const [apps, setApps] = useState<string[]>([]);
  const [contextDocs, setContextDocs] = useState<ContextDoc[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const runner = useRunner();
  const actionsRef = useRef<{ getFlow: () => Flow; save: () => void } | null>(null);
  const seenAgentStepsRef = useRef(0);
  const lastOmlxUpRef = useRef<boolean | null>(null);
  const modelsRef = useRef(models);
  modelsRef.current = models;

  const handleServiceStatus = useCallback((status: ServiceStatusMap) => {
    const wasUp = lastOmlxUpRef.current;
    lastOmlxUpRef.current = status.omlx;
    if (status.omlx && (wasUp === false || (wasUp === null && modelsRef.current.omlx.length === 0))) {
      fetchModels().then(setModels).catch(() => {});
    }
  }, []);

  const toggleTheme = () => {
    setTheme((cur) => {
      const next = cur === 'g100' ? 'white' : 'g100';
      try { localStorage.setItem('falador.theme', next); } catch { /* ignore */ }
      return next;
    });
  };

  useEffect(() => {
    fetchCatalog().then(setCatalog).catch(() => setToast('Falha ao carregar catálogo'));
    fetchFlows().then((fs) => {
      setFlows(fs);
      setCurrentFlow((cur) => cur || (fs.find((f) => f.name === 'assistente-entrevista') ?? fs[0])?.name || '');
    }).catch(() => setToast('Falha ao listar flows'));
    fetchModels().then(setModels).catch(() => {});
    fetchApps().then(setApps).catch(() => {});
    fetchContext().then(setContextDocs).catch(() => {});
  }, []);

  const registerActions = useCallback((a: { getFlow: () => Flow; save: () => void }) => { actionsRef.current = a; }, []);
  const handleFlowLoaded = useCallback((name: string | null) => { setReadyFlow(name); }, []);
  const refreshFlows = useCallback(() => { fetchFlows().then(setFlows).catch(() => {}); }, []);

  // Atualiza automaticamente o dropdown de workflows quando o agente salvar ou remover um workflow
  useEffect(() => {
    const steps = runner.agentSteps;
    if (steps.length < seenAgentStepsRef.current) {
      seenAgentStepsRef.current = 0;
    }
    const fresh = steps.slice(seenAgentStepsRef.current);
    seenAgentStepsRef.current = steps.length;
    if (
      fresh.some(
        (s) =>
          s.phase === 'result' &&
          s.ok === true &&
          (s.tool === 'workflow_save' || s.tool === 'workflow_delete'),
      )
    ) {
      refreshFlows();
    }
  }, [runner.agentSteps, refreshFlows]);

  const applyInputMode = (f: Flow, mode: InputMode, targetNodeId?: string): Flow => {
    const targetId = targetNodeId ?? resolveDefaultNodeId(f, 'capture.ffmpeg');
    const asrTurnTypes = new Set(['asr.realtime', 'asr.lfm3', 'turn.detector']);
    const asrTurnIds = new Set(f.nodes.filter((n) => asrTurnTypes.has(n.type)).map((n) => n.id));
    const voiceOnlySinkIds = new Set<string>();
    for (const n of f.nodes) {
      if (n.type !== 'sink.captions') continue;
      const incoming = f.edges.filter((e) => e.to.split('.')[0] === n.id);
      if (incoming.length > 0 && incoming.every((e) => asrTurnIds.has(e.from.split('.')[0]))) {
        voiceOnlySinkIds.add(n.id);
      }
    }
    const updatedInputs = f.nodes.map((n) => {
      if (n.type === 'capture.ffmpeg' && (!targetId || n.id === targetId)) {
        const params: Record<string, unknown> = { ...n.params };
        delete params.muted;
        if (mode === 'chat') {
          params.backend = 'chat';
        } else if (mode === 'mic') {
          params.backend = 'sounddevice';
          params.input = '';
        } else {
          params.backend = 'sck';
          params.input = '';
        }
        return { ...n, enabled: true, params };
      }
      return n;
    });
    const voiceOn = updatedInputs.some(
      (n) => n.type === 'capture.ffmpeg' && n.enabled !== false && n.params?.backend !== 'chat' && n.params?.muted !== true,
    );
    return {
      ...f,
      nodes: updatedInputs.map((n) => {
        if (n.type === 'input.chat') {
          return { ...n, enabled: !voiceOn };
        }
        if (asrTurnIds.has(n.id) || voiceOnlySinkIds.has(n.id)) {
          return { ...n, enabled: voiceOn };
        }
        return n;
      }),
    };
  };

  const applyOutputMode = (f: Flow, mode: OutputMode, targetNodeId?: string): Flow => {
    const targetId = targetNodeId ?? resolveDefaultNodeId(f, 'sink.captions');
    return {
      ...f,
      nodes: f.nodes.map((n) => {
        if (n.type === 'sink.captions' && (!targetId || n.id === targetId)) {
          const nextParams: Record<string, unknown> = { ...n.params, outputMode: mode };
          if (mode === 'speak' && (!nextParams.language || typeof nextParams.language !== 'string')) {
            nextParams.language = inferOutputLanguage(f, n.id);
          }
          return { ...n, params: nextParams };
        }
        if (n.type === 'sink.playback' || n.type === 'tts.sts') {
          return { ...n, params: { ...n.params, muted: mode === 'write' } };
        }
        return n;
      }),
    };
  };

  const onTest = () => {
    const f = actionsRef.current?.getFlow();
    if (!f) return;
    if (f.nodes.length === 0) {
      setToast('Adicione pelo menos um nó antes de testar');
      return;
    }
    runner.start(applyContext(sanitizeFlow(f), contextDocs), currentFlow);
  };
  const startWithContext = (f: Flow, name?: string) =>
    runner.start(applyContext(sanitizeFlow(f), contextDocs), name ?? currentFlow);

  const setModeAndSync = (next: InputMode, baseFlow = liveFlow, targetNodeId?: string) => {
    const defId = baseFlow ? resolveDefaultNodeId(baseFlow, 'capture.ffmpeg') : null;
    const isDefault = !targetNodeId || !defId || targetNodeId === defId;
    if (isDefault) {
      if (next !== 'chat') lastVoiceModeRef.current = next;
      setInputMode(next);
      try { localStorage.setItem('falador.inputMode', next); } catch { /* ignore */ }
    }
    if (baseFlow) {
      const updated = applyInputMode(baseFlow, next, targetNodeId);
      setLiveFlow(updated);
      if (runner.running) startWithContext(updated, currentFlow);
    }
  };

  const setOutputModeAndSync = (next: OutputMode, baseFlow = liveFlow, targetNodeId?: string) => {
    const defId = baseFlow ? resolveDefaultNodeId(baseFlow, 'sink.captions') : null;
    const isDefault = !targetNodeId || !defId || targetNodeId === defId;
    if (isDefault) {
      setOutputMode(next);
      try { localStorage.setItem('falador.outputMode', next); } catch { /* ignore */ }
    }
    if (baseFlow) {
      const updated = applyOutputMode(baseFlow, next, targetNodeId);
      setLiveFlow(updated);
      if (runner.running) startWithContext(updated, currentFlow);
    }
  };

  const onToggleInputMode = () => {
    const defId = liveFlow ? resolveDefaultNodeId(liveFlow, 'capture.ffmpeg') ?? undefined : undefined;
    setInputResetTick((n) => n + 1);
    if (inputMode === 'chat') {
      setModeAndSync(lastVoiceModeRef.current, liveFlow, defId);
    } else {
      lastVoiceModeRef.current = inputMode;
      setModeAndSync('chat', liveFlow, defId);
    }
  };
  const onToggleOutputMode = () => {
    const defId = liveFlow ? resolveDefaultNodeId(liveFlow, 'sink.captions') ?? undefined : undefined;
    setOutputResetTick((n) => n + 1);
    const next: OutputMode = outputMode === 'speak' ? 'write' : 'speak';
    setOutputModeAndSync(next, liveFlow, defId);
  };
  const onGoLive = () => {
    const f = actionsRef.current?.getFlow();
    if (!f) return;
    runner.stop();
    const initialMode = readSavedInputMode() ?? modeFromFlow(f);
    const initialOut = readSavedOutputMode() ?? outputModeFromFlow(f);
    if (initialMode !== 'chat') lastVoiceModeRef.current = initialMode;
    setInputMode(initialMode);
    setOutputMode(initialOut);
    setLiveFlow(applyOutputMode(applyInputMode(f, initialMode), initialOut));
    setView('live');
    fetchApps().then(setApps).catch(() => {});
    fetchModels().then(setModels).catch(() => {});
  };
  const onSave = () => { actionsRef.current?.save(); setToast('Workflow salvo'); };

  const onNewFlow = async () => {
    const name = `workflow-${Date.now()}`;
    const blank: Flow = { version: 1, nodes: [], edges: [], stopWhenSourcesDone: false, description: 'Novo workflow personalizado' };
    await saveFlow(name, blank);
    await refreshFlows();
    setCurrentFlow(name);
    setEditFlowOpen(true);
    setToast(`Workflow "${name}" criado`);
  };

  const onDuplicateFlow = async () => {
    const f = actionsRef.current?.getFlow();
    if (!f || !currentFlow) return;
    let copyName = `${currentFlow}-copia`;
    let i = 2;
    while (flows.some((x) => x.name === copyName)) copyName = `${currentFlow}-copia-${i++}`;
    await saveFlow(copyName, { ...f });
    await refreshFlows();
    setCurrentFlow(copyName);
    setToast(`Workflow duplicado como "${copyName}"`);
  };

  const onDeleteFlow = async () => {
    if (!currentFlow) return;
    if (!window.confirm(`Remover permanentemente o workflow "${currentFlow}"?`)) return;
    try {
      await deleteFlow(currentFlow);
      const remaining = await fetchFlows();
      setFlows(remaining);
      setCurrentFlow(remaining[0]?.name ?? '');
      setToast(`Workflow "${currentFlow}" removido`);
    } catch {
      setToast('Falha ao remover workflow');
    }
  };

  const onRename = async (newName: string, newDesc: string) => {
    const f = actionsRef.current?.getFlow();
    if (!f) return;
    const updated: Flow = { ...f, description: newDesc };
    await saveFlow(newName, updated, newName !== currentFlow ? currentFlow : undefined);
    setCurrentFlow(newName);
    await refreshFlows();
    setToast('Detalhes do workflow salvos');
  };

  const onUpdateStage = (nodeId: string, param: string, value: unknown) => {
    if (!liveFlow) return;
    const target = liveFlow.nodes.find((n) => n.id === nodeId);
    if (target?.type === 'capture.ffmpeg' && param === 'backend') {
      const mode: InputMode = value === 'mic' ? 'mic' : value === 'chat' ? 'chat' : 'apps';
      setModeAndSync(mode, liveFlow, nodeId);
      return;
    }
    if (target?.type === 'sink.captions' && param === 'outputMode') {
      const mode: OutputMode = value === 'speak' ? 'speak' : 'write';
      setOutputModeAndSync(mode, liveFlow, nodeId);
      return;
    }
    const next: Flow = {
      ...liveFlow,
      nodes: liveFlow.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const nextParams: Record<string, unknown> = { ...n.params, [param]: value };
        if (n.type === 'decision.llm' && param === 'model') {
          nextParams.mode = isDecisionModel(String(value)) ? 'systemone' : 'chat';
        }
        if (n.type === 'asr.lfm3' && param === 'targetLanguage') {
          delete nextParams.instruction;
        }
        if (n.type === 'llm.omlx' && param === 'targetLanguage') {
          delete nextParams.template;
        }
        return { ...n, params: nextParams };
      }),
    };
    setLiveFlow(next);
    if (runner.running) startWithContext(next);
  };
  const onRegenerate = () => { if (liveFlow && runner.running) startWithContext(liveFlow); };
  const onExit = () => { runner.stop(); };
  const onReset = async () => {
    runner.reset();
    await Promise.allSettled([clearLogs(), resetHistory('*')]);
    setResetSignal((n) => n + 1);
    setToast('Reset concluído — tela e logs limpos');
  };
  const onSwitchLiveFlow = async (name: string) => {
    try {
      const f = await fetchFlow(name);
      const m = modeFromFlow(f);
      const outM = outputModeFromFlow(f);
      if (m !== 'chat') lastVoiceModeRef.current = m;
      setInputMode(m);
      setOutputMode(outM);
      const updated = applyOutputMode(applyInputMode(f, m), outM);
      setCurrentFlow(name);
      setLiveFlow(updated);
      if (runner.running) startWithContext(updated, name);
    } catch { setToast('Falha ao carregar o flow'); }
  };

  const onOpenWorkflowAgent = async () => {
    try {
      const f = await fetchFlow('agente-workflows');
      runner.stop();
      const m = modeFromFlow(f);
      const outM = outputModeFromFlow(f);
      if (m !== 'chat') lastVoiceModeRef.current = m;
      setInputMode(m);
      setOutputMode(outM);
      setCurrentFlow('agente-workflows');
      setLiveFlow(applyOutputMode(applyInputMode(f, m), outM));
      setView('live');
      fetchApps().then(setApps).catch(() => {});
      fetchModels().then(setModels).catch(() => {});
    } catch {
      setToast('Falha ao abrir o Agente de Workflows');
    }
  };

  const onUploadDoc = async (file: File, tags?: string[]) => {
    try {
      const isPdf = file.name.toLowerCase().endsWith('.pdf');
      const payload = isPdf
        ? { pdfB64: await fileToBase64(file), tags }
        : { text: await file.text(), tags };
      setToast(`Indexando ${file.name}…`);
      await uploadDoc(file.name, payload);
      const docs = await fetchContext();
      setContextDocs(docs);
      setToast(`${file.name} indexado`);
    } catch (e) {
      setToast(`Falha: ${(e as Error).message}`);
    }
  };
  const onRemoveDoc = async (name: string) => {
    await removeDoc(name);
    setContextDocs(await fetchContext());
  };

  const currentDesc = flows.find((f) => f.name === currentFlow)?.description ?? '';

  return (
    <Theme theme={theme}>
      <div className="app" data-carbon-theme={theme}>
        {view === 'builder' && (
          <TopBar
            view={view}
            canGoLive={Boolean(catalog && currentFlow && readyFlow === currentFlow)}
            latencyMs={runner.latency} running={runner.running}
            theme={theme} onToggleTheme={toggleTheme}
            flows={flows} currentFlow={currentFlow}
            description={currentDesc}
            models={models}
            editOpen={editFlowOpen}
            onOpenEdit={() => setEditFlowOpen(true)}
            onCloseEdit={() => setEditFlowOpen(false)}
            onSelectFlow={setCurrentFlow} onSave={onSave}
            onRename={onRename} onNewFlow={onNewFlow}
            onDuplicateFlow={() => void onDuplicateFlow()}
            onDeleteFlow={() => void onDeleteFlow()}
            onTest={onTest} onGoLive={onGoLive}
            onGoBuilder={() => setView('builder')} onStop={runner.stop}
            onOpenWorkflowAgent={() => void onOpenWorkflowAgent()}
          />
        )}
        <div className="app-body">
          {catalog && (
            <ReactFlowProvider>
              <div className={view === 'builder' ? 'view' : 'view view--hidden'}>
                <BuilderView
                  catalog={catalog} currentFlow={currentFlow} description={currentDesc}
                  runner={runner}
                  registerActions={registerActions} onFlowLoaded={handleFlowLoaded} onSaved={refreshFlows}
                  onEditFlow={() => setEditFlowOpen(true)}
                  models={models} apps={apps}
                  onRefreshApps={() => fetchApps().then(setApps).catch(() => {})}
                  onServiceStatus={handleServiceStatus}
                />
              </div>
            </ReactFlowProvider>
          )}
          {view === 'live' && liveFlow && (
            <LiveView
              runner={runner} flow={liveFlow} scenarioName={scenarioLabel(currentFlow)}
              theme={theme} onToggleTheme={toggleTheme}
              inputMode={inputMode} outputMode={outputMode}
              inputResetTick={inputResetTick} outputResetTick={outputResetTick}
              onToggleMicMute={onToggleInputMode} onToggleOutputMode={onToggleOutputMode}
              models={models} apps={apps}
              contextDocs={contextDocs} onUploadDoc={onUploadDoc} onRemoveDoc={onRemoveDoc}
              onStart={startWithContext}
              flows={flows} currentFlow={currentFlow} onSwitchFlow={onSwitchLiveFlow}
              onUpdateStage={onUpdateStage} onRegenerate={onRegenerate}
              onServiceStatus={handleServiceStatus}
              onNotify={(msg) => setToast(msg)}
              onGoBuilder={() => setView('builder')}
              onExit={onExit}
              onReset={() => void onReset()}
              resetSignal={resetSignal}
            />
          )}
        </div>
        {toast && (
          <ToastNotification
            kind="success" title={toast} subtitle="" caption=""
            className="app-toast" timeout={3000} onClose={() => setToast(null)}
          />
        )}
      </div>
    </Theme>
  );
}
