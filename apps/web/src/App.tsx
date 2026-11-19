// App — shell com duas telas (Criação | Execução), barra superior compartilhada,
// tema Carbon g100, e o estado de execução (useRunner) comum às duas.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Theme, ToastNotification } from '@carbon/react';
import { ReactFlowProvider } from '@xyflow/react';
import { TopBar } from './components/TopBar';
import { BuilderView } from './views/BuilderView';
import { LiveView } from './views/LiveView';
import { useRunner } from './useRunner';
import { fetchCatalog, fetchFlows, type Catalog, type Flow } from './api';

export function App() {
  const [view, setView] = useState<'builder' | 'live'>('builder');
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [flows, setFlows] = useState<{ name: string; description: string }[]>([]);
  const [currentFlow, setCurrentFlow] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const runner = useRunner();
  const actionsRef = useRef<{ getFlow: () => Flow; save: () => void } | null>(null);

  useEffect(() => {
    fetchCatalog().then(setCatalog).catch(() => setToast('Falha ao carregar catálogo'));
    fetchFlows().then((fs) => {
      setFlows(fs);
      setCurrentFlow((cur) => cur || (fs.find((f) => f.name === 'cenario2-auto') ?? fs[0])?.name || '');
    }).catch(() => setToast('Falha ao listar flows'));
  }, []);

  const registerActions = useCallback((a: { getFlow: () => Flow; save: () => void }) => { actionsRef.current = a; }, []);
  const refreshFlows = useCallback(() => { fetchFlows().then(setFlows).catch(() => {}); }, []);

  const onTest = () => { const f = actionsRef.current?.getFlow(); if (f) runner.start(f); };
  const onGoLive = () => { const f = actionsRef.current?.getFlow(); if (f) { runner.start(f); setView('live'); } };
  const onSave = () => { actionsRef.current?.save(); setToast('Flow salvo'); };

  return (
    <Theme theme="g100">
      <div className="app">
        <TopBar
          view={view} latencyMs={runner.latency} running={runner.running}
          flows={flows} currentFlow={currentFlow}
          onSelectFlow={setCurrentFlow} onSave={onSave}
          onTest={onTest} onGoLive={onGoLive}
          onGoBuilder={() => setView('builder')} onStop={runner.stop}
        />
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
          {view === 'live' && <LiveView runner={runner} />}
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