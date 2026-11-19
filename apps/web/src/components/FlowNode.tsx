// FlowNode — representação visual de um nó do catálogo no canvas.
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { CatalogEntry, NodeMetrics } from '../api';

export type FaladorNodeData = {
  type: string;
  sourceOnly: boolean;
  paramNames: string[];
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  params: Record<string, unknown>;
  enabled: boolean;
  metrics?: NodeMetrics; // ao vivo durante o run (overlay do App, não persiste no flow)
  [k: string]: unknown;
};

export type FaladorNode = Node<FaladorNodeData, 'falador'>;

export function FlowNode({ data, selected }: NodeProps<FaladorNode>) {
  const paramCount = Object.keys(data.params ?? {}).length;
  return (
    <div className={`fnode ${selected ? 'selected' : ''} ${data.enabled ? '' : 'disabled'}`}>
      <div className="fnode-head">
        <span>{data.type}</span>
        {!data.enabled && (
          <span className="badge-rec" style={{ background: '#da1e28', color: '#fff' }}>
            OFF
          </span>
        )}
      </div>
      {(data.inputs ?? []).map((p) => (
        <Handle key={`in-${p.name}`} id={p.name} type="target" position={Position.Left} style={{ top: 12 }} />
      ))}
      {(data.outputs ?? []).map((p) => (
        <Handle key={`out-${p.name}`} id={p.name} type="source" position={Position.Right} style={{ top: 12 }} />
      ))}
      <div className="fnode-ports">
        {(data.inputs ?? []).map((p) => (
          <div key={p.name} className="fnode-port">
            <span className="dot" />
            <span>
              {p.name} <span style={{ opacity: 0.6 }}>· {p.type}</span>
            </span>
          </div>
        ))}
        {(data.outputs ?? []).map((p) => (
          <div key={p.name} className="fnode-port out">
            <span>
              <span style={{ opacity: 0.6 }}>{p.type} · </span>
              {p.name}
            </span>
            <span className="dot" />
          </div>
        ))}
      </div>
      {paramCount > 0 && (
        <div style={{ padding: '0 8px 6px', color: '#8d8d8d', fontSize: 11 }}>{paramCount} param(s)</div>
      )}
      {data.metrics && (
        <div className="fnode-metrics">
          <span>↓{data.metrics.in} ↑{data.metrics.out}</span>
          {data.metrics.procMsP50 != null && <span>· {Math.round(data.metrics.procMsP50)}ms</span>}
          {data.metrics.errors > 0 && <span style={{ color: '#ff8389' }}>⚠{data.metrics.errors}</span>}
        </div>
      )}
    </div>
  );
}
