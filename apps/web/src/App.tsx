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
import { fetchCatalog, fetchFlows, fetchFlow, fetchModels, fetchApps, fetchContext, saveFlow, uploadDoc, removeDoc, type Catalog, type Flow, type ContextDoc } from './api';
import { applyContext, sanitizeFlow } from './live-utils';

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

  const onTest = () => { const f = actionsRef.current?.getFlow(); if (f) runner.start(f, currentFlow); };
  const startWithContext = (f: Flow, name?: string) => runner.start(applyContext(sanitizeFlow(f), contextDocs), name ?? currentFlow);
  const onGoLive = () => {
    const f = actionsRef.current?.getFlow();
    if (!f) return;
    setLiveFlow(f); startWithContext(f, currentFlow); setView('live');
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
    const next: Flow = { ...liveFlow, nodes: liveFlow.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [param]: value } } : n)) };
    setLiveFlow(next); startWithContext(next);
  };
  const onRegenerate = () => { if (liveFlow) startWithContext(liveFlow); };
  const onExit = () => { runner.stop(); setView('builder'); };
  const onSwitchLiveFlow = async (name: string) => {
    try {
      const f = await fetchFlow(name);
      setCurrentFlow(name); setLiveFlow(f); startWithContext(f, name);
    } catch { setToast('Falha ao carregar o flow'); }
  };

  const onOpenWorkflowAgent = async () => {
    try {
      const f = await fetchFlow('agente-workflows');
      setCurrentFlow('agente-workflows');
      setLiveFlow(f);
      startWithContext(f, 'agente-workflows');
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
    <Theme theme="g100">
      <div className="app">
        {view === 'builder' && (
          <TopBar
            view={view} latencyMs={runner.latency} running={runner.running}
            flows={flows} currentFlow={currentFlow}
            description={currentDesc}
            models={models}
            editOpen={editFlowOpen}
            onOpenEdit={() => setEditFlowOpen(true)}
            onCloseEdit={() => setEditFlowOpen(false)}
            onSelectFlow={setCurrentFlow} onSave={onSave}
            onRename={onRename} onNewFlow={onNewFlow}
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
                />
              </div>
            </ReactFlowProvider>
          )}
          {view === 'live' && liveFlow && (
            <LiveView
              runner={runner} flow={liveFlow} scenarioName={scenarioLabel(currentFlow)}
              models={models} apps={apps}
              contextDocs={contextDocs} onUploadDoc={onUploadDoc} onRemoveDoc={onRemoveDoc}
              onStart={startWithContext}
              flows={flows} currentFlow={currentFlow} onSwitchFlow={onSwitchLiveFlow}
              onUpdateStage={onUpdateStage} onRegenerate={onRegenerate}
              onRefreshApps={() => fetchApps().then(setApps).catch(() => {})}
              onNotify={(msg) => setToast(msg)}
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
