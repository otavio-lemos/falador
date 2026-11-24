// Mini-mapa executivo do workflow para o cabeçalho do LiveView.
// Mostra apenas a cor da categoria + o nome curto de cada componente e os links reais (edges),
// destacando e ampliando o(s) nó(s) que estiverem em execução no momento.
import { useMemo } from 'react';
import type { Flow } from '../api';
import { accentOf } from '../data';
import { nodeDisplayNames } from '../live-utils';

interface Props {
  flow: Flow;
  activeNodeIds: Set<string>;
  running: boolean;
}

interface PlacedNode {
  id: string;
  label: string;
  accent: string;
  off: boolean;
  col: number;
  row: number;
  x: number;
  y: number;
}

export function WorkflowMiniMap({ flow, activeNodeIds, running }: Props) {
  const layout = useMemo(() => {
    const names = nodeDisplayNames(flow.nodes, flow.edges);
    // TODOS os nós, desligados inclusive: o mapa tem que ser o mesmo workflow do Builder.
    const activeNodes = flow.nodes;
    const idSet = new Set(activeNodes.map((n) => n.id));
    const edges = flow.edges
      .map((e) => ({ from: e.from.split('.')[0], to: e.to.split('.')[0] }))
      .filter((e) => idSet.has(e.from) && idSet.has(e.to) && e.from !== e.to);

    // Atribui coluna (profundidade topológica) a cada nó
    const depth = new Map<string, number>();
    const indeg = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const n of activeNodes) {
      depth.set(n.id, 0);
      indeg.set(n.id, 0);
      adj.set(n.id, []);
    }
    for (const e of edges) {
      adj.get(e.from)!.push(e.to);
      indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    }
    const q: string[] = [];
    for (const n of activeNodes) {
      if ((indeg.get(n.id) ?? 0) === 0) q.push(n.id);
    }
    const visited = new Set<string>();
    while (q.length) {
      const u = q.shift()!;
      visited.add(u);
      const du = depth.get(u) ?? 0;
      for (const v of adj.get(u) ?? []) {
        depth.set(v, Math.max(depth.get(v) ?? 0, du + 1));
        const nextDeg = (indeg.get(v) ?? 1) - 1;
        indeg.set(v, nextDeg);
        if (nextDeg === 0) q.push(v);
      }
    }
    // Fallback para nós desconectados/ciclos
    for (const n of activeNodes) {
      if (!visited.has(n.id)) depth.set(n.id, 0);
    }

    const byCol = new Map<number, typeof activeNodes>();
    for (const n of activeNodes) {
      const c = depth.get(n.id) ?? 0;
      (byCol.get(c) ?? byCol.set(c, []).get(c)!).push(n);
    }

    const cols = [...byCol.keys()].sort((a, b) => a - b);
    const maxRows = Math.max(1, ...cols.map((c) => byCol.get(c)!.length));
    const nodeW = 86;
    const nodeH = 24;
    const colGap = 24;
    const rowGap = 10;
    const padX = 10;
    const padY = 8;

    const totalW = Math.max(180, padX * 2 + cols.length * nodeW + Math.max(0, cols.length - 1) * colGap);
    const totalH = Math.max(56, padY * 2 + maxRows * nodeH + Math.max(0, maxRows - 1) * rowGap);

    const placed: PlacedNode[] = [];
    const byId = new Map<string, PlacedNode>();

    cols.forEach((c, ci) => {
      const list = byCol.get(c)!;
      const colH = list.length * nodeH + Math.max(0, list.length - 1) * rowGap;
      const startY = (totalH - colH) / 2;
      list.forEach((n, ri) => {
        const pn: PlacedNode = {
          id: n.id,
          label: names.get(n.id)?.label ?? n.id,
          accent: accentOf(n.type),
          off: n.enabled === false,
          col: ci,
          row: ri,
          x: padX + ci * (nodeW + colGap),
          y: startY + ri * (nodeH + rowGap),
        };
        placed.push(pn);
        byId.set(n.id, pn);
      });
    });

    return { placed, byId, edges, nodeW, nodeH, totalW, totalH };
  }, [flow]);

  if (layout.placed.length === 0) {
    return <div className="wf-minimap wf-minimap--empty">Sem componentes no workflow</div>;
  }

  return (
    <div className="wf-minimap" aria-label="Mapa de execução do workflow">
      <svg
        className="wf-minimap-svg"
        viewBox={`0 0 ${layout.totalW} ${layout.totalH}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker id="mm-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--cds-border-strong-01, #6f6f6f)" />
          </marker>
          <marker id="mm-arrow-active" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--cds-interactive, #4589ff)" />
          </marker>
        </defs>

        {layout.edges.map((e, idx) => {
          const a = layout.byId.get(e.from);
          const b = layout.byId.get(e.to);
          if (!a || !b) return null;
          const x1 = a.x + layout.nodeW;
          const y1 = a.y + layout.nodeH / 2;
          const x2 = b.x;
          const y2 = b.y + layout.nodeH / 2;
          const midX = x1 + (x2 - x1) / 2;
          const isHot = running && (activeNodeIds.has(a.id) || activeNodeIds.has(b.id));
          return (
            <path
              key={`${e.from}-${e.to}-${idx}`}
              d={`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`}
              fill="none"
              stroke={isHot ? 'var(--cds-interactive, #4589ff)' : 'var(--cds-border-strong-01, #6f6f6f)'}
              strokeWidth={isHot ? 1.8 : 1.1}
              markerEnd={isHot ? 'url(#mm-arrow-active)' : 'url(#mm-arrow)'}
              opacity={isHot ? 1 : 0.7}
            />
          );
        })}

        {layout.placed.map((n) => {
          const isActive = running && activeNodeIds.has(n.id);
          const opacity = n.off && !isActive ? 0.45 : 1;
          const cx = n.x + layout.nodeW / 2;
          const cy = n.y + layout.nodeH / 2;
          return (
            <g
              key={n.id}
              className={`wf-mm-node${isActive ? ' wf-mm-node--active' : ''}${n.off ? ' wf-mm-node--off' : ''}`}
              style={{ transformOrigin: `${cx}px ${cy}px` }}
              opacity={opacity}
            >
              <rect
                x={n.x}
                y={n.y}
                width={layout.nodeW}
                height={layout.nodeH}
                rx={0}
                fill={isActive ? n.accent : 'var(--cds-layer-02, #262626)'}
                fillOpacity={isActive ? 0.24 : 1}
                stroke={isActive ? n.accent : 'var(--cds-border-subtle-01, #393939)'}
                strokeWidth={isActive ? 2 : 1}
                strokeDasharray={n.off ? '4 3' : undefined}
              />
              <rect
                x={n.x}
                y={n.y}
                width={layout.nodeW}
                height={3}
                rx={0}
                fill={n.accent}
              />
              <text
                x={cx}
                y={cy + 4}
                textAnchor="middle"
                fontSize={isActive ? 10 : 9}
                fontWeight={isActive ? 700 : 500}
                fill="var(--cds-text-primary, #f4f4f4)"
                fontFamily="'IBM Plex Sans', sans-serif"
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
