// Card de nó customizado do React Flow — header colorido por categoria + corpo
// (título humano + subtítulo + latência/status). Portas com cor por tipo (estilo ComfyUI):
// inputs = quadrado, outputs = círculo. Só conecta porta com porta do mesmo tipo.
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Tag } from '@carbon/react';
import type { FNode } from '../flow-utils';

// Cor por tipo de porta — igual em input e output do mesmo tipo, diferente entre tipos.
const PORT_COLOR: Record<string, string> = {
  pcm16k:        '#06b6d4', // ciano   — áudio bruto
  tokens_parcial:'#a855f7', // roxo    — texto streaming
  phrase:        '#f59e0b', // âmbar   — texto completo
  audio_chunk:   '#22c55e', // verde   — áudio processado
};
const PORT_COLOR_DEFAULT = '#6b7280';

function portColor(type: string) {
  return PORT_COLOR[type] ?? PORT_COLOR_DEFAULT;
}

function handleTops(count: number): string[] {
  if (count <= 1) return ['50%'];
  return Array.from({ length: count }, (_, i) => `${20 + (60 * i) / (count - 1)}%`);
}

export const FlowNode = memo(({ data, selected }: NodeProps<FNode>) => {
  const inTops = handleTops(data.inputs.length);
  const outTops = handleTops(data.outputs.length);
  const latency = data.metrics?.ttft ?? data.metrics?.p50;
  return (
    <div
      className={`fnode${selected ? ' fnode--selected' : ''}${data.enabled === false ? ' fnode--off' : ''}`}
      style={{ ['--accent' as string]: data.accent }}
    >
      <div className="fnode-header">
        <span className="fnode-title-main">{data.title}</span>
        {data.enabled === false && <span className="fnode-off-tag">OFF</span>}
      </div>
      <div className="fnode-body">
        <div className="fnode-sub">{data.subtitle}</div>
        <div className="fnode-type-id">{data.type}</div>
        <div className="fnode-meta">
          {data.running && data.type.startsWith('capture') && (
            <Tag type="green" size="sm">Streaming</Tag>
          )}
          {latency != null && <span className="fnode-latency">{Math.round(latency)}ms</span>}
          {data.metrics && (
            <span className="fnode-io">↓{data.metrics.in} ↑{data.metrics.out}</span>
          )}
        </div>
      </div>
      {data.inputs.map((p, i) => (
        <Handle
          key={`in-${p.name}`}
          type="target"
          position={Position.Left}
          id={p.name}
          className="fnode-handle fnode-handle--in"
          style={{
            top: inTops[i],
            background: portColor(p.type),
            borderColor: portColor(p.type),
          }}
          title={`← ${p.name}: ${p.type}`}
        />
      ))}
      {data.outputs.map((p, i) => (
        <Handle
          key={`out-${p.name}`}
          type="source"
          position={Position.Right}
          id={p.name}
          className="fnode-handle fnode-handle--out"
          style={{
            top: outTops[i],
            background: portColor(p.type),
            borderColor: portColor(p.type),
          }}
          title={`→ ${p.name}: ${p.type}`}
        />
      ))}
      {/* legenda de portas só quando selecionado */}
      {selected && (data.inputs.length > 0 || data.outputs.length > 0) && (
        <div className="fnode-port-legend">
          {data.inputs.map((p) => (
            <span key={`li-${p.name}`} className="fnode-port-label fnode-port-label--in" style={{ color: portColor(p.type) }}>
              ← {p.name}
            </span>
          ))}
          {data.outputs.map((p) => (
            <span key={`lo-${p.name}`} className="fnode-port-label fnode-port-label--out" style={{ color: portColor(p.type) }}>
              {p.name} →
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
FlowNode.displayName = 'FlowNode';