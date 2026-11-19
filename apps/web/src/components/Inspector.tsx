// Inspector — edita params/enabled do nó selecionado + registro de modelos (ADR-004).
import { MODEL_REGISTRY } from '../model-registry';
import type { FaladorNode } from './FlowNode';

const MODEL_BY_PARAM: Record<string, typeof MODEL_REGISTRY> = {};
for (const m of MODEL_REGISTRY) {
  (MODEL_BY_PARAM[m.param] ??= []).push(m);
}

const GITHUB_LINKS: Record<string, string> = {
  'lfm3': 'https://huggingface.co/LiquidAI/LFM3-Audio-2B-MLX-8bit',
}

export function Inspector({ node, onUpdate, onDuplicate, onDelete }: { node: FaladorNode; onUpdate: (d: Partial<FaladorNode['data']>) => void; onDuplicate: () => void; onDelete: () => void }) {
  const { type, params, enabled } = node.data;
  const paramNames = node.data.paramNames ?? [];
  const suggested = MODEL_REGISTRY.find((m) => m.param === 'model' && (type.includes(m.kind) || (type === 'llm.omlx' && m.kind === 'llm')));

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="section-title">Nó selecionado: {type}</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onUpdate({ enabled: e.target.checked })} /> enabled
      </label>
      {paramNames.map((p) => {
        const cur = (params as Record<string, unknown>)[p];
        const models = MODEL_BY_PARAM[p];
        return (
          <div key={p} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, color: '#8d8d8d' }}>{p}</div>
            {models ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select
                  value={typeof cur === 'string' ? cur : models.find((m) => m.recommended)?.id ?? ''}
                  onChange={(e) => {
                    const m = models.find((mm) => mm.id === e.target.value);
                    onUpdate({ params: { ...params, [p]: m?.url ?? e.target.value } });
                  }}
                  style={{ flex: 1, background: '#262626', color: '#f4f4f4', border: '1px solid #525252', padding: '4px 6px', borderRadius: 4 }}
                >
                  <option value="">— selecione —</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} {m.recommended ? '★ RECOMENDADO' : ''}
                    </option>
                  ))}
                </select>
                <a href={models[0].url} target="_blank" rel="noreferrer" title="GitHub/HF do modelo (ADR-004)" style={{ color: '#78a9ff' }}>?</a>
              </div>
            ) : (
              <input
                value={cur === undefined ? '' : cur === null ? '' : String(cur)}
                onChange={(e) => {
                  const raw = e.target.value;
                  onUpdate({ params: { ...params, [p]: raw === '' ? undefined : parseScalar(raw) } });
                }}
                placeholder={suggested && paramNames.includes('model') ? undefined : String(p)}
                style={{ width: '100%', background: '#262626', color: '#f4f4f4', border: '1px solid #525252', padding: '4px 6px', borderRadius: 4, boxSizing: 'border-box' }}
              />
            )}
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button onClick={onDuplicate} style={{ flex: 1, background: '#393939', color: '#f4f4f4', border: '1px solid #525252', padding: 6, borderRadius: 4, cursor: 'pointer' }}>Duplicar</button>
        <button onClick={onDelete} style={{ flex: 1, background: '#4d1a1a', color: '#f4f4f4', border: '1px solid #da1e28', padding: 6, borderRadius: 4, cursor: 'pointer' }}>Remover</button>
      </div>
      {GITHUB_LINKS.lfm3 && (
        <div style={{ marginTop: 6, fontSize: 11 }}>
          <a href={GITHUB_LINKS.lfm3} target="_blank" rel="noreferrer" style={{ color: '#78a9ff' }}>GitHub do modelo LFM3-Audio (ADR-004)</a>
        </div>
      )}
    </div>
  );
}

function parseScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}
