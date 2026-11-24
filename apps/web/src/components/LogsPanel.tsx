// Painel de logs dos serviços residentes (compartilhado entre LiveView e BuilderView).
// Altura 100% fixa controlada pelo usuário (resizer + recolher), MultiSelect de serviços,
// e retângulos coloridos identificando visualmente quais componentes do workflow escrevem em cada log.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, MultiSelect, Tab, TabList, TabPanel, TabPanels, Tabs } from '@carbon/react';
import { ChevronDown, ChevronUp, Close, Terminal, TrashCan } from '@carbon/icons-react';
import type { AuditEvent } from '../useRunner';
import { clearLogs, fetchLogs, fetchServiceStatus, type ServiceStatusMap } from '../api';
import { accentOf, serviceOfNode, shortNodeName } from '../data';
import { AuditPanel } from '../components/AuditPanel';

interface ServiceColorTag {
  color: string;
  label: string;
}

interface LogServiceMeta {
  id: string;
  shortLabel: string;
  label: string;
  colors: ServiceColorTag[];
}

interface BaseServiceConfig {
  id: keyof ServiceStatusMap;
  port: number;
  fallbackLabel: string;
  fallbackColors: ServiceColorTag[];
}

const BASE_SERVICES: BaseServiceConfig[] = [
  {
    id: 'web',
    port: 8787,
    fallbackLabel: 'Input · Approval · Output',
    fallbackColors: [
      { color: '#22d3ee', label: 'Input' },
      { color: '#f59e0b', label: 'Approval' },
      { color: '#f97316', label: 'Command / RAG / MCP' },
      { color: '#22c55e', label: 'Output' },
    ],
  },
  {
    id: 'asr',
    port: 8090,
    fallbackLabel: 'Transcription',
    fallbackColors: [
      { color: '#14b8a6', label: 'Transcription' },
    ],
  },
  {
    id: 'omlx',
    port: 8080,
    fallbackLabel: 'LLM · Translate · Agent · Decision',
    fallbackColors: [
      { color: '#8b5cf6', label: 'LLM / Translate / Agent' },
      { color: '#f59e0b', label: 'Decision / Turn Detection' },
    ],
  },
  {
    id: 'tts',
    port: 8091,
    fallbackLabel: 'TTS · Speech Translation',
    fallbackColors: [
      { color: '#d946ef', label: 'TTS' },
      { color: '#14b8a6', label: 'Speech Translation' },
    ],
  },
];

const LOG_SERVICES_KEY = 'falador.logServices';
const LOG_HEIGHT_KEY = 'falador.logsHeight';
const LOG_COLLAPSED_KEY = 'falador.logsCollapsed';
const LOG_VIEW_KEY = 'falador.logsView';
const MIN_LOGS_H = 110;
const MAX_LOGS_H = 520;
const DEFAULT_LOGS_H = 180;

interface FlowNodeRef {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  enabled?: boolean;
}

interface LogsPanelProps {
  flowNodes?: FlowNodeRef[];
  onServiceStatus?: (status: ServiceStatusMap) => void;
  thoughtsOn?: boolean;
  onToggleThoughts?: (next: boolean) => void;
  resetSignal?: number;
  hasAgent?: boolean;
  onOpenConsole?: () => void;
  audit?: AuditEvent[];
}

export function LogsPanel({ flowNodes, onServiceStatus, thoughtsOn = false, onToggleThoughts, resetSignal = 0, hasAgent = false, onOpenConsole, audit = [] }: LogsPanelProps) {
  const logsRefs = useRef<Record<string, HTMLPreElement | null>>({});
  const clearEpochRef = useRef(0);
  const onServiceStatusRef = useRef(onServiceStatus);
  onServiceStatusRef.current = onServiceStatus;
  const [clearing, setClearing] = useState(false);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusMap | null>(null);
  // Alterna Logs ⇄ Auditoria no MESMO painel (proposto pelo dono em 2026-11-23).
  const [view, setView] = useState<0 | 1>(() => {
    try { return localStorage.getItem(LOG_VIEW_KEY) === 'audit' ? 1 : 0; } catch { return 0; }
  });
  const changeView = (index: number) => {
    const next: 0 | 1 = index === 1 ? 1 : 0;
    setView(next);
    try { localStorage.setItem(LOG_VIEW_KEY, next === 1 ? 'audit' : 'logs'); } catch { /* ignore */ }
  };
  const [logServices, setLogServices] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LOG_SERVICES_KEY) ?? 'null');
      if (Array.isArray(saved)) {
        return saved.filter((s) => BASE_SERVICES.some((x) => x.id === s));
      }
    } catch { /* ignore */ }
    return ['web'];
  });

  const servicesMeta = useMemo<LogServiceMeta[]>(() => {
    const activeNodes = (flowNodes ?? []).filter((n) => n.enabled !== false);
    const base: LogServiceMeta[] = BASE_SERVICES.map((base) => {
      const matched = activeNodes.filter((n) => serviceOfNode(n.type) === base.id);
      if (matched.length === 0) {
        return {
          id: base.id,
          shortLabel: base.fallbackLabel,
          label: `${base.fallbackLabel} (:${base.port})`,
          colors: base.fallbackColors,
        };
      }
      const names: string[] = [];
      const byColor = new Map<string, string[]>();
      for (const n of matched) {
        const name = shortNodeName(n.type, n.id, n.params);
        if (!names.includes(name)) names.push(name);
        const accent = accentOf(n.type);
        const list = byColor.get(accent) ?? [];
        if (!list.includes(name)) list.push(name);
        byColor.set(accent, list);
      }
      const shortLabel = names.join(' · ');
      const colors: ServiceColorTag[] = [...byColor.entries()].map(([color, list]) => ({
        color,
        label: list.join(' · '),
      }));
      return {
        id: base.id,
        shortLabel,
        label: `${shortLabel} (:${base.port})`,
        colors,
      };
    });
    return base;
  }, [flowNodes]);
  const [logsByService, setLogsByService] = useState<Record<string, string[]>>({});
  const [logsHeight, setLogsHeight] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(LOG_HEIGHT_KEY));
      if (Number.isFinite(n) && n >= MIN_LOGS_H && n <= MAX_LOGS_H) return n;
    } catch { /* ignore */ }
    return DEFAULT_LOGS_H;
  });
  const [logsCollapsed, setLogsCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(LOG_COLLAPSED_KEY) === 'true'; } catch { return false; }
  });
  const onLogServicesChange = (items: LogServiceMeta[]) => {
    const ids = items.map((i) => i.id);
    setLogServices(ids);
    try { localStorage.setItem(LOG_SERVICES_KEY, JSON.stringify(ids)); } catch { /* ignore */ }
  };

  const removeLogService = (svc: string) => {
    const next = logServices.filter((s) => s !== svc);
    setLogServices(next);
    try { localStorage.setItem(LOG_SERVICES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const toggleLogsCollapsed = () => {
    setLogsCollapsed((cur) => {
      const next = !cur;
      try { localStorage.setItem(LOG_COLLAPSED_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const onLogsResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = logsHeight;
    let latestH = startH;
    const onMove = (ev: PointerEvent) => {
      latestH = Math.min(MAX_LOGS_H, Math.max(MIN_LOGS_H, Math.round(startH + (startY - ev.clientY))));
      setLogsHeight(latestH);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { localStorage.setItem(LOG_HEIGHT_KEY, String(latestH)); } catch { /* ignore */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onLogsResizeKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const delta = e.key === 'ArrowUp' ? 24 : -24;
    const next = Math.min(MAX_LOGS_H, Math.max(MIN_LOGS_H, logsHeight + delta));
    setLogsHeight(next);
    try { localStorage.setItem(LOG_HEIGHT_KEY, String(next)); } catch { /* ignore */ }
  };

  const handleClearLogs = async () => {
    if (logServices.length === 0 || clearing) return;
    const targets = logServices;
    clearEpochRef.current += 1;
    setClearing(true);
    setLogsByService((prev) => {
      const next = { ...prev };
      for (const svc of targets) next[svc] = [];
      return next;
    });
    try {
      await clearLogs(targets);
    } catch {
      setLogsByService((prev) => {
        const next = { ...prev };
        for (const svc of targets) next[svc] = [`(falha ao limpar logs/${svc}.log)`];
        return next;
      });
    } finally {
      setClearing(false);
    }
  };

  const resetSeenRef = useRef(resetSignal);
  useEffect(() => {
    if (resetSeenRef.current === resetSignal) return;
    resetSeenRef.current = resetSignal;
    clearEpochRef.current += 1;
    setLogsByService({});
  }, [resetSignal]);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetchServiceStatus();
        if (!alive) return;
        setServiceStatus(res.services);
        onServiceStatusRef.current?.(res.services);
      } catch {
        if (alive) {
          const down: ServiceStatusMap = { web: false, asr: false, omlx: false, tts: false };
          setServiceStatus(down);
          onServiceStatusRef.current?.(down);
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (logsCollapsed || logServices.length === 0) return;
    let alive = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      const epoch = clearEpochRef.current;
      try {
        const entries = await Promise.all(
          logServices.map(async (svc) => {
            try {
              const r = await fetchLogs(svc, 250);
              return [svc, r.lines] as const;
            } catch {
              return [svc, [`(falha ao ler logs/${svc}.log)`] as string[]] as const;
            }
          }),
        );
        if (alive && epoch === clearEpochRef.current) {
          setLogsByService((prev) => {
            let changed = false;
            const next = { ...prev };
            for (const [svc, lines] of entries) {
              const cur = prev[svc];
              if (!cur || cur.length !== lines.length || cur.some((l, i) => l !== lines[i])) {
                next[svc] = lines;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }
      } finally {
        inFlight = false;
      }
    };
    void load();
    const t = setInterval(() => void load(), 1500);
    return () => { alive = false; clearInterval(t); };
  }, [logServices, logsCollapsed]);

  useEffect(() => {
    for (const svc of logServices) {
      const el = logsRefs.current[svc];
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [logsByService, logServices]);

  return (
    <section
      className={`logs-panel${logsCollapsed ? ' logs-panel--collapsed' : ''}`}
      aria-label="Logs dos serviços"
      style={{ ['--logs-h' as string]: `${logsHeight}px` }}
    >
      {!logsCollapsed && (
        <div
          className="logs-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Redimensionar painel de logs (arraste para cima ou para baixo)"
          tabIndex={0}
          onPointerDown={onLogsResizeStart}
          onKeyDown={onLogsResizeKeyDown}
        >
          <span className="logs-resizer-grip" />
        </div>
      )}
      <div className="logs-panel-head">
        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          renderIcon={logsCollapsed ? ChevronUp : ChevronDown}
          iconDescription={logsCollapsed ? 'Expandir logs' : 'Recolher logs'}
          tooltipPosition="right"
          onClick={toggleLogsCollapsed}
        />
        <div className="logs-panel-view">
          <Tabs selectedIndex={view} onChange={({ selectedIndex }) => changeView(selectedIndex ?? 0)}>
            <TabList size="sm" aria-label="Painel inferior">
              <Tab>Logs</Tab>
              <Tab>{`Auditoria${audit.length > 0 ? ` (${audit.length})` : ''}`}</Tab>
            </TabList>
            <TabPanels>
              <TabPanel aria-label="Logs">
                <span className="logs-tabpanel-label">Logs dos serviços residentes</span>
              </TabPanel>
              <TabPanel aria-label="Auditoria">
                <span className="logs-tabpanel-label">Trilha de auditoria</span>
              </TabPanel>
            </TabPanels>
          </Tabs>
        </div>
        <div className="logs-panel-services">
          <MultiSelect
            id="logs-services"
            size="sm"
            titleText="Componentes"
            hideLabel
            label="Selecionar componentes"
            items={servicesMeta}
            itemToString={(it) => (it ? it.label : '')}
            selectedItems={servicesMeta.filter((s) => logServices.includes(s.id))}
            onChange={({ selectedItems }) => onLogServicesChange(selectedItems ?? [])}
          />
        </div>
        <Button
          kind="tertiary"
          size="sm"
          renderIcon={TrashCan}
          onClick={() => void handleClearLogs()}
          disabled={view === 1 || logServices.length === 0 || clearing}
        >
          Limpar logs
        </Button>
        {hasAgent && (
          <Button
            kind="tertiary"
            size="sm"
            renderIcon={Terminal}
            onClick={onOpenConsole}
            title="Abrir Console de execuções"
          >
            Console
          </Button>
        )}
        {onToggleThoughts && (
          <Button
            kind={thoughtsOn ? 'primary' : 'tertiary'}
            size="sm"
            onClick={() => onToggleThoughts(!thoughtsOn)}
            aria-pressed={thoughtsOn}
          >
            Pensamentos
          </Button>
        )}
        <div className="logs-service-badges" role="status" aria-label="Status dos serviços">
          {servicesMeta.map((meta) => {
            const up = serviceStatus ? serviceStatus[meta.id as keyof ServiceStatusMap] : false;
            return (
              <span
                key={meta.id}
                className={`logs-svc-badge ${up ? 'logs-svc-badge--up' : 'logs-svc-badge--down'}`}
                title={`${meta.label} — ${up ? 'Rodando' : 'Parado'}`}
              >
                {meta.shortLabel}
              </span>
            );
          })}
        </div>
        <Button
          kind="ghost"
          size="sm"
          hasIconOnly
          renderIcon={logsCollapsed ? ChevronUp : ChevronDown}
          iconDescription={logsCollapsed ? 'Expandir logs' : 'Recolher logs'}
          tooltipPosition="left"
          onClick={toggleLogsCollapsed}
        />
      </div>
      {!logsCollapsed && (
        <div className={`logs-panel-body${view === 1 ? ' logs-panel-body--audit' : ''}`}>
          {view === 1 ? (
            <AuditPanel audit={audit} />
          ) : (
            <>
          {logServices.length === 0 && (
            <p className="logs-panel-empty">Nenhum bloco selecionado — escolha acima.</p>
          )}
          {logServices.map((svc) => {
            const meta = servicesMeta.find((s) => s.id === svc);
            const lines = logsByService[svc] ?? [];
            return (
              <div key={svc} className="logs-block">
                <div className="logs-block-head">
                  <span className="logs-block-title">{meta?.label ?? svc}</span>
                  <code className="logs-block-path">logs/{svc}.log</code>
                  {meta && meta.colors.length > 0 && (
                    <span className="logs-color-swatches" aria-label="Componentes deste log">
                      {meta.colors.map((c, idx) => (
                        <span
                          key={idx}
                          className="logs-color-swatch"
                          style={{ background: c.color }}
                          tabIndex={0}
                          aria-label={c.label}
                        >
                          <span className="logs-color-tip" role="tooltip">{c.label}</span>
                        </span>
                      ))}
                    </span>
                  )}
                  <Button
                    kind="ghost"
                    size="sm"
                    hasIconOnly
                    renderIcon={Close}
                    iconDescription={`Remover logs de ${svc}`}
                    tooltipPosition="left"
                    onClick={() => removeLogService(svc)}
                  />
                </div>
                <pre
                  className="logs-terminal"
                  ref={(el) => { logsRefs.current[svc] = el; }}
                >{lines.length ? lines.join('\n') : `Log vazio — logs/${svc}.log`}</pre>
              </div>
            );
          })}
            </>
          )}
        </div>
      )}
    </section>
  );
}
