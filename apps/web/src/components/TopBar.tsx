// Barra superior: título · seletor de flow com descrição · botão Novo · edição inline
// de nome/descrição · Gerenciar Modelos · pill de latência · Testar/Live/Parar.
import { useEffect, useRef, useState } from 'react';
import { Button, Tag, Modal, Search } from '@carbon/react';
import { Save, Play, Stop, ArrowLeft, Edit, Checkmark, Close, Add, Catalog } from '@carbon/icons-react';
import { isTextModel, isAsrModel, isTtsModel, isStsModel, isDecisionModel } from "../live-utils";

interface FlowItem { name: string; description: string }

interface Props {
  view: 'builder' | 'live';
  latencyMs: number | null;
  running: boolean;
  flows: FlowItem[];
  currentFlow: string;
  description: string;
  models: { omlx: string[]; cache: string[] };
  onSelectFlow: (name: string) => void;
  onRename: (newName: string, newDesc: string) => void;
  onNewFlow: () => void;
  onSave: () => void;
  onTest: () => void;
  onGoLive: () => void;
  onGoBuilder: () => void;
  onStop: () => void;
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

export function TopBar(p: Props) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [dropOpen, setDropOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  const startEdit = () => {
    setDraftName(p.currentFlow);
    setDraftDesc(p.description);
    setEditing(true);
    setDropOpen(false);
    setTimeout(() => { nameRef.current?.focus(); nameRef.current?.select(); }, 50);
  };

  const confirmEdit = () => {
    const name = draftName.trim().replace(/\s+/g, '-').replace(/[^\w\-]/g, '') || p.currentFlow;
    p.onRename(name, draftDesc.trim());
    setEditing(false);
  };

  const cancelEdit = () => setEditing(false);

  // fecha dropdown ao clicar fora
  useEffect(() => {
    if (!dropOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setDropOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropOpen]);

  const allModels = [...p.models.omlx, ...p.models.cache.filter((m) => !p.models.omlx.includes(m))];
  const filteredModels = allModels.filter((m) => !modelSearch || m.toLowerCase().includes(modelSearch.toLowerCase()));
  const grouped: Record<string, string[]> = {};
  for (const m of filteredModels) {
    const cat = classifyModel(m);
    (grouped[cat] ??= []).push(m);
  }
  const GROUP_ORDER = ['ASR (Speech-to-Text)', 'TTS (Text-to-Speech)', 'STS (Speech-to-Speech)', 'LLM (Texto)', 'Decisão (System-1)', 'VAD / Diarização', 'Outro'];

  function shortLabel(id: string) {
    const m = id.match(/models--([^/]+)/);
    if (m) return m[1].replace(/--/g, '/');
    return id.split('/').pop()?.replace(/--/g, '/') ?? id;
  }

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-title">Audio AI Pipeline Builder</span>

        {p.view === 'builder' && (
          <div className="topbar-flow" ref={dropRef}>
            {editing ? (
              <div className="topbar-edit">
                <input
                  ref={nameRef}
                  className="topbar-edit-name"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') confirmEdit(); if (e.key === 'Escape') cancelEdit(); }}
                  placeholder="nome-do-workflow"
                />
                <input
                  className="topbar-edit-desc"
                  value={draftDesc}
                  onChange={(e) => setDraftDesc(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') confirmEdit(); if (e.key === 'Escape') cancelEdit(); }}
                  placeholder="Descrição do workflow…"
                />
                <Button kind="ghost" size="sm" hasIconOnly renderIcon={Checkmark} iconDescription="Confirmar (Enter)" onClick={confirmEdit} />
                <Button kind="ghost" size="sm" hasIconOnly renderIcon={Close} iconDescription="Cancelar (Esc)" onClick={cancelEdit} />
              </div>
            ) : (
              <>
                <button className="topbar-flow-btn" onClick={() => setDropOpen((v) => !v)}>
                  <span className="topbar-flow-name">{p.currentFlow || '—'}</span>
                  {p.description && <span className="topbar-flow-desc">{p.description}</span>}
                  <svg className="topbar-flow-caret" viewBox="0 0 16 16" width="10" height="10">
                    <path d="M8 10L3 5h10z" fill="currentColor"/>
                  </svg>
                </button>
                {dropOpen && (
                  <div className="topbar-dropdown">
                    {p.flows.map((f) => (
                      <div
                        key={f.name}
                        className={`topbar-dd-item${f.name === p.currentFlow ? ' topbar-dd-item--active' : ''}`}
                        onClick={() => { p.onSelectFlow(f.name); setDropOpen(false); }}
                      >
                        <span className="tdi-name">{f.name}</span>
                        {f.description && <span className="tdi-desc">{f.description}</span>}
                      </div>
                    ))}
                    <div className="topbar-dd-sep" />
                    <div className="topbar-dd-item topbar-dd-item--action" onClick={() => { p.onNewFlow(); setDropOpen(false); }}>
                      <Add size={14} style={{ marginRight: 6 }} /> Novo workflow
                    </div>
                  </div>
                )}
                <Button kind="ghost" size="sm" hasIconOnly renderIcon={Edit} iconDescription="Renomear / editar descrição" onClick={startEdit} />
                <Button kind="ghost" size="sm" hasIconOnly renderIcon={Save} iconDescription="Salvar" onClick={p.onSave} />
              </>
            )}
          </div>
        )}
      </div>

      <div className="topbar-center">
        <Tag type="green" size="md" className="latency-pill">
          Live Latency: {p.latencyMs != null ? `${Math.round(p.latencyMs)}ms` : '—'}
        </Tag>
      </div>

      <div className="topbar-right">
        <Button kind="ghost" size="sm" renderIcon={Catalog} iconDescription="Gerenciar Modelos" onClick={() => setModelsOpen(true)}>Modelos</Button>
        {p.view === 'builder' ? (
          p.running ? (
            <Button kind="danger" size="sm" renderIcon={Stop} onClick={p.onStop}>Parar</Button>
          ) : (
            <>
              <Button kind="secondary" size="sm" renderIcon={Play} onClick={p.onTest}>Testar Fluxo</Button>
              <Button kind="primary" size="sm" renderIcon={Play} onClick={p.onGoLive}>Iniciar Live</Button>
            </>
          )
        ) : (
          <>
            <Button kind="secondary" size="sm" renderIcon={ArrowLeft} onClick={p.onGoBuilder}>Builder</Button>
            <Button kind="danger" size="sm" renderIcon={Stop} onClick={p.onStop} disabled={!p.running}>Parar</Button>
          </>
        )}
      </div>

      {/* Modal Gerenciar Modelos */}
      <Modal
        open={modelsOpen}
        onRequestClose={() => setModelsOpen(false)}
        modalHeading="Modelos instalados"
        passiveModal
        size="sm"
      >
        <Search
          size="sm" placeholder="Buscar modelo…" labelText="Buscar"
          value={modelSearch} onChange={(e) => setModelSearch(e.target.value)}
        />
        <div className="models-modal-list">
          {allModels.length === 0 && (
            <p className="models-modal-empty">Nenhum modelo encontrado. Verifique se o omlx está rodando (:8080).</p>
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
