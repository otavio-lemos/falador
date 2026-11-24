// Barra superior 100% Carbon Design: título · Dropdown de workflow · botões Carbon
// (Novo, Editar, Salvar) · pill de latência · Modelos · Testar Fluxo · Iniciar Live.
// A edição de nome + descrição abre um Modal Carbon limpo com TextInput + TextArea.
import { useEffect, useState } from 'react';
import { Button, Dropdown, Modal, Search, TextArea, TextInput } from '@carbon/react';
import { Save, Play, Stop, Edit, Add, Catalog, Bot, Copy, TrashCan } from '@carbon/icons-react';
import { isTextModel, isAsrModel, isTtsModel, isStsModel, isDecisionModel } from '../live-utils';

export interface FlowItem {
  name: string;
  description: string;
}

interface Props {
  view: 'builder' | 'live';
  canGoLive?: boolean;
  latencyMs: number | null;
  running: boolean;
  theme: 'g100' | 'white';
  onToggleTheme: () => void;
  flows: FlowItem[];
  currentFlow: string;
  description: string;
  models: { omlx: string[]; cache: string[] };
  editOpen: boolean;
  onOpenEdit: () => void;
  onCloseEdit: () => void;
  onSelectFlow: (name: string) => void;
  onRename: (newName: string, newDesc: string) => void;
  onNewFlow: () => void;
  onDuplicateFlow: () => void;
  onDeleteFlow: () => void;
  onSave: () => void;
  onTest: () => void;
  onGoLive: () => void;
  onGoBuilder: () => void;
  onStop: () => void;
  onOpenWorkflowAgent: () => void;
}

function classifyModel(id: string): string {
  if (isAsrModel(id)) return 'ASR (Speech-to-Text)';
  if (isTtsModel(id)) return 'TTS (Text-to-Speech)';
  if (isStsModel(id)) return 'STS (Speech-to-Speech)';
  if (isDecisionModel(id)) return 'Decisão (System-1)';
  if (/silero|vad\b|diar_|sortformer/i.test(id)) return 'VAD / Diarização';
  if (isTextModel(id)) return 'LLM (Texto)';
  return 'Outro';
}

const GROUP_ORDER = [
  'ASR (Speech-to-Text)',
  'TTS (Text-to-Speech)',
  'STS (Speech-to-Speech)',
  'LLM (Texto)',
  'Decisão (System-1)',
  'VAD / Diarização',
  'Outro',
];

function shortLabel(id: string) {
  const m = id.match(/models--([^/]+)/);
  if (m) return m[1].replace(/--/g, '/');
  return id.split('/').pop()?.replace(/--/g, '/') ?? id;
}

export function TopBar(p: Props) {
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');

  useEffect(() => {
    if (p.editOpen) {
      setDraftName(p.currentFlow);
      setDraftDesc(p.description);
    }
  }, [p.editOpen, p.currentFlow, p.description]);

  const confirmEdit = () => {
    const clean = draftName.trim().replace(/\s+/g, '-').replace(/[^\w-]/g, '') || p.currentFlow;
    p.onRename(clean, draftDesc.trim());
    p.onCloseEdit();
  };

  const selectedFlowItem = p.flows.find((f) => f.name === p.currentFlow) ?? null;

  const allModels = [...p.models.omlx, ...p.models.cache.filter((m) => !p.models.omlx.includes(m))];
  const filteredModels = allModels.filter((m) => !modelSearch || m.toLowerCase().includes(modelSearch.toLowerCase()));
  const grouped: Record<string, string[]> = {};
  for (const m of filteredModels) {
    const cat = classifyModel(m);
    (grouped[cat] ??= []).push(m);
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="live2-workflow-col">
          <div className="nav-mode-tabs" role="tablist" aria-label="Modo da interface">
            <Button
              kind={p.view === 'builder' ? 'primary' : 'tertiary'}
              size="sm"
              onClick={p.onGoBuilder}
            >
              Builder
            </Button>
            <Button
              kind={p.view === 'live' ? 'primary' : 'tertiary'}
              size="sm"
              onClick={p.onGoLive}
              disabled={!p.currentFlow || p.canGoLive === false}
            >
              Runner
            </Button>
          </div>
          <div className="live-flow-select">
            <Dropdown
              id="topbar-flow-dropdown"
              size="sm"
              titleText="Workflow"
              hideLabel
              label="Selecionar workflow"
              items={p.flows}
              itemToString={(item) => (item ? item.name : '')}
              selectedItem={selectedFlowItem}
              onChange={({ selectedItem }) => {
                if (selectedItem) p.onSelectFlow(selectedItem.name);
              }}
            />
          </div>
        </div>

        <div className="topbar-aux-grid">
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={Add}
            onClick={p.onNewFlow}
          >
            Novo
          </Button>
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={Save}
            onClick={p.onSave}
            disabled={!p.currentFlow}
          >
            Salvar
          </Button>
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={Copy}
            onClick={p.onDuplicateFlow}
            disabled={!p.currentFlow}
          >
            Duplicar
          </Button>
          <Button
            kind="danger--tertiary"
            size="sm"
            renderIcon={TrashCan}
            onClick={p.onDeleteFlow}
            disabled={!p.currentFlow}
          >
            Remover
          </Button>
        </div>
      </div>

      <div className="topbar-right-grid">
        <Button
          kind="tertiary"
          size="sm"
          renderIcon={Bot}
          onClick={p.onOpenWorkflowAgent}
        >
          Eu ajudo
        </Button>
        {p.running ? (
          <Button kind="danger" size="sm" renderIcon={Stop} onClick={p.onStop}>
            Parar
          </Button>
        ) : (
          <Button kind="secondary" size="sm" renderIcon={Play} onClick={p.onTest}>
            Testar
          </Button>
        )}
        <Button
          kind="tertiary"
          size="sm"
          renderIcon={Catalog}
          onClick={() => setModelsOpen(true)}
        >
          Modelos
        </Button>
        <Button
          kind="tertiary"
          size="sm"
          renderIcon={Edit}
          onClick={p.onOpenEdit}
          disabled={!p.currentFlow}
        >
          Detalhes
        </Button>
      </div>

      {/* Modal Carbon: Editar nome e descrição do workflow */}
      <Modal
        open={p.editOpen}
        onRequestClose={p.onCloseEdit}
        onRequestSubmit={confirmEdit}
        modalHeading="Editar detalhes do workflow"
        primaryButtonText="Salvar alterações"
        secondaryButtonText="Cancelar"
        size="sm"
      >
        <div className="edit-flow-form">
          <TextInput
            id="wf-edit-name"
            labelText="Nome do workflow"
            helperText="Identificador do arquivo (use letras, números e hífen)"
            placeholder="ex.: assistente-entrevista"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirmEdit(); }}
          />
          <TextArea
            id="wf-edit-desc"
            labelText="Descrição"
            helperText="Explique o objetivo do fluxo, entrada de áudio e saída esperada"
            placeholder="Descreva o que este workflow faz…"
            rows={4}
            value={draftDesc}
            onChange={(e) => setDraftDesc(e.target.value)}
          />
        </div>
      </Modal>

      {/* Modal Carbon: Gerenciar Modelos */}
      <Modal
        open={modelsOpen}
        onRequestClose={() => setModelsOpen(false)}
        modalHeading="Modelos instalados"
        passiveModal
        size="sm"
      >
        <Search
          size="sm"
          placeholder="Buscar modelo…"
          labelText="Buscar"
          value={modelSearch}
          onChange={(e) => setModelSearch(e.target.value)}
        />
        <div className="models-modal-list">
          {allModels.length === 0 && (
            <p className="models-modal-empty">
              Nenhum modelo encontrado. Verifique se o omlx está rodando (:8080).
            </p>
          )}
          {GROUP_ORDER.filter((g) => grouped[g]?.length).map((group) => (
            <div key={group} className="models-modal-group">
              <div className="models-modal-group-title">{group}</div>
              {grouped[group].map((m) => (
                <div key={m} className="models-modal-item">
                  <span className="models-modal-name">{shortLabel(m)}</span>
                  <span className="models-modal-id">{m}</span>
                  <span className={`models-modal-badge ${p.models.omlx.includes(m) ? 'models-modal-badge--live' : 'models-modal-badge--cache'}`}>
                    {p.models.omlx.includes(m) ? 'omlx' : 'cache HF'}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Modal>
    </header>
  );
}
