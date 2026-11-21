// Tela de CRIAÇÃO do workflow — paleta + canvas + editor inline. Carrega/salva flows,
// adiciona nós (drag/duplo clique), edita params no próprio nó, testa o fluxo.
import { useCallback, useEffect, useState } from 'react';
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
  runner: Runner;
  registerActions: (a: { getFlow: () => Flow; save: () => void }) => void;
  onSaved: () => void;
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  onRefreshApps: () => void;
}

export function BuilderView({ catalog, currentFlow, runner, registerActions, onSaved, models, apps, onRefreshApps }: Props) {
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

  const buildFlow = useCallback(() => rfToFlow(nodes, edges, meta), [nodes, edges, meta]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((es) => addEdge({ ...c, id: `e-${c.source}-${c.sourceHandle}-${c.target}-${c.targetHandle}`, data: { capacity: 16, overflow: 'block' } }, es));
  }, [setEdges]);

  const onParamsChange = useCallback((id: string, params: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => {
      if (n.id !== id) return n;
      let outputs = n.data.outputs;
      if (n.data.type === 'decision.llm' && Array.isArray(params.options)) {
        outputs = (params.options as string[]).map((o) => ({ name: o, type: 'phrase' }));
      }
      return { ...n, data: { ...n.data, params, outputs } };
    }));
  }, [setNodes]);

  const onAddNode = useCallback((type: string, pos: { x: number; y: number }) => {
    const cn = catalog.nodes.find((n) => n.type === type);
    const m = NODE_META[type] ?? { title: type, subtitle: '' };
    const id = newNodeId(type);
    const outputs = type === 'decision.llm' ? [{ name: 'auto', type: 'phrase' }] : (cn?.outputs ?? []);
    const node: FNode = {
      id, type: 'falador', position: pos,
      data: {
        type, params: type === 'decision.llm' ? { options: ['auto'] } : {}, enabled: true,
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
  // captions finais do teste — mostra só as finais em ordem, deduplicadas por nodeId+texto
  const finalCaptions = runner.captions.filter((c) => c.final);
  const lastCaption = runner.captions.at(-1); // parcial mais recente (pode ser não-final)

  return (
    <div className="builder-wrap">
      <div className="builder">
        <Palette onAdd={(t) => onAddNode(t, { x: 120 + Math.random() * 80, y: 120 + Math.random() * 80 })} />
        <FlowCanvas
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
          selectedId={selectedId} onSelect={setSelectedId}
          onParamsChange={onParamsChange} onAddNode={onAddNode}
          metrics={runner.metrics} events={runner.events} running={runner.running}
          models={models} apps={apps} onRefreshApps={onRefreshApps}
        />
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