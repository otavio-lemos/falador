// Card de nó customizado do React Flow — header colorido por categoria + corpo
// (título humano + subtítulo + id + métricas) + seção dedicada de portas alinhadas
// com seus respectivos handles (inputs à esquerda = quadrado, outputs à direita = círculo).
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Tag } from '@carbon/react';
import type { FNode } from '../flow-utils';

// Cor por tipo de porta — igual em input e output do mesmo tipo, diferente entre tipos.
export const PORT_COLOR: Record<string, string> = {
  pcm16k:         '#06b6d4', // ciano   — áudio bruto
  tokens_parcial: '#a855f7', // roxo    — texto streaming
  phrase:         '#f59e0b', // âmbar   — texto completo
  audio_chunk:    '#22c55e', // verde   — áudio processado
  tool:           '#0ea5e9', // azul    — conector de ferramenta (bidirecional)
};
const PORT_COLOR_DEFAULT = '#6b7280';

function portColor(type: string) {
  return PORT_COLOR[type] ?? PORT_COLOR_DEFAULT;
}

export const FlowNode = memo(({ data, selected }: NodeProps<FNode>) => {
  const latency = data.metrics?.ttft ?? data.metrics?.p50;
  const maxPorts = Math.max(data.inputs.length, data.outputs.length);

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
        {(data.running && data.type.startsWith('capture') || latency != null || data.metrics) && (
          <div className="fnode-meta">
            {data.running && data.type.startsWith('capture') && (
              <Tag type="green" size="sm">Streaming</Tag>
            )}
            {latency != null && <span className="fnode-latency">{Math.round(latency)}ms</span>}
            {data.metrics && (
              <span className="fnode-io">↓{data.metrics.in} ↑{data.metrics.out}</span>
            )}
          </div>
        )}
      </div>

      {maxPorts > 0 && (
        <div className="fnode-ports">
          {Array.from({ length: maxPorts }, (_, i) => {
            const inp = data.inputs[i];
            const out = data.outputs[i];
            return (
              <div key={i} className="fnode-port-row">
                <div className="fnode-port-slot fnode-port-slot--in">
                  {inp && (
                    <>
                      <Handle
                        type="target"
                        position={Position.Left}
                        id={inp.name}
                        className="fnode-handle fnode-handle--in"
                        style={{
                          background: portColor(inp.type),
                          borderColor: portColor(inp.type),
                        }}
                        title={`Entrada ${inp.name} (${inp.type})`}
                      />
                      <span className="fnode-port-name" style={{ color: portColor(inp.type) }}>
                        {inp.name}
                      </span>
                    </>
                  )}
                </div>
                <div className="fnode-port-slot fnode-port-slot--out">
                  {out && (
                    <>
                      <span className="fnode-port-name" style={{ color: portColor(out.type) }}>
                        {out.name}
                      </span>
                      <Handle
                        type="source"
                        position={Position.Right}
                        id={out.name}
                        className="fnode-handle fnode-handle--out"
                        style={{
                          background: portColor(out.type),
                          borderColor: portColor(out.type),
                        }}
                        title={`Saída ${out.name} (${out.type})`}
                      />
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
FlowNode.displayName = 'FlowNode';
