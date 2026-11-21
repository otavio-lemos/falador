// Tela de EXECUÇÃO — layout do dono: LIVE MODE + latência + Pausar/Encerrar;
// transcrição do entrevistador; DROPDOWN POR ETAPA do workflow (troca a config real
// de cada nó); sugestão hero (o que o dono lê pra falar) + Regerar/Editar/Aprovar;
// sidebar Contexto & Cheatsheet com RAG leve REAL (docs + pontos + tópicos ao vivo).
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dropdown, Tag, TextArea } from '@carbon/react';
import { Pause, Play, Stop, Renew, Edit, Checkmark, Document, Warning, Information, Microphone, Add, TrashCan } from '@carbon/icons-react';
import type { Runner } from '../useRunner';
import { fetchTopics, type Flow, type ContextDoc } from '../api';
import { deriveStages, classifySinks, shortModel, isTextModel, isAsrModel, type Stage } from '../live-utils';
import { LANGS } from '../data';

interface Props {
  runner: Runner;
  flow: Flow;
  scenarioName: string;
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  contextDocs: ContextDoc[];
  onUploadDoc: (file: File) => void;
  onRemoveDoc: (name: string) => void;
  onStart: (flow: Flow) => void;
  flows: { name: string; description: string }[];
  currentFlow: string;
  onSwitchFlow: (name: string) => void;
  onUpdateStage: (nodeId: string, param: string, value: unknown) => void;
  onRegenerate: () => void;
  onRefreshApps: () => void;
  onExit: () => void;
}

interface Item { id: string; label: string }

function stageItems(stage: Stage, models: { omlx: string[]; cache: string[] }, apps: string[]): Item[] {
  if (stage.kind === 'gate') return [{ id: 'humano', label: 'Manual' }, { id: 'auto', label: 'Auto' }];
  if (stage.kind === 'voice') return [{ id: 'female', label: 'Feminino' }, { id: 'male', label: 'Masculino' }];
  if (stage.kind === 'language') return LANGS.map((l) => ({ id: l.val, label: l.label }));
  let vals: string[] = [];
  if (stage.kind === 'app') vals = apps.length ? apps : [stage.value];
  // ASR: modelos compatíveis vindos do omlx e do cache HF, preservando o atual.
  else if (stage.kind === 'model-asr') vals = [...models.omlx, ...models.cache.filter((m) => !models.omlx.includes(m))].filter(isAsrModel);
  // LLM de sugestão: SÓ modelos de texto (d1/áudio/VAD não geram resposta)
  else if (stage.kind === 'model-llm') vals = models.omlx.filter(isTextModel);
  const items = vals.filter(Boolean).map((v) => ({ id: v, label: stage.kind.startsWith('model') ? shortModel(v) : v }));
  // só realça o valor atual se for válido pro tipo (não mantém um d1 num LLM de texto)
  const validCurrent = stage.value && (stage.kind !== 'model-llm' || isTextModel(stage.value));
  if (validCurrent && !items.some((i) => i.id === stage.value)) {
    items.unshift({ id: stage.value, label: stage.kind.startsWith('model') ? shortModel(stage.value) : stage.value });
  }
  return items.length ? items : [{ id: stage.value || '—', label: stage.value || '—' }];
}

export function LiveView({ runner, flow, scenarioName, models, apps, contextDocs, onUploadDoc, onRemoveDoc, onStart, flows, currentFlow, onSwitchFlow, onUpdateStage, onRegenerate, onRefreshApps, onExit }: Props) {
  const stages = useMemo(() => deriveStages(flow), [flow]);
  const sinks = useMemo(() => classifySinks(flow), [flow]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [topics, setTopics] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const lastOf = (set: Set<string>) => [...runner.captions].reverse().find((c) => set.has(c.nodeId));
  const transcription = lastOf(sinks.transcription)?.text ?? '';
  const gate = runner.gates[0];
  const suggestion = gate ? gate.text : (lastOf(sinks.suggestion)?.text ?? '');
  const captureApp = stages.find((s) => s.kind === 'app')?.value ?? '—';
  // NADA FIXO: painéis e botões derivam dos nós que existem no workflow.
  const hasGate = flow.nodes.some((n) => n.type === 'human.approve');
  const hasTTS = flow.nodes.some((n) => n.type === 'tts.sts');
  const hasLLM = flow.nodes.some((n) => n.type === 'llm.omlx');
  const isInterview = flow.nodes.some((n) => n.type === 'decision.llm' || n.type === 'human.approve');
  const allSinks = new Set([...sinks.transcription, ...sinks.suggestion]);
  // entrevista: hero = sugestão do assistente; tradução: hero = a própria tradução
  const heroText = isInterview ? (gate ? gate.text : (lastOf(sinks.suggestion)?.text ?? '')) : (lastOf(allSinks)?.text ?? '');
  const heroLabel = isInterview ? 'Sugestão de resposta (para você falar)' : 'Tradução ao vivo';
  // erro real do run (não log_info) — pra falha não ser silenciosa
  const lastError = [...runner.events].reverse().find((e) => e.type === 'node_error' && !String((e as { code?: string }).code ?? '').startsWith('log_')) as { message?: string; nodeId?: string } | undefined;

  const approve = () => { if (gate) runner.gate(gate.nodeId, editing ? draft : suggestion); setEditing(false); };
  const startEdit = () => { setDraft(suggestion); setEditing(true); };

  // tópicos ao vivo: detecta da transcrição do entrevistador (debounce 2,5 s)
  useEffect(() => {
    if (!runner.running || transcription.trim().length < 20) return;
    const t = setTimeout(() => { fetchTopics(transcription).then((tp) => { if (tp.length) setTopics(tp); }).catch(() => {}); }, 2500);
    return () => clearTimeout(t);
  }, [transcription, runner.running]);

  return (
    <div className="live2">
      <header className="live2-top">
        <div className="live2-mode">
          <span className={`live-dot${runner.running ? ' live-dot--on' : ''}`} />
          <span className="live2-mode-label">LIVE MODE</span>
          <span className="live2-scenario">— {scenarioName}</span>
          <div className="live-flow-select">
            <Dropdown
              id="live-flow" size="sm" titleText="Workflow" hideLabel label="Workflow"
              items={flows.map((f) => ({ id: f.name, label: f.name }))}
              itemToString={(it) => (it ? it.label : '')}
              selectedItem={flows.map((f) => ({ id: f.name, label: f.name })).find((i) => i.id === currentFlow) ?? null}
              onChange={({ selectedItem }) => selectedItem && onSwitchFlow(selectedItem.id)}
            />
          </div>
        </div>
        <Tag type="green" size="md" className="latency-pill">Latência: {runner.latency != null ? `${Math.round(runner.latency)}ms` : '—'}</Tag>
        <div className="live2-top-actions">
          <Button kind="secondary" size="sm" renderIcon={runner.running ? Pause : Play} onClick={() => (runner.running ? runner.stop() : onStart(flow))}>
            {runner.running ? 'Pausar' : 'Retomar'}
          </Button>
          <Button kind="danger" size="sm" renderIcon={Stop} onClick={onExit}>Encerrar Sessão</Button>
        </div>
      </header>

      <div className="live2-body">
        <main className="live2-main">
          {lastError && <div className="live2-error">⚠ [{lastError.nodeId}] {lastError.message}</div>}
          {isInterview && (
            <>
              <div className="live2-label">Transcrição ao vivo (entrevistador)</div>
              <div className="live2-transcription">{transcription || (runner.running ? 'Ouvindo o entrevistador…' : '—')}</div>
            </>
          )}

          <div className="live2-stages">
            {stages.map((s) => {
              const items = stageItems(s, models, apps);
              return (
                <div key={s.key} className="stage-dd" style={{ ['--accent' as string]: s.accent }}>
                  <span className="stage-dd-label">{s.label}</span>
                  <Dropdown
                    id={`stage-${s.key}`} size="sm" titleText={s.label} hideLabel label={s.label}
                    items={items} itemToString={(it) => (it ? it.label : '')}
                    selectedItem={items.find((i) => i.id === s.value) ?? items[0]}
                    onChange={({ selectedItem }) => selectedItem && onUpdateStage(s.nodeId, s.param, selectedItem.id)}
                  />
                  {s.kind === 'app' && (
                    <Button kind="ghost" size="sm" hasIconOnly renderIcon={Renew} iconDescription="Recarregar apps" tooltipPosition="bottom" onClick={onRefreshApps} />
                  )}
                </div>
              );
            })}
          </div>

          <div className="live2-label">{heroLabel}</div>
          <div className="live2-suggestion">
            {editing && hasGate ? (
              <TextArea labelText="Editar sugestão" hideLabel rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
            ) : (
              <div className="live2-suggestion-text">
                {heroText || (runner.running ? (isInterview ? 'Gerando sugestão…' : 'Aguardando áudio…') : 'Inicie a sessão.')}
                {runner.running && !editing && <span className="live-cursor" />}
              </div>
            )}
          </div>
          {(hasLLM || hasGate) && (
            <div className="live2-actions">
              {hasLLM && <Button kind="ghost" size="sm" renderIcon={Renew} onClick={onRegenerate}>Regerar</Button>}
              {hasGate && (editing ? (
                <>
                  <Button kind="primary" size="sm" renderIcon={Checkmark} onClick={approve} disabled={!gate}>Enviar editada</Button>
                  <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>Cancelar</Button>
                </>
              ) : (
                <>
                  <Button kind="ghost" size="sm" renderIcon={Edit} onClick={startEdit} disabled={!gate}>Editar</Button>
                  <Button kind="primary" size="sm" renderIcon={Checkmark} className="approve-btn" onClick={approve} disabled={!gate}>
                    {hasTTS ? 'Aprovar & Falar' : 'Aprovar'}
                  </Button>
                </>
              ))}
            </div>
          )}
          {hasGate && !gate && runner.running && (
            <p className="live2-hint">Roteamento automático — sem gate humano pendente.</p>
          )}
        </main>

        <aside className="live2-side">
          <div className="live2-side-title">Contexto &amp; Cheatsheet</div>

          <input
            ref={fileRef} type="file" accept=".pdf,.txt,.md,.markdown" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onUploadDoc(f); e.target.value = ''; }}
          />
          <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => fileRef.current?.click()}>Carregar documento</Button>
          {contextDocs.map((d) => (
            <div key={d.name} className="ctx-doc">
              <Document size={18} />
              <div className="ctx-doc-body">
                <div className="ctx-doc-name">{d.name}</div>
                <div className="ctx-doc-sub ctx-doc-sub--ok"><Checkmark size={12} /> {d.points.length} pontos-chave extraídos</div>
                {d.points.length > 0 && <ul className="ctx-points">{d.points.map((p, i) => <li key={i}>{p}</li>)}</ul>}
              </div>
              <button className="ctx-doc-remove" onClick={() => onRemoveDoc(d.name)} title="Remover documento"><TrashCan size={14} /></button>
            </div>
          ))}
          {contextDocs.length === 0 && (
            <div className="ctx-doc ctx-doc--empty">
              <Document size={18} />
              <div>
                <div className="ctx-doc-name">Currículo / Job Description</div>
                <div className="ctx-doc-sub">Carregue um PDF ou TXT — os pontos informam a sugestão</div>
              </div>
            </div>
          )}

          <div className="ctx-block">
            <div className="ctx-block-title">Tópicos detectados</div>
            <div className="ctx-chips">
              {topics.length
                ? topics.map((t, i) => <Tag key={i} type="purple" size="sm">{t}</Tag>)
                : <span className="ctx-empty">{runner.running ? 'detectando…' : 'aparecem durante a fala'}</span>}
            </div>
          </div>

          {isInterview && (
            <>
              <div className="ctx-block">
                <div className="ctx-block-title"><Information size={16} /> Dica de estrutura</div>
                <p className="ctx-text">Use o método <strong>STAR</strong> (Situação, Tarefa, Ação, Resultado) para responder.</p>
              </div>

              <div className="ctx-block ctx-block--warn">
                <div className="ctx-block-title"><Warning size={16} /> Pontos de atenção</div>
                <p className="ctx-text">Não fale mal de monolitos — cite os trade-offs.</p>
              </div>
            </>
          )}

          <div className="ctx-mic">
            <Microphone size={18} />
            <div className="ctx-mic-info">
              <div className="ctx-mic-name">Capturando: {captureApp}</div>
              <div className={`ctx-level${runner.running ? ' ctx-level--on' : ''}`}>
                {Array.from({ length: 12 }).map((_, i) => <span key={i} style={{ ['--i' as string]: i }} />)}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}