// Mini-mapa executivo do workflow para o cabeçalho do LiveView.
// Mostra apenas a cor da categoria + o nome curto de cada componente e os links reais (edges),
// destacando e ampliando o(s) nó(s) que estiverem em execução no momento.
import { useMemo } from 'react';
import type { Flow } from '../api';
import { accentOf } from '../data';
import { isRaia2Node } from '../flow-utils';
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

    const hasAgent = activeNodes.some((n) => n.type === 'agent.tools');
    const raia1Nodes = activeNodes.filter((n) => !isRaia2Node(n, hasAgent));
    const raia2Nodes = activeNodes.filter((n) => isRaia2Node(n, hasAgent));

    const r1List = raia2Nodes.length === 0 ? activeNodes : raia1Nodes;
    const r1Ids = new Set(r1List.map((n) => n.id));
    const edges1 = edges.filter((e) => r1Ids.has(e.from) && r1Ids.has(e.to));

    // Atribui coluna (profundidade topológica) a cada nó da Raia 1
    const depth1 = new Map<string, number>();
    const indeg1 = new Map<string, number>();
    const adj1 = new Map<string, string[]>();
    for (const n of r1List) {
      depth1.set(n.id, 0);
      indeg1.set(n.id, 0);
      adj1.set(n.id, []);
    }
    for (const e of edges1) {
      adj1.get(e.from)!.push(e.to);
      indeg1.set(e.to, (indeg1.get(e.to) ?? 0) + 1);
    }
    const q1: string[] = [];
    for (const n of r1List) {
      if ((indeg1.get(n.id) ?? 0) === 0) q1.push(n.id);
    }
    const visited1 = new Set<string>();
    while (q1.length) {
      const u = q1.shift()!;
      visited1.add(u);
      const du = depth1.get(u) ?? 0;
      for (const v of adj1.get(u) ?? []) {
        depth1.set(v, Math.max(depth1.get(v) ?? 0, du + 1));
        const nextDeg = (indeg1.get(v) ?? 1) - 1;
        indeg1.set(v, nextDeg);
        if (nextDeg === 0) q1.push(v);
      }
    }
    for (const n of r1List) {
      if (!visited1.has(n.id)) depth1.set(n.id, 0);
    }

    const byCol1 = new Map<number, typeof r1List>();
    for (const n of r1List) {
      const c = depth1.get(n.id) ?? 0;
      (byCol1.get(c) ?? byCol1.set(c, []).get(c)!).push(n);
    }

    const cols1 = [...byCol1.keys()].sort((a, b) => a - b);
    const maxRows1 = Math.max(1, ...cols1.map((c) => byCol1.get(c)!.length));
    const nodeW = 86;
    const nodeH = 24;
    const colGap = 20;
    const rowGap = 8;
    const padX = 10;
    const padY = 8;

    const raia1H = maxRows1 * nodeH + Math.max(0, maxRows1 - 1) * rowGap;

    const placed: PlacedNode[] = [];
    const byId = new Map<string, PlacedNode>();

    cols1.forEach((c) => {
      const list = byCol1.get(c)!;
      const colH = list.length * nodeH + Math.max(0, list.length - 1) * rowGap;
      const startY = padY + (raia1H - colH) / 2;
      list.forEach((n, ri) => {
        const pn: PlacedNode = {
          id: n.id,
          label: names.get(n.id)?.label ?? n.id,
          accent: accentOf(n.type),
          off: n.enabled === false,
          col: c,
          row: ri,
          x: padX + c * (nodeW + colGap),
          y: startY + ri * (nodeH + rowGap),
        };
        placed.push(pn);
        byId.set(n.id, pn);
      });
    });

    let totalRaia2Rows = 0;
    let maxColUsed = Math.max(0, ...cols1);

    if (raia2Nodes.length > 0) {
      const agentNode = r1List.find((n) => n.type === 'agent.tools') ?? r1List.find((n) => n.type.startsWith('llm.'));
      const agentCol = agentNode ? (depth1.get(agentNode.id) ?? 2) : 2;
      const startCol = Math.max(1, agentCol - 1);
      const raia2StartY = padY + raia1H + 14;

      const isCapability = (n: typeof raia2Nodes[0]) =>
        n.type === 'goal.validator' ||
        n.type === 'decision.llm' ||
        n.type === 'human.approve' ||
        n.id === 'decisor_d1' ||
        n.id === 'gate_humano' ||
        n.id === 'validador_objetivo';

      const capRank = (n: typeof raia2Nodes[0]) => {
        if (n.id === 'decisor_d1' || n.type === 'decision.llm') return 0;
        if (n.id === 'gate_humano' || n.type === 'human.approve') return 1;
        if (n.id === 'validador_objetivo' || n.type === 'goal.validator') return 2;
        return 3;
      };
      const capNodes = raia2Nodes.filter(isCapability).sort((a, b) => capRank(a) - capRank(b));
      const toolNodes = raia2Nodes.filter((n) => !isCapability(n));

      let curR2Row = 0;
      if (capNodes.length > 0) {
        capNodes.forEach((n, i) => {
          const colInRow = i % 3;
          const r = curR2Row + Math.floor(i / 3);
          const col = startCol + colInRow;
          maxColUsed = Math.max(maxColUsed, col);
          const pn: PlacedNode = {
            id: n.id,
            label: names.get(n.id)?.label ?? n.id,
            accent: accentOf(n.type),
            off: n.enabled === false,
            col,
            row: maxRows1 + r,
            x: padX + col * (nodeW + colGap),
            y: raia2StartY + r * (nodeH + rowGap),
          };
          placed.push(pn);
          byId.set(n.id, pn);
        });
        curR2Row += Math.ceil(capNodes.length / 3);
      }

      if (toolNodes.length > 0) {
        toolNodes.forEach((n, i) => {
          const colInRow = i % 3;
          const r = curR2Row + Math.floor(i / 3);
          const col = startCol + colInRow;
          maxColUsed = Math.max(maxColUsed, col);
          const pn: PlacedNode = {
            id: n.id,
            label: names.get(n.id)?.label ?? n.id,
            accent: accentOf(n.type),
            off: n.enabled === false,
            col,
            row: maxRows1 + r,
            x: padX + col * (nodeW + colGap),
            y: raia2StartY + r * (nodeH + rowGap),
          };
          placed.push(pn);
          byId.set(n.id, pn);
        });
        curR2Row += Math.ceil(toolNodes.length / 3);
      }
      totalRaia2Rows = curR2Row;
    }

    const totalCols = maxColUsed + 1;
    const totalW = Math.max(180, padX * 2 + totalCols * nodeW + Math.max(0, totalCols - 1) * colGap);
    const totalH = Math.max(
      56,
      padY * 2 + raia1H + (totalRaia2Rows > 0 ? 14 + totalRaia2Rows * nodeH + Math.max(0, totalRaia2Rows - 1) * rowGap : 0)
    );

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
