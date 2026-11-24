// Canvas React Flow + editor INLINE ancorado no nó selecionado (acompanha pan/zoom/drag).
import { useCallback, useMemo } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap,
  useViewport, useReactFlow, MarkerType, ConnectionMode,
  type Edge, type OnNodesChange, type OnEdgesChange, type OnConnect,
  type IsValidConnection,
} from '@xyflow/react';
import { FlowNode, PORT_COLOR } from './FlowNode';
import { NodeEditor } from './NodeEditor';
import type { FNode, FaladorNodeData } from '../flow-utils';
import { nodeDisplayNames } from '../live-utils';
import type { NodeMetrics, RunnerEvent, RunSnapshot } from '../api';

const nodeTypes = { falador: FlowNode };

function edgeColor(type: string) {
  return PORT_COLOR[type] ?? '#6b7280';
}

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

  // nome exibido = o mesmo do workflow ("Input 1", "Output 2"…), nunca o rótulo genérico
  const names = useMemo(
    () => nodeDisplayNames(
      p.nodes.map((n) => ({ id: n.id, type: n.data.type, params: n.data.params })),
      p.edges.map((e) => ({ from: e.source, to: e.target })),
    ),
    [p.nodes, p.edges],
  );

  // enriquece nós com nome real + métricas/running
  const nodes = useMemo(() => p.nodes.map((n) => ({
    ...n,
    data: { ...n.data, title: names.get(n.id)?.label ?? n.data.title, metrics: p.metrics[n.id], running: p.running },
  })), [p.nodes, p.metrics, p.running, names]);

  // arestas coloridas pelo tipo real da porta e contexto bidirecional
  const edges = useMemo(() => p.edges.map((e) => {
    const src = p.nodes.find((n) => n.id === e.source);
    const tgt = p.nodes.find((n) => n.id === e.target);
    const isBranch = src?.data.type === 'decision.llm' && tgt?.data.type !== 'agent.tools';
    const isAgentOut = src?.data.type === 'agent.tools' && (tgt?.data.type === 'sink.captions' || tgt?.data.type === 'sink.playback');

    // Identificação de conexões com capacidades / ferramentas do agente
    const isDecider =
      e.sourceHandle === 'decider' ||
      e.targetHandle === 'decider' ||
      src?.id === 'decisor_d1' ||
      tgt?.id === 'decisor_d1' ||
      (src?.data.type === 'decision.llm' && tgt?.data.type === 'agent.tools') ||
      (tgt?.data.type === 'decision.llm' && src?.data.type === 'agent.tools');

    const isGate =
      e.sourceHandle === 'gate' ||
      e.targetHandle === 'gate' ||
      src?.id === 'gate_humano' ||
      tgt?.id === 'gate_humano' ||
      (src?.data.type === 'human.approve' && tgt?.data.type === 'agent.tools') ||
      (tgt?.data.type === 'human.approve' && src?.data.type === 'agent.tools');

    const isValidator =
      e.sourceHandle === 'validator' ||
      e.targetHandle === 'validator' ||
      src?.id === 'validador_objetivo' ||
      tgt?.id === 'validador_objetivo' ||
      src?.data.type === 'goal.validator' ||
      tgt?.data.type === 'goal.validator';

    const isTool =
      e.sourceHandle === 'tool' ||
      e.targetHandle === 'tool' ||
      e.targetHandle === 'tools' ||
      src?.data.type.startsWith('tool.') ||
      src?.data.type === 'exec.command' ||
      src?.data.type === 'rag.search' ||
      tgt?.data.type.startsWith('tool.') ||
      tgt?.data.type === 'exec.command' ||
      tgt?.data.type === 'rag.search';

    const isBidirectional = isDecider || isGate || isValidator || isTool;

    // Determina cor
    let color: string;
    const toolNode = (src?.data.type.startsWith('tool.') || src?.data.type === 'exec.command' || src?.data.type === 'rag.search')
      ? src
      : tgt;

    if (isDecider) {
      color = PORT_COLOR.decider ?? '#f59e0b';
    } else if (isGate) {
      color = PORT_COLOR.gate ?? '#ec4899';
    } else if (isValidator) {
      color = PORT_COLOR.validator ?? '#10b981';
    } else if (toolNode?.data.type === 'exec.command' || toolNode?.data.type === 'tool.mcp') {
      const isExecActive = toolNode.data.params?.dryRun === false;
      color = isExecActive ? '#da1e28' : '#0ea5e9'; // Vermelho p/ EXEC ATIVO, azul p/ DRY-RUN
    } else if (isTool) {
      color = PORT_COLOR.tool ?? '#0ea5e9';
    } else {
      const srcPort = src?.data.outputs.find((o) => o.name === e.sourceHandle);
      const portType = srcPort?.type ?? (isBranch ? 'tokens_parcial' : '');
      color = edgeColor(portType);
    }

    // Determina rótulo contextual
    let label: string | undefined;
    if (isDecider) {
      label = 'risco / d1';
    } else if (isGate) {
      label = 'aprovação';
    } else if (isValidator) {
      label = 'validação';
    } else if (toolNode?.data.type === 'exec.command') {
      label = 'comando / stdout·stderr';
    } else if (toolNode?.data.type === 'rag.search' || toolNode?.data.type === 'tool.web_search') {
      label = 'consulta / trechos';
    } else if (toolNode?.data.type === 'tool.crawler') {
      label = 'crawler / páginas';
    } else if (toolNode?.data.type === 'tool.mcp') {
      label = 'mcp / chamada·resposta';
    } else if (toolNode?.data.type === 'tool.workflow') {
      label = 'workflow / schema';
    } else if (isTool) {
      label = 'tool / retorno';
    } else if (isBranch) {
      label = String(e.sourceHandle ?? '');
    } else if (isAgentOut) {
      label = 'saída';
    }

    return {
      ...e,
      type: 'smoothstep',
      label,
      labelStyle: { fill: '#f4f4f4', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: '#161616', stroke: '#3a3a3a', strokeWidth: 1 },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      style: {
        stroke: color,
        strokeWidth: isBidirectional ? 2.5 : 2,
        strokeDasharray: isBidirectional ? '6 3' : undefined,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      markerStart: isBidirectional ? { type: MarkerType.ArrowClosed, color, width: 14, height: 14 } : undefined,
    };
  }), [p.edges, p.nodes]);

  // só permite conexão entre portas do mesmo tipo
  const isValidConnection = useCallback<IsValidConnection>((connection) => {
    const srcNode = p.nodes.find((n) => n.id === connection.source);
    const tgtNode = p.nodes.find((n) => n.id === connection.target);
    if (!srcNode || !tgtNode) return false;
    const srcPort = srcNode.data.outputs.find((o) => o.name === connection.sourceHandle);
    const tgtPort = tgtNode.data.inputs.find((i) => i.name === connection.targetHandle);
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
        fitView fitViewOptions={{ padding: 0.16, maxZoom: 0.95, minZoom: 0.4 }}
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
          nodes={nodes} selectedId={p.selectedId}
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
  const nodeW = (node.measured?.width ?? 240) * vp.zoom;
  const sx = node.position.x * vp.zoom + vp.x;
  const sy = node.position.y * vp.zoom + vp.y;
  let left = sx + nodeW + 14;
  if (left + W > window.innerWidth - 16) left = Math.max(16, sx - W - 14);
  const top = Math.max(16, Math.min(sy, window.innerHeight - 500));
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
