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
import { fetchCatalog, fetchFlows, fetchModels, fetchApps, type Catalog, type Flow } from './api';

function scenarioLabel(name: string): string {
  if (name.startsWith('cenario2')) return 'Entrevista Técnica';
  if (name.startsWith('cenario1')) return 'Legendas ao vivo';
  return name || 'Sessão';
}

export function App() {
  const [view, setView] = useState<'builder' | 'live'>('builder');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [flows, setFlows] = useState<{ name: string; description: string }[]>([]);
  const [currentFlow, setCurrentFlow] = useState('');
  const [liveFlow, setLiveFlow] = useState<Flow | null>(null);
  const [models, setModels] = useState<{ omlx: string[]; cache: string[] }>({ omlx: [], cache: [] });
  const [apps, setApps] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const runner = useRunner();
  const actionsRef = useRef<{ getFlow: () => Flow; save: () => void } | null>(null);

  useEffect(() => {
    fetchCatalog().then(setCatalog).catch(() => setToast('Falha ao carregar catálogo'));
    fetchFlows().then((fs) => {
      setFlows(fs);
      setCurrentFlow((cur) => cur || (fs.find((f) => f.name === 'cenario2-auto') ?? fs[0])?.name || '');
    }).catch(() => setToast('Falha ao listar flows'));
    fetchModels().then(setModels).catch(() => {});
    fetchApps().then(setApps).catch(() => {});
  }, []);

  const registerActions = useCallback((a: { getFlow: () => Flow; save: () => void }) => { actionsRef.current = a; }, []);
  const refreshFlows = useCallback(() => { fetchFlows().then(setFlows).catch(() => {}); }, []);

  const onTest = () => { const f = actionsRef.current?.getFlow(); if (f) runner.start(f); };
  const onGoLive = () => {
    const f = actionsRef.current?.getFlow();
    if (!f) return;
    setLiveFlow(f); runner.start(f); setView('live');
    fetchApps().then(setApps).catch(() => {});
    fetchModels().then(setModels).catch(() => {});
  };
  const onSave = () => { actionsRef.current?.save(); setToast('Flow salvo'); };

  // trocar uma etapa = atualiza o param REAL do nó e reinicia a sessão (motor não faz hot-swap)
  const onUpdateStage = (nodeId: string, param: string, value: unknown) => {
    if (!liveFlow) return;
    const next: Flow = { ...liveFlow, nodes: liveFlow.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [param]: value } } : n)) };
    setLiveFlow(next); runner.start(next);
  };
  const onRegenerate = () => { if (liveFlow) runner.start(liveFlow); };
  const onExit = () => { runner.stop(); setView('builder'); };

  return (
    <Theme theme="g100">
      <div className="app">
        {view === 'builder' && (
          <TopBar
            view={view} latencyMs={runner.latency} running={runner.running}
            flows={flows} currentFlow={currentFlow}
            onSelectFlow={setCurrentFlow} onSave={onSave}
            onTest={onTest} onGoLive={onGoLive}
            onGoBuilder={() => setView('builder')} onStop={runner.stop}
          />
        )}
        <div className="app-body">
          {catalog && (
            <ReactFlowProvider>
              <div className={view === 'builder' ? 'view' : 'view view--hidden'}>
                <BuilderView
                  catalog={catalog} currentFlow={currentFlow} runner={runner}
                  registerActions={registerActions} onSaved={refreshFlows}
                />
              </div>
            </ReactFlowProvider>
          )}
          {view === 'live' && liveFlow && (
            <LiveView
              runner={runner} flow={liveFlow} scenarioName={scenarioLabel(currentFlow)}
              models={models} apps={apps}
              onUpdateStage={onUpdateStage} onRegenerate={onRegenerate} onExit={onExit}
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