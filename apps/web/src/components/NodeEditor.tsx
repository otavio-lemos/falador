// Editor INLINE de nó — abre ancorado no próprio nó clicado.
// Abas Configuração / Regras / Logs. Campos reais de cada nó (PARAM_HELP):
// dropdown / slider / toggle / textarea / json / model (ComboBox filtrado por capacidade).
import { useState } from 'react';
import {
  ComboBox, Dropdown, Slider, Toggle, TextArea, TextInput,
  Tabs, TabList, Tab, TabPanels, TabPanel, IconButton, Button,
} from '@carbon/react';
import { Close, Renew } from '@carbon/icons-react';
import { isAsrLfm3Model, PARAM_HELP, type ParamDoc } from '../data';
import { isTextModel, isAsrModel, isTtsModel, isStsModel, isDecisionModel } from '../live-utils';
import type { FaladorNodeData } from '../flow-utils';
import type { NodeMetrics, RunnerEvent } from '../api';

interface Props {
  nodeId: string;
  data: FaladorNodeData;
  onChange: (params: Record<string, unknown>) => void;
  onClose: () => void;
  metrics?: NodeMetrics;
  events: RunnerEvent[];
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  onRefreshApps: () => void;
}

/** Lista de modelos filtrada pela capacidade do nó (usando model_type de /v1/models do omlx). */
function modelsForNode(nodeType: string, models: { omlx: string[]; cache: string[]; details?: { id: string; model_type: string }[] }): string[] {
  const typeById = new Map<string, string>((models.details ?? []).map((d) => [d.id, d.model_type]));
  const mType = (id: string) => typeById.get(id);
  const all = [...models.omlx, ...models.cache.filter((m) => !models.omlx.includes(m))];
  if (nodeType === 'asr.realtime') return all.filter((m) => isAsrModel(m, mType(m)) && !/lfm.*audio/i.test(m));
  if (nodeType === 'asr.realtime.translate') return all.filter((m) => isAsrLfm3Model(m));
  if (nodeType === 'tts.sts') return all.filter((m) => isTtsModel(m, mType(m)) || isStsModel(m, mType(m)));
  if (nodeType === 'decision.llm') return [...models.omlx.filter((m) => isDecisionModel(m, mType(m))), ...models.omlx.filter((m) => isTextModel(m, mType(m)))];
  if (nodeType === 'turn.detector') return models.omlx.filter((m) => isDecisionModel(m, mType(m)));
  if (nodeType === 'llm.omlx' || nodeType === 'translate.llm' || nodeType === 'agent.tools' || nodeType === 'goal.validator') {
    return models.omlx.filter((m) => isTextModel(m, mType(m)));
  }
  return all;
}

export function NodeEditor({ nodeId, data, onChange, onClose, metrics, events, models, apps, onRefreshApps }: Props) {
  const docs = PARAM_HELP[data.type] ?? {};
  const p = data.params;
  const set = (name: string, value: unknown) => onChange({ ...p, [name]: value });
  const nodeEvents = events.filter((e) => (e as { nodeId?: string }).nodeId === nodeId).slice(-12);
  const nodeModels = modelsForNode(data.type, models);

  return (
    <div className="node-editor" role="dialog" aria-label={`Propriedades de ${data.type}`}>
      <div className="node-editor-head">
        <span className="node-editor-title">Propriedades: <strong>{data.type}</strong></span>
        <IconButton kind="ghost" size="sm" label="Fechar editor" onClick={onClose}>
          <Close size={16} />
        </IconButton>
      </div>
      <Tabs>
        <TabList aria-label="Seções do nó" size="sm">
          <Tab>Configuração</Tab>
          <Tab>Regras</Tab>
          <Tab>Logs</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <div className="node-editor-fields">
              {data.paramNames.length === 0 && (
                <p className="node-editor-empty">Este nó não tem parâmetros ajustáveis.</p>
              )}
              {data.paramNames.map((name) => (
                <ParamField
                  key={name}
                  name={name}
                  doc={docs[name]}
                  value={p[name]}
                  onChange={(v) => set(name, v)}
                  nodeModels={docs[name]?.control === 'model' ? nodeModels : []}
                  apps={name === 'input' && data.type.startsWith('capture.') ? apps : []}
                  onRefreshApps={onRefreshApps}
                />
              ))}
            </div>
          </TabPanel>
          <TabPanel>
            <div className="node-editor-fields">
              <p className="node-editor-empty">
                Portas: entra {data.inputs.map((i) => `${i.name}(${i.type})`).join(', ') || '—'} · sai{' '}
                {data.outputs.map((o) => `${o.name}(${o.type})`).join(', ') || '—'}.
                As regras de fluxo (capacidade/overflow) ficam nas conexões.
              </p>
            </div>
          </TabPanel>
          <TabPanel>
            <div className="node-editor-fields">
              {metrics && (
                <div className="node-editor-metrics">
                  ↓{metrics.in} ↑{metrics.out} · erros {metrics.errors}
                  {metrics.procMsP50 != null && <> · p50 {Math.round(metrics.procMsP50)}ms</>}
                  {Object.entries(metrics.timers).map(([k, t]) => (
                    <div key={k}>{k}: méd {Math.round(t.avgMs)}ms · n={t.count}</div>
                  ))}
                </div>
              )}
              {nodeEvents.length === 0 && <p className="node-editor-empty">Sem eventos deste nó ainda (rode o fluxo).</p>}
              {nodeEvents.map((e, i) => (
                <div key={i} className="node-editor-log">{String((e as { message?: string }).message ?? e.type)}</div>
              ))}
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}

function ParamField({
  name, doc, value, onChange, nodeModels, apps, onRefreshApps,
}: {
  name: string;
  doc?: ParamDoc;
  value: unknown;
  onChange: (v: unknown) => void;
  nodeModels: string[];
  apps: string[];
  onRefreshApps: () => void;
}) {
  const helper = doc ? `${doc.help}${doc.def ? ` · default: ${doc.def}` : ''}` : undefined;
  const control = doc?.control ?? inferControl(name, value);
  const [jsonErr, setJsonErr] = useState<string | undefined>();

  // Campo de modelo: ComboBox com lista filtrada por capacidade do nó
  if (control === 'model') {
    const cur = value === undefined || value === null ? '' : String(value);
    const items = nodeModels.map((m) => ({ id: m, label: shortLabel(m) }));
    // garante que o valor atual aparece mesmo se não estiver na lista
    if (cur && !items.some((i) => i.id === cur)) {
      items.unshift({ id: cur, label: shortLabel(cur) });
    }
    return (
      <div className="pe-field">
        <ComboBox
          id={`pe-${name}`} titleText={name} size="sm"
          helperText={helper}
          placeholder={doc?.def ?? 'Escolha ou digite o modelo…'}
          items={items}
          itemToString={(it) => (it ? it.label : '')}
          selectedItem={items.find((i) => i.id === cur) ?? null}
          onChange={({ selectedItem }) => {
            if (selectedItem) onChange(selectedItem.id);
          }}
          onInputChange={(txt) => {
            // aceita digitação livre (paths longos do HF cache), mas ignora quando o ComboBox
            // apenas refletiu o label curto de um item selecionado
            if (txt && !items.some((i) => i.id === txt || i.label === txt)) onChange(txt);
          }}
        />
        {nodeModels.length === 0 && (
          <p className="pe-warn">Nenhum modelo encontrado para este tipo de nó. Verifique se o omlx está rodando.</p>
        )}
      </div>
    );
  }

  // Campo de app (capture.*): ComboBox com apps ao vivo + botão reload
  if (apps.length > 0 || (name === 'input' && control !== 'dropdown')) {
    if (apps.length > 0 || control === 'text') {
      const cur = value === undefined || value === null ? '' : String(value);
      const items = apps.map((a) => ({ id: a, label: a }));
      if (cur && !items.some((i) => i.id === cur)) items.unshift({ id: cur, label: cur });
      return (
        <div className="pe-field pe-field--app">
          <ComboBox
            id={`pe-${name}`} titleText={name} size="sm"
            helperText={helper}
            placeholder="App da call (ex.: Google Chrome, zoom.us…)"
            items={items}
            itemToString={(it) => (it ? it.label : '')}
            selectedItem={items.find((i) => i.id === cur) ?? null}
            onChange={({ selectedItem }) => { if (selectedItem) onChange(selectedItem.id); }}
            onInputChange={(txt) => { if (txt) onChange(txt); }}
          />
          <Button
            kind="ghost" size="sm" hasIconOnly renderIcon={Renew}
            iconDescription="Recarregar apps com áudio ativo"
            tooltipPosition="bottom"
            onClick={onRefreshApps}
          />
          {apps.length === 0 && (
            <p className="pe-warn">Nenhum app emitindo áudio agora. Abra a call e clique ↺.</p>
          )}
        </div>
      );
    }
  }

  if (control === 'dropdown' && doc?.options) {
    const cur = value === undefined ? doc.options[0].val : String(value);
    return (
      <div className="pe-field">
        <Dropdown
          id={`pe-${name}`} size="sm" titleText={name} hideLabel label={name}
          helperText={helper} items={doc.options}
          itemToString={(it) => (it ? it.label : '')}
          selectedItem={doc.options.find((o) => o.val === cur) ?? doc.options[0]}
          onChange={({ selectedItem }) => selectedItem && onChange(selectedItem.val)}
        />
      </div>
    );
  }
  if (control === 'slider' && doc) {
    const num = value === undefined ? Number(doc.def ?? doc.min ?? 0) : Number(value);
    return (
      <div className="pe-field">
        <Slider
          labelText={`${name}${doc.unit ? ` (${doc.unit})` : ''}`}
          min={doc.min ?? 0} max={doc.max ?? 100} step={doc.step ?? 1}
          value={Number.isFinite(num) ? num : (doc.min ?? 0)}
          hideTextInput
          onChange={({ value: v }) => onChange(v)}
        />
        {helper && <div className="pe-help">{helper}</div>}
      </div>
    );
  }
  if (control === 'toggle') {
    const on = value === undefined ? doc?.def === 'true' : value === true || value === 'true';
    return (
      <div className="pe-field pe-field--toggle">
        <Toggle
          id={`pe-${name}`} size="sm" labelText={name} labelA="OFF" labelB="ON"
          toggled={on} onToggle={(v) => onChange(v)}
        />
        {helper && <div className="pe-help">{helper}</div>}
      </div>
    );
  }
  if (control === 'textarea') {
    return (
      <div className="pe-field">
        <TextArea
          id={`pe-${name}`} labelText={name} hideLabel rows={3}
          placeholder={doc?.def} helperText={helper}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      </div>
    );
  }
  if (control === 'json') {
    const raw = value === undefined || value === null ? '' : JSON.stringify(value, null, 2);
    return (
      <div className="pe-field">
        <TextArea
          id={`pe-${name}`} labelText={`${name} (JSON)`} hideLabel rows={3}
          placeholder={doc?.def} helperText={helper}
          invalid={!!jsonErr} invalidText={jsonErr}
          defaultValue={raw}
          onChange={(e) => {
            const t = e.target.value;
            if (t.trim() === '') { setJsonErr(undefined); onChange(undefined); return; }
            try { onChange(JSON.parse(t)); setJsonErr(undefined); }
            catch { setJsonErr('JSON inválido (não aplicado até corrigir)'); }
          }}
        />
      </div>
    );
  }
  // text / scalar
  return (
    <div className="pe-field">
      <TextInput
        id={`pe-${name}`} labelText={name} hideLabel size="sm"
        placeholder={doc?.def} helperText={helper}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? undefined : parseScalar(raw));
        }}
      />
    </div>
  );
}

function shortLabel(id: string): string {
  if (!id) return '—';
  const m = id.match(/models--([^/]+)/);
  if (m) return m[1].replace(/--/g, '/');
  return id.split('/').pop()?.replace(/--/g, '/') ?? id;
}

function inferControl(name: string, value: unknown): ParamDoc['control'] {
  if (typeof value === 'boolean') return 'toggle';
  if (['system', 'instructions', 'instruction', 'prompt'].includes(name)) return 'textarea';
  if (['template', 'options', 'criteria', 'allowedPrefixes', 'allowedHosts', 'contextTags'].includes(name)) return 'json';
  return 'text';
}
function parseScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}
