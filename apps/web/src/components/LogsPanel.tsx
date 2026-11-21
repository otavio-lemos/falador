// Painel de logs dos 4 serviços residentes — usado tanto no Builder quanto no Live.
// Lógica idêntica à do LiveView (poll 1,5s, resize, collapse, multi-select).
import { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, MultiSelect } from '@carbon/react';
import { Close, ChevronDown, ChevronUp, Terminal } from '@carbon/icons-react';
import { fetchLogs } from '../api';

const LOG_SERVICES = [
  { id: 'omlx', label: 'LLM (omlx :8080)' },
  { id: 'asr', label: 'ASR (:8090)' },
  { id: 'tts', label: 'TTS (:8091)' },
  { id: 'web', label: 'Host/UI (:8787)' },
];

const LOG_MIN_HEIGHT = 120;
const LOG_DEFAULT_HEIGHT = 200;

function readInitial(key: string, fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string');
    }
  } catch { /* ignore */ }
  return fallback;
}

export function LogsPanel() {
  const [logServices, setLogServices] = useState<string[]>(() => readInitial('falador.logServices', ['omlx']));
  const [logsByService, setLogsByService] = useState<Record<string, string[]>>({});
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('falador.logsCollapsed') === 'true'; } catch { return false; }
  });
  const [height, setHeight] = useState<number>(() => {
    try { const n = Number(localStorage.getItem('falador.logsHeight')); return Number.isFinite(n) && n > 0 ? n : LOG_DEFAULT_HEIGHT; }
    catch { return LOG_DEFAULT_HEIGHT; }
  });
  const logsRefs = useRef<Record<string, HTMLPreElement | null>>({});

  useEffect(() => {
    if (!logServices.length) { setLogsByService({}); return; }
    let alive = true;
    const load = async () => {
      const entries = await Promise.all(logServices.map(async (svc) => {
        try { const r = await fetchLogs(svc, 200); return [svc, r.lines] as const; }
        catch { return [svc, [`(falha ao ler logs/${svc}.log)`]] as const; }
      }));
      if (alive) setLogsByService(Object.fromEntries(entries));
    };
    void load();
    const t = setInterval(() => void load(), 1500);
    return () => { alive = false; clearInterval(t); };
  }, [logServices]);

  useEffect(() => {
    for (const svc of logServices) {
      const el = logsRefs.current[svc];
      if (!el) continue;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      if (atBottom) el.scrollTop = el.scrollHeight;
    }
  }, [logsByService, logServices]);

  const persist = (next: string[]) => {
    setLogServices(next);
    try { localStorage.setItem('falador.logServices', JSON.stringify(next)); } catch { /* ignore */ }
  };

  const totalLines = logServices.reduce((s, svc) => s + (logsByService[svc]?.length ?? 0), 0);

  return (
    <section className="logs-panel" aria-label="Logs dos serviços" style={{ ['--logs-h' as string]: `${height}px` }}>
      {!collapsed && (
        <div className="logs-resizer" role="separator" aria-orientation="horizontal" tabIndex={0}
          onPointerDown={(e) => {
            e.preventDefault();
            const startY = e.clientY; const startH = height;
            const onMove = (ev: PointerEvent) => setHeight(Math.max(LOG_MIN_HEIGHT, Math.min(window.innerHeight * 0.85, startH + (startY - ev.clientY))));
            const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); try { localStorage.setItem('falador.logsHeight', String(height)); } catch { /* ignore */ } };
            window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
          }}>
          <span className="logs-resizer-grip" />
        </div>
      )}
      <div className="logs-panel-head">
        <span className="logs-panel-title"><Terminal size={16} /> Logs dos serviços</span>
        <div className="logs-panel-services">
          <MultiSelect id="logs-services-b" size="sm" titleText="Serviços" hideLabel label="Serviços"
            items={LOG_SERVICES} itemToString={(it) => (it ? it.label : '')}
            selectedItems={LOG_SERVICES.filter((s) => logServices.includes(s.id))}
            onChange={({ selectedItems }) => persist(LOG_SERVICES.map((s) => s.id).filter((id) => (selectedItems ?? []).some((x: { id: string }) => x.id === id)))} />
        </div>
        <span className="logs-panel-count">{totalLines} linhas</span>
        <Button kind="ghost" size="sm" hasIconOnly renderIcon={collapsed ? ChevronDown : ChevronUp}
          iconDescription={collapsed ? 'Expandir logs' : 'Recolher logs'} tooltipPosition="left"
          onClick={() => { const n = !collapsed; setCollapsed(n); try { localStorage.setItem('falador.logsCollapsed', String(n)); } catch { /* ignore */ } }} />
      </div>
      {!collapsed && (
        <div className="logs-panel-body">
          {logServices.length === 0 && <p className="logs-panel-empty">Nenhum serviço selecionado.</p>}
          {logServices.map((svc) => {
            const meta = LOG_SERVICES.find((s) => s.id === svc);
            const lines = logsByService[svc] ?? [];
            return (
              <div key={svc} className="logs-block">
                <div className="logs-block-head">
                  <span className="logs-block-title">{meta?.label ?? svc}</span>
                  <code className="logs-block-path">logs/{svc}.log</code>
                  <span className="logs-block-count">{lines.length} linhas</span>
                  <Button kind="ghost" size="sm" hasIconOnly renderIcon={Close} iconDescription={`Remover logs de ${svc}`} tooltipPosition="left"
                    onClick={() => persist(logServices.filter((s) => s !== svc))} />
                </div>
                <pre className="logs-terminal" ref={(el) => { logsRefs.current[svc] = el; }}>{lines.length ? lines.join('\n') : `sem linhas — logs/${svc}.log`}</pre>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}