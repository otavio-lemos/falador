// Inspector — edita params/enabled do nó selecionado + registro de modelos (ADR-004).
import { useState } from 'react';
import { MODEL_REGISTRY } from '../model-registry';
import type { FaladorNode } from './FlowNode';

// Params longos (prompt/instruções) ganham textarea em vez de input de 1 linha.
const TEXTAREA_PARAMS = new Set(['system', 'prompt', 'instructions', 'text']);

// Params estruturados ganham editor JSON (template do llm.omlx é array de strings).
const JSON_PARAMS = new Set(['template', 'options', 'chat_template_kwargs']);


// Param que 'alimenta' a escolha de modelo: qual input λ o modelo controla.
function m_paramFor(models: RegistryEntry[], cur: unknown): string | undefined {
  const m = models.find((mm) => mm.value === cur) ?? models.find((mm) => mm.recommended) ?? models[0];
  return m && m.param !== '(sidecar)' ? m.param : undefined;
}

// Idiomas p/ params chamados 'language' (TTS: EN/PT VERIFICADOS medidos no LFM3-Audio).
const LANGUAGES: [string, string, boolean][] = [
  ['English', 'inglês', true],
  ['Portuguese', 'português', true],
  ['Spanish', 'espanhol', false],
  ['French', 'francês', false],
  ['German', 'alemão', false],
  ['Italian', 'italiano', false],
  ['Japanese', 'japonês', false],
  ['Mandarin', 'mandarim', false],
];

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

function selectedModelUrl(models: RegistryEntry[], cur: unknown): string | undefined {
  if (!models.length) return undefined;
  const byValue = cur != null ? models.find((m) => m.value === cur) : undefined;
  const byId = typeof cur === 'string' ? models.find((m) => m.id === cur) : undefined;
  return (byValue ?? byId ?? models.find((m) => m.recommended) ?? models[0])?.url;
}

/** Kinds de modelo válidos para o tipo de nó (evita LLM no dropdown do ASR etc.). */
function modelKinds(nodeType: string): RegistryEntry0['kind'][] {
  if (nodeType.startsWith('asr')) return ['asr'];
  if (nodeType.startsWith('decision')) return ['decision', 'llm'];
  if (nodeType.startsWith('llm')) return ['llm'];
  if (nodeType.startsWith('tts')) return ['tts'];
  return ['llm'];
}

type RegistryEntry = (typeof MODEL_REGISTRY)[number];
type RegistryEntry0 = RegistryEntry;

/** Catálogo de modelos p/ o nó: registry estático + ids ao vivo do omlx (⟳). */
function modelsForNode(nodeType: string, modelName: string, availableModels?: string[]): RegistryEntry[] {
  if (modelName !== 'model') return [];
  const kinds = modelKinds(nodeType);
  const merged: RegistryEntry[] = MODEL_REGISTRY.filter((m) => kinds.includes(m.kind));
  if (availableModels?.length) {
    for (const id of availableModels) {
      if (merged.some((m) => m.value === id || m.id === id)) continue;
      merged.push({
        id, value: id, url: '',
        kind: kinds[0] ?? 'llm', param: 'model',
        recommended: false, verified: false, local: 'omlx',
        notes: 'id vindo do omlx (/v1/models) — disponível AGORA no servidor',
      });
    }
  }
  return merged.sort((a, b) => (a.verified === b.verified ? 0 : a.verified ? -1 : 1));
}

export function Inspector({ node, onUpdate, onDuplicate, onDelete, availableModels, fetchViaParam, modelsVia }: {
  node: FaladorNode;
  onUpdate: (d: Partial<FaladorNode['data']>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  availableModels?: string[]; // ids vindos do omlx /v1/models (botão ⟳ na toolbar)
  fetchViaParam?: (param: string) => void;
  modelsVia?: string;       // param sendo "via" — dispara o fetch λ no host
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
        const models = modelsForNode(type, name, availableModels);
        const placeholder = cur === undefined || cur === null
          ? (defaults[name] ?? '(omitido — usa default do nó)')
          : undefined;

        // Seletor de IDIOMA (params 'language' — o idioma da SAÍDA deste nó).
        if (name === 'language') {
          const curLang = cur === undefined ? 'English' : String(cur);
          return (
            <div key={name} style={{ marginBottom: 8 }}>
              <ParamLabel name={name} hint="idioma da saída deste nó (por nó, não global)" />
              <select
                value={curLang}
                onChange={(e) => onUpdate({ params: { ...p, [name]: e.target.value } })}
                style={inputStyle}
              >
                {LANGUAGES.map(([val, label, verif]) => (
                  <option key={val} value={val}>
                    {label} ({val}){verif ? ' ★ VERIFICADO' : ''}
                  </option>
                ))}
              </select>
            </div>
          );
        }

        // Registro de modelos: dropdown (registry + omlx ao vivo) + "?" → HF do modelo ESCOLHIDO.
        if (models.length) {
          const selectedId = models.find((m) => m.value === cur)?.id ?? (typeof cur === 'string' ? cur : '');
          const url = selectedModelUrl(models, cur);
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
                      {m.param !== 'model' && m.param !== '(sidecar)' ? ` · λ:${m.param}` : ''}
                      {m.verified ? '' : ' · NÃO VERIFICADO'}
                    </option>
                  ))}
                </select>
                {url && (
                  <a href={url} target="_blank" rel="noreferrer" title="GitHub/HF do modelo selecionado (ADR-004)" style={{ color: '#78a9ff' }}>?</a>
                )}
                {fetchViaParam && m_paramFor(models, cur) && (
                  <a
                    href="#"
                    onClick={(e) => { e.preventDefault(); fetchViaParam(m_paramFor(models, cur)!); }}
                    title="roda o nó fetch λ com este modelo e mostra a saída crua (sem trust-me)"
                    style={{ color: '#78a9ff', fontSize: 11 }}
                  >
                    ⟲ via-fetch
                  </a>
                )}
              </div>
              {fetchViaParam && modelsVia === m_paramFor(models, cur) && (
                <div style={{ marginTop: 4, fontSize: 10, color: '#a8a8a8' }}>
                  λ disparado no host; resultado chega pelo datasource `{modelsVia}` no run atual.
                </div>
              )}
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
