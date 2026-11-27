// Painel de logs dos serviços residentes (compartilhado entre LiveView e BuilderView).
// Altura 100% fixa controlada pelo usuário (resizer + recolher), MultiSelect de serviços,
// e retângulos coloridos identificando visualmente quais componentes do workflow escrevem em cada log.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Button, Dropdown, MultiSelect, Tab, TabList, TabPanel, TabPanels, Tabs, Tag } from '@carbon/react';
import { ChevronDown, ChevronUp, Close, Launch, TrashCan } from '@carbon/icons-react';
import type { AuditEvent, Thought, Execution, Gate } from '../useRunner';
import { clearLogs, fetchLogs, fetchServiceStatus, type ServiceStatusMap } from '../api';
import { accentOf, serviceOfNode, shortNodeName } from '../data';
import { AuditPanel } from '../components/AuditPanel';
import { TerminalPanel } from './TerminalPanel';
import type { PopoutPanel } from '../popout';

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
  displayName: string; // nome da solução/executor exibido no cabeçalho do bloco
  fallbackLabel: string;
  fallbackColors: ServiceColorTag[];
}

const BASE_SERVICES: BaseServiceConfig[] = [
  {
    id: 'web',
    port: 8787,
    displayName: 'falador host',
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
    displayName: 'ASR Streaming (mlx-audio)',
    fallbackLabel: 'Transcription',
    fallbackColors: [
      { color: '#14b8a6', label: 'Transcription' },
    ],
  },
  {
    id: 'omlx',
    port: 8080,
    displayName: 'omlx',
    fallbackLabel: 'LLM · Translate · Agent · Decision',
    fallbackColors: [
      { color: '#8b5cf6', label: 'LLM / Translate / Agent' },
      { color: '#f59e0b', label: 'Decision / Turn Detection' },
    ],
  },
  {
    id: 'tts',
    port: 8091,
    displayName: 'TTS / STS (LFM3-Audio)',
    fallbackLabel: 'TTS · Speech Translation',
    fallbackColors: [
      { color: '#d946ef', label: 'TTS' },
      { color: '#14b8a6', label: 'Speech Translation' },
    ],
  },
  {
    id: 'omni',
    port: 8092,
    displayName: 'Omni · mlx-vlm (LFM3-Omni)',
    fallbackLabel: 'Speech Translation · TTS',
    fallbackColors: [
      { color: '#14b8a6', label: 'Speech Translation' },
      { color: '#d946ef', label: 'TTS' },
    ],
  },
];

const LOG_SERVICES_KEY = 'falador.logServices';
const LOG_HEIGHT_KEY = 'falador.logsHeight';
const LOG_COLLAPSED_KEY = 'falador.logsCollapsed';
const LOG_VIEW_KEY = 'falador.logsView';
const MIN_LOGS_H = 110;
const DEFAULT_LOGS_H = 300;
function getMaxLogsHeight(): number {
  return Math.max(600, Math.floor((typeof window !== 'undefined' ? window.innerHeight : 900) * 0.85));
}

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
  thoughts?: Thought[];
  onToggleThoughts?: (next: boolean) => void;
  resetSignal?: number;
  hasAgent?: boolean;
  onOpenConsole?: () => void;
  audit?: AuditEvent[];
  auditFocus?: { nodeId: string; token: number } | null;
  executions?: Execution[];
  gates?: Gate[];
  onApproveGate?: (gate: Gate, text: string) => Promise<void> | void;
  onRejectGate?: (gate: Gate, reason?: string) => Promise<void> | void;
  /** Pill de status do turno (Parado/Pensando/.../Aguardando aprovação) — fica no centro da barra. */
  turnStatus?: { label: string; type: 'gray' | 'cyan' | 'green' | 'blue' | 'purple' | 'teal' | 'red' | 'magenta' | 'warm-gray'; accent?: string };
  /** Aba inicial no modo pop-out (janela própria). */
  forceView?: 'logs' | 'audit' | 'terminal';
  /** Filtra para mostrar apenas um serviço de log específico (para popout individual). */
  forceService?: string;
  /** Abre o painel atual em janela própria (botão ↗). Ausente = sem botão. */
  onPopout?: (panel: PopoutPanel) => void;
  /** Abre um serviço de log específico em janela própria. */
  onLogPopout?: (serviceId: string) => void;
}

export function LogsPanel({
  flowNodes,
  onServiceStatus,
  thoughtsOn = false,
  thoughts = [],
  onToggleThoughts,
  resetSignal = 0,
  hasAgent = false,
  onOpenConsole,
  audit = [],
  auditFocus = null,
  executions = [],
  gates = [],
  onApproveGate,
  onRejectGate,
  turnStatus,
  forceView,
  forceService,
  onPopout,
  onLogPopout,
}: LogsPanelProps) {
  const logsRefs = useRef<Record<string, HTMLPreElement | null>>({});
  const clearEpochRef = useRef(0);
  const onServiceStatusRef = useRef(onServiceStatus);
  onServiceStatusRef.current = onServiceStatus;
  const [clearing, setClearing] = useState(false);
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusMap | null>(null);
  // Alterna Logs (0) ⇄ Auditoria (1) ⇄ Terminal (2) no MESMO painel embutido.
  const [view, setView] = useState<0 | 1 | 2>(() => {
    if (forceView) return forceView === 'terminal' ? 2 : forceView === 'audit' ? 1 : 0;
    try {
      const saved = localStorage.getItem(LOG_VIEW_KEY);
      if (saved === 'terminal') return 2;
      if (saved === 'audit') return 1;
      return 0;
    } catch { return 0; }
  });
  const [logsExpanded, setLogsExpanded] = useState(false);
  const logsExpandedRef = useRef(logsExpanded);
  logsExpandedRef.current = logsExpanded;
  const changeView = (index: number) => {
    const next: 0 | 1 | 2 = index === 2 ? 2 : index === 1 ? 1 : 0;
    setView(next);
    if ((next === 1 || next === 2) && !logsExpandedRef.current) {
      setLogsHeight((h) => (h < 320 ? 320 : h));
    }
    try {
      // No pop-out a aba é fixa por painel: não sobrescreve a preferência da página central.
      if (!forceView) localStorage.setItem(LOG_VIEW_KEY, next === 2 ? 'terminal' : next === 1 ? 'audit' : 'logs');
    } catch { /* ignore */ }
  };

  useEffect(() => {
    const handler = () => {
      changeView(2);
      setLogsCollapsed(false);
    };
    window.addEventListener('falador-open-terminal', handler);
    return () => window.removeEventListener('falador-open-terminal', handler);
  }, []);

  const [logServices, setLogServices] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LOG_SERVICES_KEY) ?? 'null');
      if (Array.isArray(saved)) {
        return saved.filter((s) => BASE_SERVICES.some((x) => x.id === s));
      }
    } catch { /* ignore */ }
    return ['web'];
  });
  const activeLogServices = useMemo<string[]>(
    () => (forceService ? [forceService] : logServices),
    [forceService, logServices],
  );

  const servicesMeta = useMemo<LogServiceMeta[]>(() => {
    const activeNodes = (flowNodes ?? []).filter((n) => n.enabled !== false);
    const base: LogServiceMeta[] = BASE_SERVICES.map((base) => {
      const matched = activeNodes.filter((n) => serviceOfNode(n.type, n.params) === base.id);
      const colors: ServiceColorTag[] = (() => {
        if (matched.length === 0) return base.fallbackColors;
        const byColor = new Map<string, string[]>();
        for (const n of matched) {
          const name = shortNodeName(n.type, n.id, n.params);
          const accent = accentOf(n.type);
          const list = byColor.get(accent) ?? [];
          if (!list.includes(name)) list.push(name);
          byColor.set(accent, list);
        }
        return [...byColor.entries()].map(([color, list]) => ({ color, label: list.join(' · ') }));
      })();
      // Label mostrado no cabeçalho do bloco: sempre o nome da solução (displayName), nunca os nomes dos componentes
      const shortLabel = base.displayName;
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
      if (Number.isFinite(n) && n >= MIN_LOGS_H && n <= getMaxLogsHeight()) return n;
    } catch { /* ignore */ }
    return DEFAULT_LOGS_H;
  });
  const [logsCollapsed, setLogsCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(LOG_COLLAPSED_KEY) === 'true'; } catch { return false; }
  });

  // Ponte conversa → Auditoria: um card clicável pede a aba e o filtro por nodeId.
  useEffect(() => {
    if (!auditFocus?.nodeId) return;
    changeView(1);
    setLogsCollapsed(false);
    try { localStorage.setItem(LOG_COLLAPSED_KEY, 'false'); } catch { /* ignore */ }
  }, [auditFocus?.token]);
  useEffect(() => {
    if (!auditFocus?.nodeId || view !== 1 || logsCollapsed) return;
    // shortcut: a busca vive dentro do AuditPanel (fora do escopo desta mudança),
    // então preenchemos o input existente pelo evento de input nativo.
    const input = document.getElementById('audit-filter-decisions') as HTMLInputElement | null;
    if (!input) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, auditFocus.nodeId);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, [auditFocus?.token, view, logsCollapsed]);

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
    setLogsExpanded(false);
    const startY = e.clientY;
    const startH = logsHeight;
    let latestH = startH;
    const onMove = (ev: PointerEvent) => {
      latestH = Math.min(getMaxLogsHeight(), Math.max(MIN_LOGS_H, Math.round(startH + (startY - ev.clientY))));
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
    setLogsExpanded(false);
    const delta = e.key === 'ArrowUp' ? 24 : -24;
    const next = Math.min(getMaxLogsHeight(), Math.max(MIN_LOGS_H, logsHeight + delta));
    setLogsHeight(next);
    try { localStorage.setItem(LOG_HEIGHT_KEY, String(next)); } catch { /* ignore */ }
  };

  const handleClearLogs = async () => {
    if (activeLogServices.length === 0 || clearing) return;
    const targets = activeLogServices;
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
        setServiceStatus((prev) =>
          prev &&
          prev.web === res.services.web &&
          prev.asr === res.services.asr &&
          prev.omlx === res.services.omlx &&
          prev.tts === res.services.tts &&
          prev.omni === res.services.omni
            ? prev
            : res.services,
        );
        onServiceStatusRef.current?.(res.services);
      } catch {
        if (alive) {
          const down: ServiceStatusMap = { web: false, asr: false, omlx: false, tts: false, omni: false };
          setServiceStatus((prev) =>
            prev && !prev.web && !prev.asr && !prev.omlx && !prev.tts && !prev.omni ? prev : down,
          );
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
    if (logsCollapsed || view !== 0 || activeLogServices.length === 0) return;
    let alive = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      const epoch = clearEpochRef.current;
      try {
        const entries = await Promise.all(
          activeLogServices.map(async (svc) => {
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
  }, [activeLogServices, logsCollapsed, view]);

  useEffect(() => {
    for (const svc of activeLogServices) {
      const el = logsRefs.current[svc];
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [logsByService, activeLogServices]);

  const toggleLogsExpanded = () => {
    if (logsCollapsed) {
      setLogsCollapsed(false);
      try { localStorage.setItem(LOG_COLLAPSED_KEY, 'false'); } catch { /* ignore */ }
      setLogsExpanded(true);
      return;
    }
    setLogsExpanded((cur) => !cur);
  };

  return (
    <section
      className={`logs-panel${logsCollapsed ? ' logs-panel--collapsed' : ''}${!logsCollapsed && logsExpanded ? ' logs-panel--expanded' : ''}`}
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
              <Tab>{`Terminal${executions.length > 0 ? ` (${executions.length})` : ''}`}</Tab>
            </TabList>
            <TabPanels>
              <TabPanel aria-label="Logs">
                <span className="logs-tabpanel-label">Logs dos serviços residentes</span>
              </TabPanel>
              <TabPanel aria-label="Auditoria">
                <span className="logs-tabpanel-label">Trilha de auditoria</span>
              </TabPanel>
              <TabPanel aria-label="Terminal">
                <span className="logs-tabpanel-label">Terminal de execuções SSH/local</span>
              </TabPanel>
            </TabPanels>
          </Tabs>
        </div>
        {!forceService && (
          <>
            <div className="logs-panel-services">
              <MultiSelect
                id="logs-services"
                size="sm"
                titleText="Componentes"
                hideLabel
                label="Selecionar componentes"
                disabled={view !== 0}
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
              disabled={view !== 0 || logServices.length === 0 || clearing}
            >
              Limpar logs
            </Button>
          </>
        )}
        {turnStatus && (
          <div className="logs-panel-status">
            <Tag
              type={turnStatus.type}
              size="sm"
              data-testid="turn-status"
              style={turnStatus.accent ? { backgroundColor: turnStatus.accent, color: '#161616' } : undefined}
            >
              {turnStatus.label}
            </Tag>
          </div>
        )}
        {!forceService && onToggleThoughts && (
          <div className="thoughts-wrap">
            <Button
              kind={thoughtsOn ? 'primary' : 'tertiary'}
              size="sm"
              onClick={() => onToggleThoughts(!thoughtsOn)}
              aria-pressed={thoughtsOn}
              aria-expanded={thoughtsOn}
            >
              Pensamentos
            </Button>
            {thoughtsOn && (
              <div className="thoughts-menu" role="region" aria-label="Pensamentos do agente">
                <div className="thoughts-menu-head">Pensamentos ({thoughts.length})</div>
                {thoughts.length === 0
                  ? <p className="thoughts-empty">Nenhum pensamento neste run. O modelo está com thinking desligado para respostas rápidas.</p>
                  : [...thoughts].reverse().map((t) => (
                      <details key={t.thoughtId} className="thoughts-item">
                        <summary>
                          <span>{shortNodeName(flowNodes?.find((n) => n.id === t.nodeId)?.type ?? '', t.nodeId)}</span>
                          <time>{new Date(t.ts).toLocaleTimeString()}</time>
                        </summary>
                        <pre>{t.text}</pre>
                      </details>
                    ))}
              </div>
            )}
          </div>
        )}
        {!forceService && onPopout && (
          <Button
            kind="ghost"
            size="sm"
            hasIconOnly
            renderIcon={Launch}
            iconDescription="Abrir em janela"
            tooltipPosition="top"
            onClick={() => onPopout(view === 2 ? 'terminal' : view === 1 ? 'audit' : 'logs')}
          />
        )}
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
        <div
          className={`logs-panel-body${
            view === 1 ? ' logs-panel-body--audit' : view === 2 ? ' logs-panel-body--terminal' : ''
          }`}
        >
          {view === 1 ? (
            <AuditPanel audit={audit} />
          ) : view === 2 ? (
            <TerminalPanel
              executions={executions}
              gates={gates}
              onApprove={onApproveGate}
              onReject={onRejectGate}
              forceService={forceService}
            />
          ) : (
            <>
          {activeLogServices.length === 0 && (
            <p className="logs-panel-empty">Nenhum bloco selecionado — escolha acima.</p>
          )}
          {activeLogServices.map((svc) => {
            const meta = servicesMeta.find((s) => s.id === svc);
            const lines = logsByService[svc] ?? [];
            const up = serviceStatus ? Boolean(serviceStatus[svc as keyof ServiceStatusMap]) : false;
            return (
              <div key={svc} className="logs-block">
                <div className="logs-block-head">
                  <span className="logs-block-title">{meta?.label ?? svc}</span>
                  <span
                    className={`logs-status-tag ${up ? 'logs-status-tag--ok' : 'logs-status-tag--nok'}`}
                    title={`${meta?.label ?? svc} — ${up ? 'OK (Rodando)' : 'NOK (Parado)'}`}
                  >
                    {up ? 'OK' : 'NOK'}
                  </span>
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
                  {!forceService && onLogPopout && (
                    <Button
                      kind="ghost"
                      size="sm"
                      hasIconOnly
                      renderIcon={Launch}
                      iconDescription={`Abrir ${svc} em janela`}
                      tooltipPosition="left"
                      onClick={() => onLogPopout(svc)}
                    />
                  )}
                  {!forceService && (
                    <Button
                      kind="ghost"
                      size="sm"
                      hasIconOnly
                      renderIcon={Close}
                      iconDescription={`Remover logs de ${svc}`}
                      tooltipPosition="left"
                      onClick={() => removeLogService(svc)}
                    />
                  )}
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
