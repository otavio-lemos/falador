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
import { fetchCatalog, fetchFlows, fetchFlow, fetchModels, fetchApps, fetchContext, saveFlow, deleteFlow, uploadDoc, removeDoc, type Catalog, type Flow, type ContextDoc, type ServiceStatusMap } from './api';
import { applyContext, isDecisionModel, sanitizeFlow } from './live-utils';

function scenarioLabel(name: string): string {
  if (name === 'agente-workflows') return 'Agente de Workflows';
  if (name.includes('entrevista') || name.startsWith('cenario2')) return 'Entrevista Técnica';
  if (name.includes('ops') || name.includes('servidor')) return 'Ops / Revisão de Servidor';
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
  const [micMuted, setMicMuted] = useState(false);
  const [speakerMuted, setSpeakerMuted] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [flows, setFlows] = useState<{ name: string; description: string }[]>([]);
  const [currentFlow, setCurrentFlow] = useState('');
  const [editFlowOpen, setEditFlowOpen] = useState(false);
  const [liveFlow, setLiveFlow] = useState<Flow | null>(null);
  const [models, setModels] = useState<{ omlx: string[]; cache: string[] }>({ omlx: [], cache: [] });
  const [apps, setApps] = useState<string[]>([]);
  const [contextDocs, setContextDocs] = useState<ContextDoc[]>([]);
  const [toast, setToast] = useState<string | null>(null);
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

  const applyAudioMutes = (f: Flow, mic: boolean, spk: boolean): Flow => {
    if (!mic && !spk) return f;
    return {
      ...f,
      nodes: f.nodes.map((n) => {
        if (mic && n.type === 'capture.ffmpeg') return { ...n, params: { ...n.params, muted: true } };
        if (spk && (n.type === 'sink.playback' || n.type === 'tts.sts')) return { ...n, params: { ...n.params, muted: true } };
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
  const startWithContext = (f: Flow, name?: string, mic = micMuted, spk = speakerMuted) =>
    runner.start(applyAudioMutes(applyContext(sanitizeFlow(f), contextDocs), mic, spk), name ?? currentFlow);

  const onToggleMicMute = () => {
    const next = !micMuted;
    setMicMuted(next);
    if (liveFlow && runner.running) startWithContext(liveFlow, currentFlow, next, speakerMuted);
  };
  const onToggleSpeakerMute = () => {
    const next = !speakerMuted;
    setSpeakerMuted(next);
    if (liveFlow && runner.running) startWithContext(liveFlow, currentFlow, micMuted, next);
  };
  const onGoLive = () => {
    const f = actionsRef.current?.getFlow();
    if (!f) return;
    runner.stop();
    setLiveFlow(f);
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
  const onSwitchLiveFlow = async (name: string) => {
    try {
      const f = await fetchFlow(name);
      setMicMuted(false);
      setSpeakerMuted(false);
      setCurrentFlow(name); setLiveFlow(f);
      if (runner.running) startWithContext(f, name, false, false);
    } catch { setToast('Falha ao carregar o flow'); }
  };

  const onOpenWorkflowAgent = async () => {
    try {
      const f = await fetchFlow('agente-workflows');
      runner.stop();
      setCurrentFlow('agente-workflows');
      setLiveFlow(f);
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
            view={view} latencyMs={runner.latency} running={runner.running}
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
                  registerActions={registerActions} onSaved={refreshFlows}
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
              micMuted={micMuted} speakerMuted={speakerMuted}
              onToggleMicMute={onToggleMicMute} onToggleSpeakerMute={onToggleSpeakerMute}
              models={models} apps={apps}
              contextDocs={contextDocs} onUploadDoc={onUploadDoc} onRemoveDoc={onRemoveDoc}
              onStart={startWithContext}
              flows={flows} currentFlow={currentFlow} onSwitchFlow={onSwitchLiveFlow}
              onUpdateStage={onUpdateStage} onRegenerate={onRegenerate}
              onRefreshApps={() => fetchApps().then(setApps).catch(() => {})}
              onServiceStatus={handleServiceStatus}
              onNotify={(msg) => setToast(msg)}
              onGoBuilder={() => setView('builder')}
              onExit={onExit}
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
