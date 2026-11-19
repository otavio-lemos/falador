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
import { fetchCatalog, fetchFlow, fetchFlowList, saveFlow, type CatalogEntry, type Flow } from './api';

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

function rfToFlow(nodes: FaladorNode[], edges: RFEdge[]): Flow {
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    stopWhenSourcesDone: false,
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
  const [flowList, setFlowList] = useState<string[]>([]);
  const [currentName, setCurrentName] = useState<string>('cenario1-pt');
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
    const flow = rfToFlow(nodes as FaladorNode[], edges);
    await saveFlow(currentName, flow);
    fetchFlowList().then(setFlowList).catch(() => undefined);
    alert(`Salvo em apps/tui/flows/${currentName}.json`);
  }, [nodes, edges, currentName]);

  const doLoad = useCallback(async (name: string) => {
    const f = await fetchFlow(name);
    const { nodes: n, edges: e } = flowToRf(f, catalog);
    setNodes(n);
    setEdges(e);
    setCurrentName(name);
  }, [catalog, setNodes, setEdges]);

  const selected = useMemo(() => nodes.find((n) => n.id === selectedId) as FaladorNode | undefined, [nodes, selectedId]);

  const getFlow = useCallback(() => rfToFlow(nodes as FaladorNode[], edges), [nodes, edges]);

  return (
    <div className="app">
      <div className="toolbar">
        <strong style={{ marginRight: 8 }}>Falador</strong>
        <select value={currentName} onChange={(e) => doLoad(e.target.value)} style={{ background: '#262626', color: '#f4f4f4', border: '1px solid #393939', padding: '4px 8px', borderRadius: 4 }}>
          {flowList.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <button onClick={doSave} style={{ background: '#0f62fe', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 4, cursor: 'pointer' }}>
          Salvar
        </button>
        <span style={{ color: '#8d8d8d', fontSize: 12 }}>
          arraste da paleta · ligue portas · Salvar → Run usa apps/tui/flows/{currentName}.json
        </span>
      </div>
      <div className="app-body">
        <aside className="sidebar">
          <div className="section-title">Paleta (catálogo do runner)</div>
          {Object.values(catalog).map((c) => (
            <div
              key={c.type}
              className="palette-item"
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/falador-node', c.type)}
              onDoubleClick={() => addNode(c.type)}
              title={`in: ${c.inputs.map((p) => p.type).join(',') || '—'} | out: ${c.outputs.map((p) => p.type).join(',') || '—'}`}
            >
              + {c.type}
            </div>
          ))}
        </aside>
        <div className="canvas-wrap" ref={rfWrap} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
          <ReactFlow
            nodes={nodes}
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
            <Inspector node={selected} onUpdate={(d) => updateNode(selected.id, d)} onDuplicate={() => duplicateNode(selected.id)} onDelete={() => deleteNode(selected.id)} />
          ) : (
            <div style={{ color: '#8d8d8d', fontSize: 13 }}>Selecione um nó para editar parâmetros, modelo (RECOMENDADO + "?"→GitHub) e enabled.</div>
          )}
        </div>
      </div>
      <RunPanel flowGetter={getFlow} />
    </div>
  );
}
