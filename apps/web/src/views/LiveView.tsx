// Tela de EXECUÇÃO — layout do dono: LIVE MODE + latência + Pausar/Encerrar;
// transcrição do entrevistador; DROPDOWN POR ETAPA do workflow (troca a config real
// de cada nó); sugestão hero (o que o dono lê pra falar) + Regerar/Editar/Aprovar;
// sidebar Contexto & Cheatsheet. Dados reais; RAG/tópicos marcados como não conectados.
import { useMemo, useState } from 'react';
import { Button, Dropdown, Tag, TextArea } from '@carbon/react';
import { Pause, Play, Stop, Renew, Edit, Checkmark, Document, Warning, Information, Microphone } from '@carbon/icons-react';
import type { Runner } from '../useRunner';
import type { Flow } from '../api';
import { deriveStages, classifySinks, shortModel, type Stage } from '../live-utils';

interface Props {
  runner: Runner;
  flow: Flow;
  scenarioName: string;
  models: { omlx: string[]; cache: string[] };
  apps: string[];
  onUpdateStage: (nodeId: string, param: string, value: unknown) => void;
  onRegenerate: () => void;
  onExit: () => void;
}

interface Item { id: string; label: string }

function stageItems(stage: Stage, models: { omlx: string[]; cache: string[] }, apps: string[]): Item[] {
  let vals: string[] = [];
  if (stage.kind === 'app') vals = apps.length ? apps : [stage.value];
  else if (stage.kind === 'model-asr') vals = models.cache.filter((m) => /voxtral|realtime/i.test(m));
  else if (stage.kind === 'model-llm') vals = models.omlx;
  else if (stage.kind === 'gate') return [{ id: 'humano', label: 'Manual' }, { id: 'auto', label: 'Auto' }];
  else if (stage.kind === 'voice') return [{ id: 'female', label: 'Feminino' }, { id: 'male', label: 'Masculino' }];
  const items = vals.filter(Boolean).map((v) => ({ id: v, label: stage.kind.startsWith('model') ? shortModel(v) : v }));
  if (stage.value && !items.some((i) => i.id === stage.value)) {
    items.unshift({ id: stage.value, label: stage.kind.startsWith('model') ? shortModel(stage.value) : stage.value });
  }
  return items.length ? items : [{ id: stage.value || '—', label: stage.value || '—' }];
}

export function LiveView({ runner, flow, scenarioName, models, apps, onUpdateStage, onRegenerate, onExit }: Props) {
  const stages = useMemo(() => deriveStages(flow), [flow]);
  const sinks = useMemo(() => classifySinks(flow), [flow]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const lastOf = (set: Set<string>) => [...runner.captions].reverse().find((c) => set.has(c.nodeId));
  const transcription = lastOf(sinks.transcription)?.text ?? '';
  const gate = runner.gates[0];
  const suggestion = gate ? gate.text : (lastOf(sinks.suggestion)?.text ?? '');
  const captureApp = stages.find((s) => s.kind === 'app')?.value ?? '—';

  const approve = () => { if (gate) runner.gate(gate.nodeId, editing ? draft : suggestion); setEditing(false); };
  const startEdit = () => { setDraft(suggestion); setEditing(true); };

  return (
    <div className="live2">
      <header className="live2-top">
        <div className="live2-mode">
          <span className={`live-dot${runner.running ? ' live-dot--on' : ''}`} />
          <span className="live2-mode-label">LIVE MODE</span>
          <span className="live2-scenario">— {scenarioName}</span>
        </div>
        <Tag type="green" size="md" className="latency-pill">Latência: {runner.latency != null ? `${Math.round(runner.latency)}ms` : '—'}</Tag>
        <div className="live2-top-actions">
          <Button kind="secondary" size="sm" renderIcon={runner.running ? Pause : Play} onClick={() => (runner.running ? runner.stop() : runner.start(flow))}>
            {runner.running ? 'Pausar' : 'Retomar'}
          </Button>
          <Button kind="danger" size="sm" renderIcon={Stop} onClick={onExit}>Encerrar Sessão</Button>
        </div>
      </header>

      <div className="live2-body">
        <main className="live2-main">
          <div className="live2-label">Transcrição ao vivo (entrevistador)</div>
          <div className="live2-transcription">{transcription || (runner.running ? 'Ouvindo o entrevistador…' : '—')}</div>

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
                </div>
              );
            })}
          </div>

          <div className="live2-label">Sugestão de resposta (para você falar)</div>
          <div className="live2-suggestion">
            {editing ? (
              <TextArea labelText="Editar sugestão" hideLabel rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} />
            ) : (
              <div className="live2-suggestion-text">
                {suggestion || (runner.running ? 'Gerando sugestão…' : 'Inicie a sessão para ver a sugestão.')}
                {runner.running && !editing && <span className="live-cursor" />}
              </div>
            )}
          </div>
          <div className="live2-actions">
            <Button kind="ghost" size="sm" renderIcon={Renew} onClick={onRegenerate}>Regerar</Button>
            {editing ? (
              <>
                <Button kind="primary" size="sm" renderIcon={Checkmark} onClick={approve} disabled={!gate}>Enviar editada</Button>
                <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>Cancelar</Button>
              </>
            ) : (
              <>
                <Button kind="ghost" size="sm" renderIcon={Edit} onClick={startEdit} disabled={!suggestion}>Editar</Button>
                <Button kind="primary" size="sm" renderIcon={Checkmark} className="approve-btn" onClick={approve} disabled={!gate}>
                  Aprovar &amp; Falar
                </Button>
              </>
            )}
          </div>
          {!gate && runner.running && (
            <p className="live2-hint">Roteamento automático — sem gate humano pendente. “Aprovar &amp; Falar” ativa quando o Gate está em Manual.</p>
          )}
        </main>

        <aside className="live2-side">
          <div className="live2-side-title">Contexto &amp; Cheatsheet</div>

          <div className="ctx-doc ctx-doc--empty">
            <Document size={18} />
            <div>
              <div className="ctx-doc-name">Currículo / Job Description</div>
              <div className="ctx-doc-sub">RAG de documentos — não conectado ainda</div>
            </div>
          </div>

          <div className="ctx-block">
            <div className="ctx-block-title">Tópicos detectados</div>
            <div className="ctx-chips"><span className="ctx-empty">detecção automática em breve</span></div>
          </div>

          <div className="ctx-block">
            <div className="ctx-block-title"><Information size={16} /> Dica de estrutura</div>
            <p className="ctx-text">Use o método <strong>STAR</strong> (Situação, Tarefa, Ação, Resultado) para responder.</p>
          </div>

          <div className="ctx-block ctx-block--warn">
            <div className="ctx-block-title"><Warning size={16} /> Pontos de atenção</div>
            <p className="ctx-text">Não fale mal de monolitos — cite os trade-offs.</p>
          </div>

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