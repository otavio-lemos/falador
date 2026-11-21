// Card de nó customizado do React Flow — header colorido por categoria + corpo
// (título humano + subtítulo + latência/status). Portas como handles laterais.
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Tag } from '@carbon/react';
import type { FNode } from '../flow-utils';

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
        <span className="fnode-id">{data.type}</span>
        {data.enabled === false && <span className="fnode-off-tag">OFF</span>}
      </div>
      <div className="fnode-body">
        <div className="fnode-title">{data.title}</div>
        <div className="fnode-sub">{data.subtitle}</div>
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
          className="fnode-handle"
          style={{ top: inTops[i] }}
          title={`in: ${p.name} (${p.type})`}
        />
      ))}
      {data.outputs.map((p, i) => (
        <Handle
          key={`out-${p.name}`}
          type="source"
          position={Position.Right}
          id={p.name}
          className="fnode-handle fnode-handle--out"
          style={{ top: outTops[i] }}
          title={`out: ${p.name} (${p.type})`}
        />
      ))}
    </div>
  );
});
FlowNode.displayName = 'FlowNode';