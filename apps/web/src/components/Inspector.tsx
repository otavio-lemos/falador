// Inspector — edita params/enabled do nó selecionado + registro de modelos (ADR-004).
import { useState } from 'react';
import { MODEL_REGISTRY } from '../model-registry';
import type { FaladorNode } from './FlowNode';

const MODEL_BY_PARAM: Record<string, typeof MODEL_REGISTRY> = {};
for (const m of MODEL_REGISTRY) {
  (MODEL_BY_PARAM[m.param] ??= []).push(m);
}

// Params longos (prompt/instruções) ganham textarea em vez de input de 1 linha.
const TEXTAREA_PARAMS = new Set(['system', 'prompt', 'instructions', 'text']);

// Params estruturados ganham editor JSON (template do llm.omlx é array de strings).
const JSON_PARAMS = new Set(['template', 'options', 'chat_template_kwargs']);

/** Defaults por tipo de nó, para placeholders honestos (catálogo não guarda defaults). */
const DEFAULTS_BY_TYPE: Record<string, Record<string, string>> = {
  'llm.omlx': {
    // template é FRAGMENTO (string[]):[...template, userText].join('\n\n') — '{text}' marca a fala.
    template: '["Fragmento de instrução antes da fala do usuário…"]',
  },
  'decision.llm': {
    options: '["auto","humano"]',
    instructions: 'Decida a qual categoria o texto abaixo pertence. Responda EXATAMENTE com UMA das opções, nada mais.',
  },
};

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#262626', color: '#f4f4f4',
  border: '1px solid #525252', padding: '4px 6px', borderRadius: 4,
  boxSizing: 'border-box', fontFamily: 'inherit',
};
const textareaStyle: React.CSSProperties = {
  ...inputStyle, minHeight: 84, resize: 'vertical',
  font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
};

function selectedModelUrl(param: string, cur: unknown): string | undefined {
  const models = MODEL_BY_PARAM[param];
  if (!models) return undefined;
  const byUrl = cur != null ? models.find((m) => m.url === cur) : undefined;
  const byId = typeof cur === 'string' ? models.find((m) => m.id === cur) : undefined;
  return (byUrl ?? byId ?? models.find((m) => m.recommended) ?? models[0])?.url;
}

export function Inspector({ node, onUpdate, onDuplicate, onDelete }: {
  node: FaladorNode;
  onUpdate: (d: Partial<FaladorNode['data']>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { type, params, enabled } = node.data;
  const paramNames = node.data.paramNames ?? [];
  const p = params as Record<string, unknown>;
  const defaults = DEFAULTS_BY_TYPE[type] ?? {};
  // Rascunho/erro do editor JSON: enquanto o texto não parseia, mantemos o que o usuário digita.
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [jsonErrors, setJsonErrors] = useState<Record<string, string | undefined>>({});

  return (
    <div style={{ marginBottom: 12 }}>
      <div className="section-title">Nó selecionado: {type}</div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onUpdate({ enabled: e.target.checked })} /> enabled
      </label>

      {paramNames.map((name) => {
        const cur = p[name];
        const models = MODEL_BY_PARAM[name];
        const placeholder = cur === undefined || cur === null
          ? (defaults[name] ?? '(omitido — usa default do nó)')
          : undefined;

        // Registro de modelos: dropdown + "?" para o GitHub/HF do modelo ESCOLHIDO.
        if (models) {
          const selectedId = models.find((m) => m.url === cur)?.id ?? (typeof cur === 'string' ? cur : '');
          const url = selectedModelUrl(name, cur);
          return (
            <div key={name} style={{ marginBottom: 8 }}>
              <ParamLabel name={name} />
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select
                  value={selectedId}
                  onChange={(e) => {
                    const m = models.find((mm) => mm.id === e.target.value);
                    // o value certa p/ o param (omlx id / snapshot path); fallback: url
                    onUpdate({ params: { ...p, [name]: m ? (m.value ?? m.url) : e.target.value } });
                  }}
                  style={inputStyle}
                >
                  <option value="">— selecione —</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id}{m.recommended ? ' ★ RECOMENDADO' : ''}
                    </option>
                  ))}
                </select>
                {url && (
                  <a href={url} target="_blank" rel="noreferrer" title="GitHub/HF do modelo selecionado (ADR-004)" style={{ color: '#78a9ff' }}>?</a>
                )}
              </div>
            </div>
          );
        }

        // Editor JSON para params estruturados (arrays/objetos).
        if (JSON_PARAMS.has(name)) {
          const raw = jsonDrafts[name] ?? (cur === undefined || cur === null ? '' : JSON.stringify(cur));
          const err = jsonErrors[name];
          const placeholderText = name === 'template' ? '["Instrução antes da fala do usuário…"]' : '["auto","humano"]';
          return (
            <div key={name} style={{ marginBottom: 8 }}>
              <ParamLabel name={name} hint="JSON" />
              <textarea
                value={raw}
                placeholder={placeholderText}
                onChange={(e) => {
                  const text = e.target.value;
                  if (text.trim() === '') {
                    setJsonDrafts((d) => ({ ...d, [name]: '' }));
                    setJsonErrors((er) => ({ ...er, [name]: undefined }));
                    onUpdate({ params: { ...p, [name]: undefined } });
                    return;
                  }
                  setJsonDrafts((d) => ({ ...d, [name]: text }));
                  try {
                    const parsed = JSON.parse(text);
                    if (name === 'template' && (!Array.isArray(parsed) || parsed.some((t) => typeof t !== 'string'))) {
                      setJsonErrors((er) => ({ ...er, [name]: 'template deve ser array de strings' }));
                      return;
                    }
                    setJsonErrors((er) => ({ ...er, [name]: undefined }));
                    onUpdate({ params: { ...p, [name]: parsed } });
                  } catch {
                    setJsonErrors((er) => ({ ...er, [name]: 'JSON inválido (não aplicado até corrigir)' }));
                  }
                }}
                style={{ ...textareaStyle, minHeight: 60, ...(err ? { border: '1px solid #da1e28' } : {}) }}
              />
              {err && <div style={{ fontSize: 10, color: '#ff8389' }}>{err}</div>}
            </div>
          );
        }

        // Textarea para prompts/templates longos; input para escalares.
        const isLong = TEXTAREA_PARAMS.has(name) || (typeof cur === 'string' && (cur.includes('\n') || cur.length > 60));
        return (
          <div key={name} style={{ marginBottom: 8 }}>
            <ParamLabel name={name} />
            {isLong ? (
              <textarea
                value={cur === undefined || cur === null ? '' : String(cur)}
                placeholder={placeholder}
                onChange={(e) => onUpdate({ params: { ...p, [name]: e.target.value === '' ? undefined : e.target.value } })}
                style={textareaStyle}
              />
            ) : (
              <input
                value={cur === undefined || cur === null ? '' : String(cur)}
                placeholder={placeholder}
                onChange={(e) => {
                  const raw = e.target.value;
                  onUpdate({ params: { ...p, [name]: raw === '' ? undefined : parseScalar(raw) } });
                }}
                style={inputStyle}
              />
            )}
            {cur === undefined && defaults[name] && (
              <div style={{ fontSize: 10, color: '#8d8d8d', marginTop: 2 }}>
                default: <code style={{ color: '#a8a8a8' }}>{defaults[name].split('\n')[0]}…</code>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        <button onClick={onDuplicate} style={{ flex: 1, background: '#393939', color: '#f4f4f4', border: '1px solid #525252', padding: 6, borderRadius: 4, cursor: 'pointer' }}>Duplicar</button>
        <button onClick={onDelete} style={{ flex: 1, background: '#4d1a1a', color: '#f4f4f4', border: '1px solid #da1e28', padding: 6, borderRadius: 4, cursor: 'pointer' }}>Remover</button>
      </div>
    </div>
  );
}

function ParamLabel({ name, hint }: { name: string; hint?: string }) {
  return (
    <div style={{ fontSize: 11, color: '#8d8d8d', marginBottom: 2 }}>
      {name}{hint ? ` · ${hint}` : ''}
    </div>
  );
}

function parseScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}
