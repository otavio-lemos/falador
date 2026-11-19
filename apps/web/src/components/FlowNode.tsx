// FlowNode — representação visual de um nó do catálogo no canvas (React Flow, ADR-003).
// Classes tokenizadas Carbon (index.scss); sem inline styles.
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Tag } from '@carbon/react';
import type { NodeMetrics } from '../api';

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
          <Tag type="red" size="sm">OFF</Tag>
        )}
      </div>
      {(data.inputs ?? []).map((p) => (
        <Handle key={`in-${p.name}`} id={p.name} type="target" position={Position.Left} className="fnode-handle" />
      ))}
      {(data.outputs ?? []).map((p) => (
        <Handle key={`out-${p.name}`} id={p.name} type="source" position={Position.Right} className="fnode-handle" />
      ))}
      <div className="fnode-ports">
        {(data.inputs ?? []).map((p) => (
          <div key={p.name} className="fnode-port">
            <span className="dot" />
            <span>
              {p.name} <span className="fnode-port-type">· {p.type}</span>
            </span>
          </div>
        ))}
        {(data.outputs ?? []).map((p) => (
          <div key={p.name} className="fnode-port out">
            <span>
              <span className="fnode-port-type">{p.type} · </span>
              {p.name}
            </span>
            <span className="dot" />
          </div>
        ))}
      </div>
      {paramCount > 0 && (
        <div className="fnode-paramcount">{paramCount} param(s)</div>
      )}
      {data.metrics && (
        <div className="fnode-metrics">
          <span>↓{data.metrics.in} ↑{data.metrics.out}</span>
          {data.metrics.procMsP50 != null && <span>· {Math.round(data.metrics.procMsP50)}ms</span>}
          {data.metrics.errors > 0 && <span className="fnode-metrics-err">⚠{data.metrics.errors}</span>}
        </div>
      )}
    </div>
  );
}
