// Tela de CRIAÇÃO do workflow — paleta + faixa de nome/descrição + canvas + editor inline.
// Carrega/salva flows, adiciona nós (drag/duplo clique), edita params no próprio nó, testa o fluxo.
import { useCallback, useEffect, useState } from 'react';
import { Button, Tag } from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import { useNodesState, useEdgesState, addEdge, type Edge, type Connection } from '@xyflow/react';
import { Palette } from '../components/Palette';
import { FlowCanvas } from '../components/FlowCanvas';
import { fetchFlow, saveFlow, type Catalog, type Flow } from '../api';
import { flowToRf, rfToFlow, newNodeId, type FNode } from '../flow-utils';
import { NODE_META, accentOf } from '../data';
import type { Runner } from '../useRunner';

interface Props {
  catalog: Catalog;
  currentFlow: string;
  description: string;
  runner: Runner;
  registerActions: (a: { getFlow: () => Flow; save: () => void }) => void;
  onSaved: () => void;
  onEditFlow: () => void;
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  onRefreshApps: () => void;
}

export function BuilderView({
  catalog, currentFlow, description, runner, registerActions, onSaved, onEditFlow, models, apps, onRefreshApps,
}: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<FNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [meta, setMeta] = useState<Flow>({ version: 1, nodes: [], edges: [], stopWhenSourcesDone: false, description: '' });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!currentFlow) return;
    let alive = true;
    fetchFlow(currentFlow).then((flow) => {
      if (!alive) return;
      const { nodes: ns, edges: es } = flowToRf(flow, catalog);
      setNodes(ns); setEdges(es); setMeta(flow); setSelectedId(null);
    }).catch(() => { /* flow novo/vazio */ });
    return () => { alive = false; };
  }, [currentFlow, catalog, setNodes, setEdges]);

  const buildFlow = useCallback(() => rfToFlow(nodes, edges, { ...meta, description: description || meta.description }), [nodes, edges, meta, description]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge({ ...c, id: `e-${c.source}-${c.sourceHandle}-${c.target}-${c.targetHandle}`, data: { capacity: 16, overflow: 'block' } }, es));
  }, [setEdges]);

  const onParamsChange = useCallback((id: string, params: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => {
      if (n.id !== id) return n;
      let outputs = n.data.outputs;
      if (n.data.type === 'decision.llm' && Array.isArray(params.options)) {
        outputs = (params.options as string[]).map((o) => ({ name: o, type: 'tokens_parcial' }));
      }
      return { ...n, data: { ...n.data, params, outputs } };
    }));
  }, [setNodes]);

  const onAddNode = useCallback((type: string, pos: { x: number; y: number }) => {
    const cn = catalog.nodes.find((n) => n.type === type);
    const m = NODE_META[type] ?? { title: type, subtitle: '' };
    const id = newNodeId(type);
    const outputs = type === 'decision.llm' ? [{ name: 'auto', type: 'tokens_parcial' }] : (cn?.outputs ?? []);
    const defaultParams: Record<string, unknown> =
      type === 'decision.llm'
        ? { options: ['auto'] }
        : type === 'exec.command'
          ? { transport: 'local', mode: 'readonly', dryRun: true }
          : {};
    const node: FNode = {
      id, type: 'falador', position: pos,
      data: {
        type, params: defaultParams, enabled: true,
        paramNames: cn?.paramNames ?? [], inputs: cn?.inputs ?? [], outputs,
        accent: accentOf(type), title: m.title, subtitle: m.subtitle,
      },
    };
    setNodes((ns) => [...ns, node]);
    setSelectedId(id);
  }, [catalog, setNodes]);

  const doSave = useCallback(async () => {
    try { await saveFlow(currentFlow, buildFlow()); onSaved(); }
    catch (e) { console.error(e); }
  }, [currentFlow, buildFlow, onSaved]);

  useEffect(() => {
    registerActions({ getFlow: buildFlow, save: () => void doSave() });
  }, [buildFlow, doSave, registerActions]);

  // feedback do run no builder: erro real ou último log (ex.: captura aguardando app)
  const errEv = [...runner.events].reverse().find((e) => e.type === 'node_error' && !String((e as { code?: string }).code ?? '').startsWith('log_')) as { nodeId?: string; message?: string } | undefined;
  const logEv = [...runner.events].reverse().find((e) => e.type === 'node_error' && String((e as { code?: string }).code ?? '').startsWith('log_')) as { nodeId?: string; message?: string } | undefined;
  const statusMsg = errEv ? `[${errEv.nodeId}] ${errEv.message}` : logEv ? `[${logEv.nodeId}] ${logEv.message}` : '';
  const finalCaptions = runner.captions.filter((c) => c.final);
  const lastCaption = runner.captions.at(-1);
  const displayDesc = description || meta.description;

  return (
    <div className="builder-wrap">
      <div className="builder">
        <Palette onAdd={(t) => onAddNode(t, { x: 120 + Math.random() * 80, y: 120 + Math.random() * 80 })} />
        <div className="builder-stage">
          {/* Cabeçalho do fluxo na própria tela do canvas: nome + descrição completa */}
          <div className="flow-banner">
            <div className="flow-banner-main">
              <div className="flow-banner-top">
                <h2 className="flow-banner-name">{currentFlow || 'Sem workflow'}</h2>
                <Tag type="cool-gray" size="sm">{nodes.length} nós</Tag>
                <Tag type="cool-gray" size="sm">{edges.length} conexões</Tag>
              </div>
              <p className="flow-banner-desc">
                {displayDesc || 'Sem descrição — clique em "Editar detalhes" para descrever este workflow.'}
              </p>
            </div>
            <Button
              kind="tertiary"
              size="sm"
              renderIcon={Edit}
              onClick={onEditFlow}
              disabled={!currentFlow}
            >
              Editar detalhes
            </Button>
          </div>
          <FlowCanvas
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            selectedId={selectedId} onSelect={setSelectedId}
            onParamsChange={onParamsChange} onAddNode={onAddNode}
            metrics={runner.metrics} events={runner.events} running={runner.running}
            models={models} apps={apps} onRefreshApps={onRefreshApps}
          />
        </div>
      </div>
      {(runner.running || finalCaptions.length > 0 || statusMsg) && (
        <div className={`builder-status${errEv ? ' builder-status--err' : ''}`}>
          <div className="builder-status-top">
            <span className={`live-dot${runner.running ? ' live-dot--on' : ''}`} />
            <span className="builder-status-state">{runner.running ? 'Rodando' : 'Parado'}</span>
            {statusMsg && <span className="builder-status-msg">{statusMsg}</span>}
          </div>
          {(finalCaptions.length > 0 || (lastCaption && !lastCaption.final)) && (
            <div className="builder-output">
              {finalCaptions.map((c, i) => (
                <div key={i} className="builder-output-line">{c.text}</div>
              ))}
              {lastCaption && !lastCaption.final && (
                <div className="builder-output-line builder-output-line--partial">{lastCaption.text}<span className="live-cursor" /></div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
