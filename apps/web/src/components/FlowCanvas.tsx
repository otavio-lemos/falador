// Canvas React Flow + editor INLINE ancorado no nó selecionado (acompanha pan/zoom/drag).
import { useCallback, useMemo } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  useViewport, useReactFlow, MarkerType, ConnectionMode,
  type Node, type Edge, type OnNodesChange, type OnEdgesChange, type OnConnect,
  type IsValidConnection,
} from '@xyflow/react';
import { FlowNode } from './FlowNode';
import { NodeEditor } from './NodeEditor';
import type { FNode, FaladorNodeData } from '../flow-utils';
import type { NodeMetrics, RunnerEvent, RunSnapshot } from '../api';

const nodeTypes = { falador: FlowNode };

// Cor da aresta = cor do tipo de porta (igual ao PORT_COLOR do FlowNode)
const EDGE_COLOR: Record<string, string> = {
  pcm16k:        '#06b6d4',
  tokens_parcial:'#a855f7',
  phrase:        '#f59e0b',
  audio_chunk:   '#22c55e',
};
function edgeColor(type: string) { return EDGE_COLOR[type] ?? '#5a5a5a'; }

interface Props {
  nodes: FNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<FNode>;
  onEdgesChange: OnEdgesChange<Edge>;
  onConnect: OnConnect;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onParamsChange: (id: string, params: Record<string, unknown>) => void;
  onAddNode: (type: string, pos: { x: number; y: number }) => void;
  metrics: RunSnapshot;
  events: RunnerEvent[];
  running: boolean;
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  onRefreshApps: () => void;
}

export function FlowCanvas(p: Props) {
  const { screenToFlowPosition } = useReactFlow();

  // enriquece nós com métricas/running
  const nodes = useMemo(() => p.nodes.map((n) => ({
    ...n,
    data: { ...n.data, metrics: p.metrics[n.id], running: p.running },
  })), [p.nodes, p.metrics, p.running]);

  // arestas coloridas pelo tipo da porta de saída (mesmo esquema do FlowNode)
  const edges = useMemo(() => p.edges.map((e) => {
    const src = p.nodes.find((n) => n.id === e.source);
    const isBranch = src?.data.type === 'decision.llm';
    // descobre o tipo da porta fonte para colorir a aresta igual à bolinha
    // decision.llm tem outputs dinâmicos (não estão no catálogo estático) — tipo = phrase
    const srcPort = src?.data.outputs.find((o) => o.name === e.sourceHandle);
    const portType = srcPort?.type ?? (isBranch ? 'phrase' : undefined);
    const color = isBranch
      ? edgeColor('phrase')
      : edgeColor(portType ?? '');
    return {
      ...e,
      type: 'smoothstep',
      label: isBranch ? String(e.sourceHandle ?? '') : undefined,
      labelStyle: { fill: '#f4f4f4', fontSize: 11 },
      labelBgStyle: { fill: '#161616' },
      style: { stroke: color, strokeWidth: 2 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    };
  }), [p.edges, p.nodes]);

  // só permite conexão entre portas do mesmo tipo
  // decision.llm: outputs dinâmicos (tipo phrase) — trata como phrase
  const isValidConnection = useCallback<IsValidConnection>((connection) => {
    const srcNode = p.nodes.find((n) => n.id === connection.source);
    const tgtNode = p.nodes.find((n) => n.id === connection.target);
    if (!srcNode || !tgtNode) return false;
    const srcPort = srcNode.data.outputs.find((o) => o.name === connection.sourceHandle);
    const tgtPort = tgtNode.data.inputs.find((i) => i.name === connection.targetHandle);
    // sem info de tipo numa das pontas = permissivo (nó com outputs dinâmicos)
    if (!srcPort || !tgtPort) return true;
    return srcPort.type === tgtPort.type;
  }, [p.nodes]);

  return (
    <div
      className="canvas-wrap"
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
      onDrop={(e) => {
        e.preventDefault();
        const type = e.dataTransfer.getData('application/falador-node');
        if (!type) return;
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        p.onAddNode(type, pos);
      }}
    >
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={p.onNodesChange} onEdgesChange={p.onEdgesChange} onConnect={p.onConnect}
        onNodeClick={(_, n) => p.onSelect(n.id)}
        onPaneClick={() => p.onSelect(null)}
        connectionMode={ConnectionMode.Strict}
        isValidConnection={isValidConnection}
        fitView fitViewOptions={{ padding: 0.12, maxZoom: 0.9, minZoom: 0.4 }}
        minZoom={0.3} maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.5} color="#2e2e2e" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right" pannable zoomable
          nodeColor={(n) => (n.data as FaladorNodeData).accent ?? '#525252'}
          maskColor="rgba(13,13,13,0.7)"
          style={{ background: '#141414', border: '1px solid #333' }}
        />
      </ReactFlow>
      {p.selectedId && (
        <EditorAnchor
          nodes={p.nodes} selectedId={p.selectedId}
          onChange={(params) => p.onParamsChange(p.selectedId!, params)}
          onClose={() => p.onSelect(null)}
          metrics={p.metrics[p.selectedId]} events={p.events}
          models={p.models} apps={p.apps} onRefreshApps={p.onRefreshApps}
        />
      )}
    </div>
  );
}

// Posiciona o editor em coordenadas de TELA, ao lado do nó (direita; esquerda se não couber).
function EditorAnchor({ nodes, selectedId, onChange, onClose, metrics, events, models, apps, onRefreshApps }: {
  nodes: FNode[]; selectedId: string;
  onChange: (params: Record<string, unknown>) => void; onClose: () => void;
  metrics?: NodeMetrics; events: RunnerEvent[];
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  onRefreshApps: () => void;
}) {
  const vp = useViewport();
  const node = nodes.find((n) => n.id === selectedId);
  if (!node) return null;
  const W = 480;
  const nodeW = (node.measured?.width ?? 210) * vp.zoom;
  const sx = node.position.x * vp.zoom + vp.x;
  const sy = node.position.y * vp.zoom + vp.y;
  let left = sx + nodeW + 14;
  if (left + W > window.innerWidth - 16) left = Math.max(16, sx - W - 14);
  const top = Math.max(76, Math.min(sy, window.innerHeight - 460));
  return (
    <div className="node-editor-anchor" style={{ left, top }}>
      <NodeEditor
        nodeId={selectedId} data={node.data}
        onChange={onChange} onClose={onClose} metrics={metrics} events={events}
        models={models} apps={apps} onRefreshApps={onRefreshApps}
      />
    </div>
  );
}