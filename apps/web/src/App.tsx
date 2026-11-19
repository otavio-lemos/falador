// App — canvas do Falador: o usuário MONTA o workflow (ADR-003 "nada fixo").
// Nós → catálogo do runner; edges → portas tipadas; Run → host zero-dep → NDJSON.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Connection,
  type Edge as RFEdge,
  type Node as RFNode,
} from '@xyflow/react';
import { FlowNode, type FaladorNode, type FaladorNodeData } from './components/FlowNode';
import { Inspector } from './components/Inspector';
import { RunPanel } from './components/RunPanel';
import { NODE_DESCRIPTIONS } from './node-descriptions';
import { fetchCatalog, fetchFlow, fetchFlowList, fetchModels, saveFlow, type CatalogEntry, type Flow, type FlowInfo, type FlowProfiles, type NodeMetrics } from './api';

const nodeTypes = { falador: FlowNode };

type CatalogMap = Record<string, CatalogEntry>;

function flowToRf(flow: Flow, catalog: CatalogMap): { nodes: FaladorNode[]; edges: RFEdge[] } {
  const nodes: FaladorNode[] = (flow.nodes ?? []).map((n, i) => {
    const def = catalog[n.type];
    return {
      id: n.id,
      type: 'falador' as const,
      position: n.position ?? { x: 40 + (i % 4) * 260, y: 40 + Math.floor(i / 4) * 160 },
      data: {
        type: n.type,
        sourceOnly: def?.sourceOnly ?? false,
        paramNames: def?.paramNames ?? [],
        inputs: def?.inputs ?? [],
        outputs: def?.outputs ?? [],
        params: n.params ?? {},
        enabled: n.enabled !== false,
      },
    };
  });
  const edges: RFEdge[] = (flow.edges ?? []).map((e, i) => {
    const [src, sPort] = e.from.split('.');
    const [dst, dPort] = e.to.split('.');
    return {
      id: `e${i}-${e.from}->${e.to}`,
      source: src,
      target: dst,
      sourceHandle: sPort,
      targetHandle: dPort,
      markerEnd: { type: MarkerType.ArrowClosed, color: '#8d8d8d' },
      style: { stroke: '#8d8d8d' },
      data: { capacity: e.capacity ?? 16, overflow: e.overflow ?? 'block' },
    };
  });
  return { nodes, edges };
}

function rfToFlow(nodes: FaladorNode[], edges: RFEdge[], description?: string, profiles?: FlowProfiles, stopWhenSourcesDone?: boolean): Flow {
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    stopWhenSourcesDone: stopWhenSourcesDone === true,
    ...(description !== undefined ? { description } : {}),
    ...(profiles && Object.keys(profiles).length ? { profiles } : {}),
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.data.type,
      params: n.data.params ?? {},
      ...(n.data.enabled ? {} : { enabled: false }),
      position: n.position,
    })),
    edges: edges.map((e) => ({
      from: `${e.source}.${e.sourceHandle ?? 'out'}`,
      to: `${e.target}.${e.targetHandle ?? 'in'}`,
      capacity: (e.data as { capacity?: number } | undefined)?.capacity ?? 16,
      overflow: (e.data as { overflow?: 'block' | 'drop_oldest' | 'drop_newest' } | undefined)?.overflow ?? 'block',
    })),
  };
}

let idSeq = 1;

export function App() {
  const [catalog, setCatalog] = useState<CatalogMap>({});
  const [nodes, setNodes, onNodesChange] = useNodesState<FaladorNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [flowList, setFlowList] = useState<FlowInfo[]>([]);
  const [currentName, setCurrentName] = useState<string>('cenario1-pt');
  const [currentDesc, setCurrentDesc] = useState<string>('');
  const [editingMeta, setEditingMeta] = useState(false);
  const [modelsInfo, setModelsInfo] = useState<{ omlx: string[]; cache: string[] } | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [modelsVia, setModelsVia] = useState<string | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = useState<string | null>(null); // item de paleta expandido
  const [metrics, setMetrics] = useState<Record<string, NodeMetrics>>({}); // ao vivo (SSE do runner)
  const [profiles, setProfiles] = useState<FlowProfiles>({}); // perfis de Run (W8) — persistem no flow JSON
  const [stopWhenSourcesDone, setStopWhenSourcesDone] = useState(false); // flag do flow — preservada no save/run
  const rfWrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCatalog().then((list) => {
      const m: CatalogMap = {};
      for (const e of list) m[e.type] = e;
      setCatalog(m);
    });
    fetchFlowList().then(setFlowList).catch(() => undefined);
    const t = setInterval(() => fetchFlowList().then(setFlowList).catch(() => undefined), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!Object.keys(catalog).length) return;
    fetchFlow(currentName)
      .then((f) => {
        const { nodes: n, edges: e } = flowToRf(f, catalog);
        setNodes(n);
        setEdges(e);
        setCurrentDesc(f.description ?? '');
        setProfiles(f.profiles ?? {});
        setMetrics({});
        setStopWhenSourcesDone(f.stopWhenSourcesDone === true);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) =>
        addEdge(
          {
            ...c,
            id: `e${Date.now()}`,
            markerEnd: { type: MarkerType.ArrowClosed, color: '#8d8d8d' },
            style: { stroke: '#8d8d8d' },
            data: { capacity: 16, overflow: 'block' },
          },
          eds
        )
      );
    },
    [setEdges]
  );

  const addNode = useCallback(
    (type: string, at?: { x: number; y: number }) => {
      const def = catalog[type];
      if (!def) return;
      const id = `${type.split('.')[0]}${idSeq++}`;
      const pos = at ?? { x: 60, y: 60 };
      setNodes((ns) => [
        ...ns,
        {
          id,
          type: 'falador',
          position: pos,
          data: { ...def, params: {}, enabled: true },
        },
      ]);
    },
    [catalog, setNodes]
  );

  const duplicateNode = useCallback(
    (id: string) => {
      const src = nodes.find((n) => n.id === id);
      if (!src) return;
      const newId = `${src.data.type.split('.')[0]}${idSeq++}`;
      setNodes((ns) => [...ns, { ...src, id: newId, selected: false, position: { x: src.position.x + 40, y: src.position.y + 40 }, data: { ...src.data, params: { ...src.data.params } } }]);
    },
    [nodes, setNodes]
  );

  const deleteNode = useCallback(
    (id: string) => {
      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      if (selectedId === id) setSelectedId(null);
    },
    [nodes, setNodes, setEdges, selectedId]
  );

  const updateNode = useCallback(
    (id: string, patch: Partial<FaladorNode['data']>) => {
      setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    },
    [setNodes]
  );

  const onDrop = useCallback(
    (ev: React.DragEvent) => {
      ev.preventDefault();
      const type = ev.dataTransfer.getData('application/falador-node');
      if (!type || !rfWrap.current) return;
      const bounds = rfWrap.current.getBoundingClientRect();
      addNode(type, { x: ev.clientX - bounds.left - 100, y: ev.clientY - bounds.top - 40 });
    },
    [addNode]
  );

  const doSave = useCallback(async () => {
    const flow = rfToFlow(nodes as FaladorNode[], edges, currentDesc, profiles, stopWhenSourcesDone);
    await saveFlow(currentName, flow);
    fetchFlowList().then(setFlowList).catch(() => undefined);
    setEditingMeta(false);
  }, [nodes, edges, currentName, currentDesc, profiles, stopWhenSourcesDone]);

  const doSaveAs = useCallback(async (newName: string, newDesc: string) => {
    const flow = rfToFlow(nodes as FaladorNode[], edges, newDesc, profiles, stopWhenSourcesDone);
    // rename: servidor apaga o arquivo antigo quando renameFrom ≠ name
    await saveFlow(newName, flow, currentName !== newName ? currentName : undefined);
    fetchFlowList().then(setFlowList).catch(() => undefined);
    setCurrentName(newName);
    setCurrentDesc(newDesc);
    setEditingMeta(false);
  }, [nodes, edges, currentName, profiles, stopWhenSourcesDone]);

  const doLoad = useCallback(async (name: string) => {
    const f = await fetchFlow(name);
    const { nodes: n, edges: e } = flowToRf(f, catalog);
    setNodes(n);
    setEdges(e);
    setCurrentName(name);
    setCurrentDesc(f.description ?? '');
    setProfiles(f.profiles ?? {});
    setMetrics({});
    setStopWhenSourcesDone(f.stopWhenSourcesDone === true);
  }, [catalog, setNodes, setEdges]);

  // Perfil de Run (W8): fotografa os params ATUAIS de cada nó; aplicado como override só no Run.
  const doSaveProfile = useCallback(async (name: string) => {
    const snap: Record<string, Record<string, unknown>> = {};
    for (const n of nodes) {
      if (Object.keys(n.data.params ?? {}).length) snap[n.id] = { ...n.data.params };
    }
    const next = { ...profiles, [name]: snap };
    setProfiles(next);
    await saveFlow(currentName, rfToFlow(nodes as FaladorNode[], edges, currentDesc, next, stopWhenSourcesDone));
  }, [nodes, edges, currentName, currentDesc, profiles, stopWhenSourcesDone]);

  const doRefreshModels = useCallback(() => {
    fetchModels().then((m) => {
      setModelsInfo(m);
      setModelsVia(undefined);
      setShowModels(true);
    }).catch(() => undefined);
  }, []);

  const doFetchViaParam = useCallback((param: string) => {
    fetchModels().then((m) => {
      setModelsInfo(m);
      setModelsVia(param);
      setShowModels(true);
    }).catch(() => undefined);
  }, []);

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) as FaladorNode | undefined, [nodes, selectedId]);

  const getFlow = useCallback(() => rfToFlow(nodes as FaladorNode[], edges, undefined, profiles, stopWhenSourcesDone), [nodes, edges, profiles, stopWhenSourcesDone]);

  // overlay de métricas ao vivo nos nós do canvas (não muta o estado do grafo nem o flow salvo)
  const displayNodes = useMemo(
    () => nodes.map((n) => (metrics[n.id] ? { ...n, data: { ...n.data, metrics: metrics[n.id] } } : n)),
    [nodes, metrics],
  );

  return (
    <div className="app">
      <div className="toolbar">
        <strong style={{ marginRight: 8 }}>Falador</strong>
        <select
          value={currentName}
          onChange={(e) => doLoad(e.target.value)}
          title={currentDesc}
          style={{ background: '#262626', color: '#f4f4f4', border: '1px solid #393939', padding: '4px 8px', borderRadius: 4, maxWidth: 340 }}
        >
          {flowList.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}{f.description ? ` — ${f.description}` : ''}
            </option>
          ))}
        </select>
        <button onClick={() => setEditingMeta((v) => !v)} title="renomear / descrever este flow" style={{ background: '#393939', color: '#f4f4f4', border: '1px solid #525252', padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}>✎ nome&nbsp;/&nbsp;descrição</button>
        <button onClick={doSave} style={{ background: '#0f62fe', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 4, cursor: 'pointer' }}>
          Salvar
        </button>
        <button onClick={doRefreshModels} title="consulta omlx /v1/models + cache HF guardando na máquina" style={{ background: '#393939', color: '#f4f4f4', border: '1px solid #525252', padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}>
          ⟳ atualizar modelos
        </button>
        {editingMeta ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              autoFocus
              defaultValue={currentName}
              id="flow-name-input"
              placeholder="nome (arquivo .json)"
              style={{ background: '#262626', color: '#f4f4f4', border: '1px solid #525252', padding: '4px 8px', borderRadius: 4, width: 180 }}
            />
            <input
              defaultValue={currentDesc}
              id="flow-desc-input"
              placeholder="o que este cenário faz (aparece no seletor)"
              style={{ background: '#262626', color: '#f4f4f4', border: '1px solid #525252', padding: '4px 8px', borderRadius: 4, width: 320 }}
            />
            <button
              onClick={() => {
                const name = (document.getElementById('flow-name-input') as HTMLInputElement | null)?.value.trim();
                const desc = (document.getElementById('flow-desc-input') as HTMLInputElement | null)?.value ?? '';
                if (name) void doSaveAs(name, desc);
              }}
              style={{ background: '#0f62fe', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}
            >
              ok
            </button>
            <button onClick={() => setEditingMeta(false)} style={{ background: 'transparent', color: '#8d8d8d', border: '1px solid #525252', padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}>✕</button>
          </span>
        ) : (
          currentDesc && <span style={{ color: '#8d8d8d', fontSize: 12 }} title={currentDesc}>{currentDesc.slice(0, 80)}</span>
        )}
        {showModels && modelsInfo && (
          <span style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', top: 28, right: 0, zIndex: 50, background: '#262626', border: '1px solid #525252', borderRadius: 6, padding: 10, width: 420, maxHeight: 300, overflow: 'auto', boxShadow: '0 4px 12px #000a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <strong style={{ fontSize: 12 }}>Modelos disponíveis (omlx :8080)</strong>
                <button onClick={() => setShowModels(false)} style={{ background: 'transparent', color: '#8d8d8d', border: 'none', cursor: 'pointer' }}>✕</button>
              </div>
              {modelsInfo.omlx.length === 0 && <div style={{ color: '#ff8389', fontSize: 12 }}>omlx :8080 não respondeu — suba o serviço (./faladorctl start)</div>}
              {modelsInfo.omlx.map((id) => (
                <div key={id} style={{ fontSize: 12, padding: '2px 0', color: '#f4f4f4' }}>• {id}</div>
              ))}
              <div style={{ marginTop: 8, fontSize: 10, color: '#8d8d8d' }}>Cache HF local ({modelsInfo.cache.length}) — clicável no Inspector; baixados:</div>
              {modelsInfo.cache.slice(0, 30).map((c) => (
                <div key={c} style={{ fontSize: 11, color: '#a8a8a8' }}>· {c}</div>
              ))}
              {modelsInfo.cache.length > 30 && <div style={{ fontSize: 10, color: '#8d8d8d' }}>… +{modelsInfo.cache.length - 30} no cache</div>}
            </div>
          </span>
        )}
      </div>
      <div className="app-body">
        <aside className="sidebar">
          <div className="section-title">Paleta — clique para ver o que cada nó faz</div>
          {Object.values(catalog).map((c) => {
            const desc = NODE_DESCRIPTIONS[c.type] ?? '(sem descrição)';
            const open = paletteOpen === c.type;
            return (
              <div key={c.type}>
                <div
                  className="palette-item"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/falador-node', c.type)}
                  onClick={() => setPaletteOpen(open ? null : c.type)}
                  onDoubleClick={() => addNode(c.type)}
                  title={`${desc}\nin: ${c.inputs.map((p) => p.type).join(', ') || '—'} | out: ${c.outputs.map((p) => p.name).join(', ') || '—'}\n(duplo clique adiciona ao canvas)`}
                  style={{ cursor: 'grab', borderLeft: `3px solid ${open ? '#0f62fe' : 'transparent'}` }}
                >
                  + {c.type}
                </div>
                {open && (
                  <div style={{ fontSize: 11, color: '#a8a8a8', padding: '4px 8px 8px', borderBottom: '1px solid #393939' }}>
                    {desc}
                    <div style={{ color: '#6f6f6f', marginTop: 3 }}>
                      entra: {c.inputs.map((p) => `${p.name}(${p.type})`).join(', ') || '—'} · sai: {c.outputs.map((p) => `${p.name}(${p.type})`).join(', ') || '—'}<br />
                      <span style={{ color: '#78a9ff' }}>duplo clique = adiciona ao canvas · ou arraste</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </aside>
        <div className="canvas-wrap" ref={rfWrap} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
          >
            <Background color="#393939" gap={18} />
            <Controls />
            <MiniMap pannable zoomable style={{ background: '#1e1e1e' }} />
          </ReactFlow>
        </div>
        <div className="mainbar">
          {selected ? (
            <Inspector node={selected} onUpdate={(d) => updateNode(selected.id, d)} onDuplicate={() => duplicateNode(selected.id)} onDelete={() => deleteNode(selected.id)} availableModels={modelsInfo?.omlx} fetchViaParam={doFetchViaParam} modelsVia={modelsVia} metrics={metrics[selected.id]} />
          ) : (
            <div style={{ color: '#8d8d8d', fontSize: 13 }}>Selecione um nó para editar parâmetros, modelo (RECOMENDADO + "?"→GitHub) e enabled.</div>
          )}
        </div>
      </div>
      <RunPanel flowGetter={getFlow} profiles={profiles} onMetrics={setMetrics} onSaveProfile={(name) => void doSaveProfile(name)} />
    </div>
  );
}
