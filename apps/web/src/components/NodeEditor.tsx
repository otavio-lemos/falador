// Editor INLINE de nó — abre ancorado no próprio nó clicado (não num painel direito
// apertado). Abas Configuração / Regras / Logs como no layout do dono. Campos reais
// de cada nó (PARAM_HELP), com o controle certo: dropdown/slider/toggle/textarea/json.
import { useState } from 'react';
import {
  Dropdown, Slider, Toggle, TextArea, TextInput,
  Tabs, TabList, Tab, TabPanels, TabPanel, IconButton,
} from '@carbon/react';
import { Close } from '@carbon/icons-react';
import { PARAM_HELP, type ParamDoc } from '../data';
import type { FaladorNodeData } from '../flow-utils';
import type { NodeMetrics, RunnerEvent } from '../api';

interface Props {
  nodeId: string;
  data: FaladorNodeData;
  onChange: (params: Record<string, unknown>) => void;
  onClose: () => void;
  metrics?: NodeMetrics;
  events: RunnerEvent[];
}

export function NodeEditor({ nodeId, data, onChange, onClose, metrics, events }: Props) {
  const docs = PARAM_HELP[data.type] ?? {};
  const p = data.params;
  const set = (name: string, value: unknown) => onChange({ ...p, [name]: value });
  const nodeEvents = events.filter((e) => (e as { nodeId?: string }).nodeId === nodeId).slice(-12);

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
                <p className="node-editor-empty">
                  {data.type === 'human.approve'
                    ? 'Gate humano: durante o run, segura a sugestão até você Aprovar / Editar / Rejeitar. Sem parâmetros ajustáveis.'
                    : 'Este nó não tem parâmetros ajustáveis.'}
                </p>
              )}
              {data.paramNames.map((name) => (
                <ParamField key={name} name={name} doc={docs[name]} value={p[name]} onChange={(v) => set(name, v)} />
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

function ParamField({ name, doc, value, onChange }: { name: string; doc?: ParamDoc; value: unknown; onChange: (v: unknown) => void }) {
  const helper = doc ? `${doc.help}${doc.def ? ` · default: ${doc.def}` : ''}` : undefined;
  const control = doc?.control ?? inferControl(name, value);
  const [jsonErr, setJsonErr] = useState<string | undefined>();

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
  // text / model / scalar
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

function inferControl(name: string, value: unknown): ParamDoc['control'] {
  if (typeof value === 'boolean') return 'toggle';
  if (['system', 'instructions', 'instruction', 'prompt'].includes(name)) return 'textarea';
  if (['template', 'options', 'criteria'].includes(name)) return 'json';
  return 'text';
}
function parseScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}