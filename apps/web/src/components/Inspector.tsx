// Inspector — edita params/enabled do nó selecionado + registro de modelos (ADR-004).
// Camada visual Carbon v11; lógica de params/modelos preservada 1:1.
import { useState } from 'react';
import { Button, ComboBox, Dropdown, Link, TextArea, TextInput, Toggle } from '@carbon/react';
import { Copy, Help, TrashCan } from '@carbon/icons-react';
import { MODEL_REGISTRY } from '../model-registry';
import type { FaladorNode } from './FlowNode';
import type { NodeMetrics } from '../api';

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

type LanguageItem = { val: string; label: string; verif: boolean };
const LANGUAGE_ITEMS: LanguageItem[] = LANGUAGES.map(([val, label, verif]) => ({ val, label, verif }));

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

/** Rótulo do ComboBox de modelos — mesmos marcadores do select original. */
function modelToString(m: RegistryEntry | null): string {
  if (!m) return '';
  return `${m.id}${m.recommended ? ' ★ RECOMENDADO' : ''}${m.param !== 'model' && m.param !== '(sidecar)' ? ` · λ:${m.param}` : ''}${m.verified ? '' : ' · NÃO VERIFICADO'}`;
}

export function Inspector({ node, onUpdate, onDuplicate, onDelete, availableModels, fetchViaParam, modelsVia, metrics }: {
  node: FaladorNode;
  onUpdate: (d: Partial<FaladorNode['data']>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  availableModels?: string[]; // ids vindos do omlx /v1/models (botão ⟳ na toolbar)
  fetchViaParam?: (param: string) => void;
  modelsVia?: string;       // param sendo "via" — dispara o fetch λ no host
  metrics?: NodeMetrics;    // métricas ao vivo do último run (snapshot do motor)
}) {
  const { type, params, enabled } = node.data;
  const paramNames = node.data.paramNames ?? [];
  const p = params as Record<string, unknown>;
  const defaults = DEFAULTS_BY_TYPE[type] ?? {};
  // Rascunho/erro do editor JSON: enquanto o texto não parseia, mantemos o que o usuário digita.
  const [jsonDrafts, setJsonDrafts] = useState<Record<string, string>>({});
  const [jsonErrors, setJsonErrors] = useState<Record<string, string | undefined>>({});

  return (
    <div>
      <div className="section-title">Nó selecionado: {type}</div>
      <div className="param-block">
        <Toggle
          id={`enabled-${node.id}`}
          size="sm"
          labelText="enabled"
          labelA="OFF"
          labelB="ON"
          toggled={enabled}
          onToggle={(v) => onUpdate({ enabled: v })}
        />
      </div>

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
            <div key={name} className="param-block">
              <ParamLabel name={name} hint="idioma da saída deste nó (por nó, não global)" />
              <Dropdown
                id={`lang-${node.id}`}
                size="sm"
                titleText="idioma da saída deste nó"
                hideLabel
                label="idioma"
                items={LANGUAGE_ITEMS}
                itemToString={(it) => (it ? `${it.label} (${it.val})${it.verif ? ' ★ VERIFICADO' : ''}` : '')}
                selectedItem={LANGUAGE_ITEMS.find((it) => it.val === curLang) ?? LANGUAGE_ITEMS[0]}
                onChange={({ selectedItem }) => {
                  if (selectedItem) onUpdate({ params: { ...p, [name]: selectedItem.val } });
                }}
              />
            </div>
          );
        }

        // Registro de modelos: ComboBox (registry + omlx ao vivo) + "?" → HF do modelo ESCOLHIDO.
        if (models.length) {
          const selectedId = models.find((m) => m.value === cur)?.id ?? (typeof cur === 'string' ? cur : '');
          const url = selectedModelUrl(models, cur);
          return (
            <div key={name} className="param-block">
              <div className="model-row">
                <ComboBox
                  id={`model-${node.id}-${name}`}
                  className="model-combo"
                  size="sm"
                  titleText={name}
                  placeholder="— selecione —"
                  items={models}
                  itemToString={modelToString}
                  selectedItem={models.find((m) => m.id === selectedId) ?? null}
                  onChange={({ selectedItem }) => {
                    // o value certo p/ o param (omlx id / snapshot path); fallback: url
                    onUpdate({ params: { ...p, [name]: selectedItem ? (selectedItem.value ?? selectedItem.url) : '' } });
                  }}
                />
                {url && (
                  <Link
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="model-help"
                    renderIcon={Help}
                    aria-label="GitHub/HF do modelo selecionado (ADR-004)"
                    title="GitHub/HF do modelo selecionado (ADR-004)"
                  />
                )}
                {fetchViaParam && m_paramFor(models, cur) && (
                  <Link
                    href="#"
                    className="via-fetch-link"
                    onClick={(e) => { e.preventDefault(); fetchViaParam(m_paramFor(models, cur)!); }}
                    title="roda o nó fetch λ com este modelo e mostra a saída crua (sem trust-me)"
                  >
                    via-fetch
                  </Link>
                )}
              </div>
              {fetchViaParam && modelsVia === m_paramFor(models, cur) && (
                <div className="via-fetch-note">
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
            <div key={name} className="param-block">
              <ParamLabel name={name} hint="JSON" />
              <TextArea
                id={`json-${node.id}-${name}`}
                labelText={`${name} (JSON)`}
                hideLabel
                rows={3}
                value={raw}
                placeholder={placeholderText}
                invalid={!!err}
                invalidText={err}
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
              />
            </div>
          );
        }

        // Textarea para prompts/templates longos; input para escalares.
        const isLong = TEXTAREA_PARAMS.has(name) || (typeof cur === 'string' && (cur.includes('\n') || cur.length > 60));
        return (
          <div key={name} className="param-block">
            <ParamLabel name={name} />
            {isLong ? (
              <TextArea
                id={`param-${node.id}-${name}`}
                labelText={name}
                hideLabel
                rows={4}
                value={cur === undefined || cur === null ? '' : String(cur)}
                placeholder={placeholder}
                onChange={(e) => onUpdate({ params: { ...p, [name]: e.target.value === '' ? undefined : e.target.value } })}
              />
            ) : (
              <TextInput
                id={`param-${node.id}-${name}`}
                labelText={name}
                hideLabel
                size="sm"
                value={cur === undefined || cur === null ? '' : String(cur)}
                placeholder={placeholder}
                onChange={(e) => {
                  const raw = e.target.value;
                  onUpdate({ params: { ...p, [name]: raw === '' ? undefined : parseScalar(raw) } });
                }}
              />
            )}
            {cur === undefined && defaults[name] && (
              <div className="param-default-hint">
                default: <code>{defaults[name].split('\n')[0]}…</code>
              </div>
            )}
          </div>
        );
      })}

      {metrics && (
        <div className="metrics-block">
          <div className="section-title">Métricas do run</div>
          <div className="metrics-line">
            ↓{metrics.in} ↑{metrics.out} · erros {metrics.errors}
            {metrics.procMsP50 != null && <> · proc p50 {Math.round(metrics.procMsP50)}ms / p95 {Math.round(metrics.procMsP95 ?? 0)}ms</>}
            {metrics.dropped > 0 && <> · drops {metrics.dropped}</>}
            {metrics.expired > 0 && <> · expiradas {metrics.expired}</>}
          </div>
          {Object.entries(metrics.timers).map(([k, t]) => (
            <div key={k} className="metrics-timer">
              {k}: último {Math.round(t.lastMs)}ms · méd {Math.round(t.avgMs)}ms · n={t.count}
            </div>
          ))}
          {Object.entries(metrics.counters).map(([k, v]) => (
            <div key={k} className="metrics-counter">
              {k}: {v}
            </div>
          ))}
        </div>
      )}

      <div className="inspector-actions">
        <Button kind="secondary" size="sm" className="flex-1" renderIcon={Copy} onClick={onDuplicate}>Duplicar</Button>
        <Button kind="danger--tertiary" size="sm" className="flex-1" renderIcon={TrashCan} onClick={onDelete}>Remover</Button>
      </div>
    </div>
  );
}

function ParamLabel({ name, hint }: { name: string; hint?: string }) {
  return (
    <div className="param-label">
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
