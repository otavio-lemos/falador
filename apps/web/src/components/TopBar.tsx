// Barra superior — título, seletor de flow + salvar, pill de latência ao vivo,
// e ações (Testar Fluxo / Iniciar Live na criação; Parar / ← Builder na execução).
import { Button, Dropdown, Tag } from '@carbon/react';
import { Save, Play, Stop, ArrowLeft } from '@carbon/icons-react';

interface Props {
  view: 'builder' | 'live';
  latencyMs: number | null;
  running: boolean;
  flows: { name: string; description: string }[];
  currentFlow: string;
  onSelectFlow: (name: string) => void;
  onSave: () => void;
  onTest: () => void;
  onGoLive: () => void;
  onGoBuilder: () => void;
  onStop: () => void;
}

export function TopBar(p: Props) {
  const items = p.flows.map((f) => ({ id: f.name, label: f.name }));
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-title">Audio AI Pipeline Builder</span>
        {p.view === 'builder' && (
          <div className="topbar-flow">
            <Dropdown
              id="flow-select" size="sm" titleText="Flow" hideLabel label="Flow"
              items={items} itemToString={(it) => (it ? it.label : '')}
              selectedItem={items.find((i) => i.id === p.currentFlow) ?? null}
              onChange={({ selectedItem }) => selectedItem && p.onSelectFlow(selectedItem.id)}
            />
            <Button kind="ghost" size="sm" renderIcon={Save} onClick={p.onSave} hasIconOnly iconDescription="Salvar flow" />
          </div>
        )}
      </div>
      <div className="topbar-center">
        <Tag type="green" size="md" className="latency-pill">
          Live Latency: {p.latencyMs != null ? `${Math.round(p.latencyMs)}ms` : '—'}
        </Tag>
      </div>
      <div className="topbar-right">
        {p.view === 'builder' ? (
          <>
            <Button kind="secondary" size="sm" renderIcon={Play} onClick={p.onTest} disabled={p.running}>
              Testar Fluxo
            </Button>
            <Button kind="primary" size="sm" renderIcon={Play} onClick={p.onGoLive} disabled={p.running}>
              Iniciar Live
            </Button>
          </>
        ) : (
          <>
            <Button kind="secondary" size="sm" renderIcon={ArrowLeft} onClick={p.onGoBuilder}>
              Builder
            </Button>
            <Button kind="danger" size="sm" renderIcon={Stop} onClick={p.onStop} disabled={!p.running}>
              Parar
            </Button>
          </>
        )}
      </div>
    </header>
  );
}