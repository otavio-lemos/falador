// AuditPanel — aba Auditoria do Live (ADR-012).
// Recebe a trilha REAL de eventos audit do runner (via SSE) e deriva as visões:
// Decisões, Execuções, Gates, RAG, Plano e Latência. Nada fabricado.
import { Fragment, useMemo, useState } from 'react';
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
  TableContainer,
  TableExpandRow,
  TableExpandedRow,
  Search,
  Tabs,
  TabList,
  Tab,
  TabPanels,
  TabPanel,
  Accordion,
  AccordionItem,
  Tag,
  CodeSnippet,
  StructuredListWrapper,
  StructuredListHead,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
  preview__IconIndicator as IconIndicator,
} from '@carbon/react';
import type { AuditEvent, PlanItem } from '../useRunner';

function fmtMs(ms?: number): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function fmtTs(ts: number): string {
  return new Date(ts).toLocaleTimeString();
}

function truncateText(text: string, max = 120): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

function riskTag(risk?: string) {
  if (!risk) return null;
  const isSafe = risk.toLowerCase().includes('segur');
  return <IconIndicator kind={isSafe ? 'succeeded' : 'failed'} label={risk} size={16} />;
}

function gateTag(gate?: string) {
  if (!gate) return null;
  const kind =
    gate === 'approved'
      ? 'succeeded'
      : gate === 'rejected' || gate === 'missing_gate'
      ? 'failed'
      : gate === 'pending'
      ? 'pending'
      : gate === 'edited'
      ? 'in-progress'
      : 'informative';
  return <IconIndicator kind={kind} label={gate} size={16} />;
}

function matches(filter: string, ...fields: Array<string | undefined>): boolean {
  if (!filter.trim()) return true;
  const f = filter.toLowerCase();
  return fields.some((x) => (x ?? '').toLowerCase().includes(f));
}

function Empty({ label }: { label: string }) {
  return <p className="audit-empty">{label}</p>;
}

const OP_TAG_TYPES = {
  run_started: 'green',
  run_stopped: 'gray',
  chat_input: 'blue',
  tool_call: 'purple',
  exec: 'cyan',
  gate: 'magenta',
  plan: 'teal',
  goal_validation: 'warm-gray',
  agent_final: 'high-contrast',
} as const;

function opTag(op: string) {
  const type = OP_TAG_TYPES[op as keyof typeof OP_TAG_TYPES] ?? 'cool-gray';
  return <Tag type={type} size="sm">{op}</Tag>;
}

function summarizeEvent(ev: AuditEvent): string {
  switch (ev.op) {
    case 'run_started':
      return 'Execução iniciada';
    case 'run_stopped':
      return ev.reason || 'Execução encerrada';
    case 'chat_input':
      return ev.text || '—';
    case 'tool_call':
    case 'exec': {
      const cmd = ev.args && typeof ev.args.command === 'string' ? ev.args.command : '';
      if (cmd) return ev.tool ? `${ev.tool}: ${cmd}` : cmd;
      const argsStr = ev.args && Object.keys(ev.args).length > 0 ? JSON.stringify(ev.args) : '';
      if (ev.tool && argsStr) return `${ev.tool} ${argsStr}`;
      return ev.tool || ev.text || '—';
    }
    case 'gate':
      return [ev.tool, ev.gate, ev.text].filter(Boolean).join(' · ') || '—';
    case 'plan':
      return `${ev.plan?.length ?? 0} itens`;
    case 'goal_validation':
      return ev.validation?.achieved ? 'Atingido' : 'Pendente';
    case 'agent_final':
      return ev.text || 'Finalizado';
    default:
      return ev.text || ev.reason || ev.tool || '—';
  }
}

function eventStatus(ev: AuditEvent) {
  if (ev.op === 'gate' && ev.gate) return gateTag(ev.gate);
  if (ev.op === 'goal_validation') {
    const achieved = Boolean(ev.validation?.achieved);
    return <IconIndicator kind={achieved ? 'succeeded' : 'caution-major'} label={achieved ? 'Atingido' : 'Pendente'} size={16} />;
  }
  if (ev.op === 'agent_final') {
    const kind = ev.goalAchieved ? 'succeeded' : ev.maxStepsReached ? 'failed' : 'informative';
    const label = ev.goalAchieved ? 'Concluído' : ev.maxStepsReached ? 'Limite de passos' : 'Encerrado';
    return <IconIndicator kind={kind} label={label} size={16} />;
  }
  if (typeof ev.ok === 'boolean') {
    return <IconIndicator kind={ev.ok ? 'succeeded' : 'failed'} label={ev.ok ? 'ok' : 'falha'} size={16} />;
  }
  if (typeof ev.exitCode === 'number') {
    return <IconIndicator kind={ev.exitCode === 0 ? 'succeeded' : 'failed'} label={`exit ${ev.exitCode}`} size={16} />;
  }
  if (ev.risk) return riskTag(ev.risk);
  return '—';
}

function AllEventsTable({ data, filter }: { data: AuditEvent[]; filter: string }) {
  const rows = data.filter((a) =>
    matches(
      filter,
      a.op,
      a.nodeId,
      a.tool,
      a.text,
      a.reason,
      a.gate,
      a.risk,
      a.host,
      a.args ? JSON.stringify(a.args) : undefined,
    ),
  );
  if (rows.length === 0) return <Empty label="Nenhum evento registrado." />;
  return (
    <TableContainer>
      <Table size="sm">
        <TableHead>
          <TableRow>
            <TableHeader>Hora</TableHeader>
            <TableHeader>Evento</TableHeader>
            <TableHeader>Nó</TableHeader>
            <TableHeader>Resumo / Detalhes</TableHeader>
            <TableHeader>Status</TableHeader>
            <TableHeader>Duração</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((ev) => (
            <TableRow key={`${ev.runId}-${ev.seq}`}>
              <TableCell>{fmtTs(ev.ts)}</TableCell>
              <TableCell>{opTag(ev.op)}</TableCell>
              <TableCell>{ev.nodeId || '—'}</TableCell>
              <TableCell>{truncateText(summarizeEvent(ev), 160)}</TableCell>
              <TableCell>{eventStatus(ev)}</TableCell>
              <TableCell>{fmtMs(ev.durationMs)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function DecisionsTable({ data, filter }: { data: AuditEvent[]; filter: string }) {
  const rows = data.filter((d) => matches(filter, d.tool, JSON.stringify(d.args ?? {}), d.risk, d.gate));
  if (rows.length === 0) return <Empty label="Nenhuma decisão registrada." />;
  return (
    <TableContainer>
      <Table size="sm">
        <TableHead>
          <TableRow>
            <TableHeader>Step</TableHeader>
            <TableHeader>Tool</TableHeader>
            <TableHeader>Args</TableHeader>
            <TableHeader>Risco d1</TableHeader>
            <TableHeader>Gate</TableHeader>
            <TableHeader>OK</TableHeader>
            <TableHeader>Duração</TableHeader>
            <TableHeader>Hora</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((d) => (
            <TableRow key={`${d.runId}-${d.seq}`}>
              <TableCell>{d.step ?? '—'}</TableCell>
              <TableCell>{d.tool ?? '—'}</TableCell>
              <TableCell><CodeSnippet type="single" hideCopyButton>{truncateText(JSON.stringify(d.args ?? {}), 100)}</CodeSnippet></TableCell>
              <TableCell>{riskTag(d.risk) ?? '—'}</TableCell>
              <TableCell>{gateTag(d.gate) ?? '—'}</TableCell>
              <TableCell>{typeof d.ok === 'boolean' ? <IconIndicator kind={d.ok ? 'succeeded' : 'failed'} label={d.ok ? 'ok' : 'falha'} size={16} /> : '—'}</TableCell>
              <TableCell>{fmtMs(d.durationMs)}</TableCell>
              <TableCell>{fmtTs(d.ts)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ExecutionsTable({ data, filter }: { data: AuditEvent[]; filter: string }) {
  const rows = data.filter((e) => matches(filter, e.tool, e.host, String(e.args?.command ?? ''), e.outputPreview));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (rows.length === 0) return <Empty label="Nenhuma execução registrada." />;

  const toggle = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <TableContainer>
      <Table size="sm">
        <TableHead>
          <TableRow>
            <TableHeader style={{ width: '2.5rem' }} />
            <TableHeader>Tool</TableHeader>
            <TableHeader>Host</TableHeader>
            <TableHeader>Transport</TableHeader>
            <TableHeader>Comando</TableHeader>
            <TableHeader>Exit</TableHeader>
            <TableHeader>Duração</TableHeader>
            <TableHeader>Modo</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((e) => {
            const rowId = `${e.runId}-${e.seq}`;
            const isExp = Boolean(expanded[rowId]);
            return (
              <Fragment key={rowId}>
                <TableExpandRow
                  isExpanded={isExp}
                  onExpand={() => toggle(rowId)}
                  expandIconDescription={isExp ? 'Recolher saída' : 'Expandir saída'}
                  aria-label={`Execução ${e.tool} em ${e.host ?? 'local'}`}
                >
                  <TableCell>{e.tool}</TableCell>
                  <TableCell>{e.host ?? 'local'}</TableCell>
                  <TableCell>{e.transport ?? 'local'}</TableCell>
                  <TableCell><CodeSnippet type="single" hideCopyButton>{truncateText(String(e.args?.command ?? ''), 80)}</CodeSnippet></TableCell>
                  <TableCell>{e.exitCode != null ? <IconIndicator kind={e.exitCode === 0 ? 'succeeded' : 'failed'} label={String(e.exitCode)} size={16} /> : '—'}</TableCell>
                  <TableCell>{fmtMs(e.durationMs)}</TableCell>
                  <TableCell>{e.dryRun === undefined ? '—' : <Tag type={e.dryRun ? 'cyan' : 'red'} size="sm">{e.dryRun ? 'dry-run' : 'exec ativo'}</Tag>}</TableCell>
                </TableExpandRow>
                <TableExpandedRow colSpan={8}>
                  {e.outputPreview ? (
                    <div style={{ padding: '0.5rem 0' }}>
                      <CodeSnippet type="multi" hideCopyButton>{e.outputPreview}</CodeSnippet>
                    </div>
                  ) : (
                    <p style={{ margin: 0, color: 'var(--cds-text-secondary)' }}>Sem saída registrada.</p>
                  )}
                </TableExpandedRow>
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function GatesList({ data, filter }: { data: AuditEvent[]; filter: string }) {
  const rows = data.filter((g) => matches(filter, g.nodeId, g.tool, g.text, g.gate));
  if (rows.length === 0) return <Empty label="Nenhum gate registrado." />;
  return (
    <StructuredListWrapper isCondensed aria-label="Lista de gates auditados">
      <StructuredListHead>
        <StructuredListRow head>
          <StructuredListCell head>Hora</StructuredListCell>
          <StructuredListCell head>Nó / Tool</StructuredListCell>
          <StructuredListCell head>Status</StructuredListCell>
          <StructuredListCell head>Detalhes</StructuredListCell>
        </StructuredListRow>
      </StructuredListHead>
      <StructuredListBody>
        {rows.map((g) => (
          <StructuredListRow key={`${g.runId}-${g.seq}`}>
            <StructuredListCell noWrap>{fmtTs(g.ts)}</StructuredListCell>
            <StructuredListCell noWrap>
              <strong>{g.nodeId}</strong>{g.tool ? ` · ${g.tool}` : ''}
            </StructuredListCell>
            <StructuredListCell>{gateTag(g.gate)}</StructuredListCell>
            <StructuredListCell>
              {g.text ? <CodeSnippet type="single" hideCopyButton>{truncateText(g.text, 160)}</CodeSnippet> : '—'}
            </StructuredListCell>
          </StructuredListRow>
        ))}
      </StructuredListBody>
    </StructuredListWrapper>
  );
}

function RagList({ data, filter }: { data: AuditEvent[]; filter: string }) {
  const rows = data.filter((r) => matches(filter, r.rag?.query, r.outputPreview));
  if (rows.length === 0) return <Empty label="Nenhuma consulta RAG registrada." />;
  return (
    <div className="audit-rag-list">
      {rows.map((r) => (
        <Accordion key={`${r.runId}-${r.seq}`}>
          <AccordionItem title={`${truncateText(r.rag?.query ?? '', 80)} — ${r.rag?.hits ?? 0} hits — ${fmtTs(r.ts)}`}>
            <div className="audit-rag-field">
              <strong>Chunk IDs:</strong> {r.rag?.chunkIds?.join(', ') || '—'}
            </div>
            {r.outputPreview && (
              <div className="audit-rag-field">
                <CodeSnippet type="multi" hideCopyButton>{r.outputPreview}</CodeSnippet>
              </div>
            )}
          </AccordionItem>
        </Accordion>
      ))}
    </div>
  );
}

function PlanView({ plan, filter }: { plan: PlanItem[] | null; filter: string }) {
  const rows = (plan ?? []).filter((p) => matches(filter, p.id, p.description, p.verification, p.status, p.evidence));
  if (rows.length === 0) return <Empty label="Nenhum plano registrado (o agente cria via update_plan)." />;
  return (
    <TableContainer>
      <Table size="sm">
        <TableHead>
          <TableRow>
            <TableHeader>ID</TableHeader>
            <TableHeader>Item</TableHeader>
            <TableHeader>Verificação</TableHeader>
            <TableHeader>Status</TableHeader>
            <TableHeader>Evidência</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((p) => (
            <TableRow key={p.id}>
              <TableCell>{p.id}</TableCell>
              <TableCell>{p.description}</TableCell>
              <TableCell>{p.verification}</TableCell>
              <TableCell>
                <IconIndicator
                  kind={p.status === 'verified' ? 'succeeded' : p.status === 'failed' ? 'failed' : 'in-progress'}
                  label={p.status}
                  size={16}
                />
              </TableCell>
              <TableCell>{p.evidence ? truncateText(p.evidence, 100) : '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function percentile(sorted: number[], pct: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

function LatencyTable({ data, filter }: { data: AuditEvent[]; filter: string }) {
  const rows = useMemo(() => {
    const byTool = new Map<string, number[]>();
    for (const ev of data) {
      if (typeof ev.durationMs !== 'number') continue;
      const key = ev.op === 'goal_validation' ? 'goal.validator (LLM)' : (ev.tool ?? ev.op);
      const arr = byTool.get(key) ?? [];
      arr.push(ev.durationMs);
      byTool.set(key, arr);
    }
    return [...byTool.entries()].map(([stage, arr]) => {
      const s = [...arr].sort((a, b) => a - b);
      return { stage, samples: s.length, p50: percentile(s, 50), p95: percentile(s, 95) };
    });
  }, [data]);
  const visible = rows.filter((r) => matches(filter, r.stage));
  if (visible.length === 0) return <Empty label="Nenhuma latência registrada." />;
  return (
    <TableContainer>
      <Table size="sm">
        <TableHead>
          <TableRow>
            <TableHeader>Etapa</TableHeader>
            <TableHeader>Amostras</TableHeader>
            <TableHeader>p50</TableHeader>
            <TableHeader>p95</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {visible.map((l) => (
            <TableRow key={l.stage}>
              <TableCell><strong>{l.stage}</strong></TableCell>
              <TableCell>{l.samples}</TableCell>
              <TableCell>{fmtMs(l.p50 ?? undefined)}</TableCell>
              <TableCell>{fmtMs(l.p95 ?? undefined)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function ValidationList({ data, filter }: { data: AuditEvent[]; filter: string }) {
  const rows = data.filter((v) => v.op === 'goal_validation'
    ? matches(filter, v.validation?.gaps?.join(' '), v.validation?.nextActions?.join(' '), String(v.validation?.confidence ?? ''), v.validation?.achieved ? 'atingido' : 'pendente')
    : matches(filter, v.text, v.goalAchieved ? 'concluído' : ''));
  if (rows.length === 0) return <Empty label="Nenhuma validação de objetivo registrada." />;
  return (
    <StructuredListWrapper isCondensed aria-label="Validações de objetivo">
      <StructuredListHead>
        <StructuredListRow head>
          <StructuredListCell head>Hora</StructuredListCell>
          <StructuredListCell head>Tipo</StructuredListCell>
          <StructuredListCell head>Status</StructuredListCell>
          <StructuredListCell head>Confiança</StructuredListCell>
          <StructuredListCell head>Lacunas / Detalhes</StructuredListCell>
          <StructuredListCell head>Próximas ações</StructuredListCell>
        </StructuredListRow>
      </StructuredListHead>
      <StructuredListBody>
        {rows.map((v) => {
          if (v.op === 'goal_validation') {
            const achieved = Boolean(v.validation?.achieved);
            const confidence = v.validation ? `${Math.round(v.validation.confidence * 100)}%` : '—';
            const gaps = v.validation?.gaps?.length ? v.validation.gaps.join('; ') : '—';
            const nextActions = v.validation?.nextActions?.length ? v.validation.nextActions.join('; ') : '—';
            return (
              <StructuredListRow key={`${v.runId}-${v.seq}`}>
                <StructuredListCell noWrap>{fmtTs(v.ts)}</StructuredListCell>
                <StructuredListCell noWrap>{`Validação${v.step != null ? ` (passo ${v.step})` : ''}`}</StructuredListCell>
                <StructuredListCell noWrap>
                  <IconIndicator kind={achieved ? 'succeeded' : 'caution-major'} label={achieved ? 'Atingido' : 'Pendente'} />
                </StructuredListCell>
                <StructuredListCell noWrap>{confidence}</StructuredListCell>
                <StructuredListCell>{gaps}</StructuredListCell>
                <StructuredListCell>{nextActions}</StructuredListCell>
              </StructuredListRow>
            );
          }
          const kind = v.goalAchieved ? 'succeeded' : v.maxStepsReached ? 'failed' : 'informative';
          const label = v.goalAchieved ? 'Concluído' : v.maxStepsReached ? 'Limite de passos' : 'Encerrado';
          return (
            <StructuredListRow key={`${v.runId}-${v.seq}`}>
              <StructuredListCell noWrap>{fmtTs(v.ts)}</StructuredListCell>
              <StructuredListCell noWrap>{`Final${v.step != null ? ` (passo ${v.step})` : ''}`}</StructuredListCell>
              <StructuredListCell noWrap>
                <IconIndicator kind={kind} label={label} />
              </StructuredListCell>
              <StructuredListCell noWrap>—</StructuredListCell>
              <StructuredListCell>{v.text ? truncateText(v.text, 140) : '—'}</StructuredListCell>
              <StructuredListCell>—</StructuredListCell>
            </StructuredListRow>
          );
        })}
      </StructuredListBody>
    </StructuredListWrapper>
  );
}

interface AuditPanelProps {
  audit: AuditEvent[];
}

export function AuditPanel({ audit }: AuditPanelProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [filter, setFilter] = useState('');

  const toolCalls = useMemo(() => audit.filter((a) => a.op === 'tool_call'), [audit]);
  const executions = useMemo(
    () => audit.filter((a) =>
      a.op === 'exec' ||
      (a.op === 'tool_call' && ((a.tool ?? '').startsWith('exec_') || (a.transport ?? '').startsWith('mcp') || a.transport === 'ssh')),
    ),
    [audit],
  );
  const gates = useMemo(() => audit.filter((a) => a.op === 'gate'), [audit]);
  const rag = useMemo(() => toolCalls.filter((a) => a.rag), [toolCalls]);
  const plan = useMemo(() => {
    const planEvents = audit.filter((a) => a.op === 'plan' && a.plan);
    return planEvents.length > 0 ? planEvents[planEvents.length - 1].plan ?? null : null;
  }, [audit]);
  const validations = useMemo(
    () => audit.filter((a) => a.op === 'goal_validation' || a.op === 'agent_final'),
    [audit],
  );

  return (
    <div className="audit-panel">
      <div className="audit-bar">
        <Tabs selectedIndex={activeTab} onChange={({ selectedIndex }) => setActiveTab(selectedIndex ?? 0)}>
          <TabList aria-label="Auditoria do run">
            <Tab>Todos ({audit.length})</Tab>
            <Tab>Decisões ({toolCalls.length})</Tab>
            <Tab>Execuções ({executions.length})</Tab>
            <Tab>Gates ({gates.length})</Tab>
            <Tab>RAG ({rag.length})</Tab>
            <Tab>Plano ({plan?.length ?? 0})</Tab>
            <Tab>Validação ({validations.length})</Tab>
            <Tab>Latência</Tab>
          </TabList>
          <TabPanels>
            <TabPanel><AllEventsTable data={audit} filter={filter} /></TabPanel>
            <TabPanel><DecisionsTable data={toolCalls} filter={filter} /></TabPanel>
            <TabPanel><ExecutionsTable data={executions} filter={filter} /></TabPanel>
            <TabPanel><GatesList data={gates} filter={filter} /></TabPanel>
            <TabPanel><RagList data={rag} filter={filter} /></TabPanel>
            <TabPanel><PlanView plan={plan} filter={filter} /></TabPanel>
            <TabPanel><ValidationList data={validations} filter={filter} /></TabPanel>
            <TabPanel><LatencyTable data={audit} filter={filter} /></TabPanel>
          </TabPanels>
        </Tabs>
        {/* Busca única na mesma faixa das 8 sub-abas: substitui as 3 TableToolbar
            de 48px que existiam por aba e passa a valer em TODAS as visões. */}
        <div className="audit-search">
          <Search
            id="audit-filter-decisions"
            size="sm"
            labelText="Filtrar eventos de auditoria"
            placeholder="Filtrar eventos..."
            closeButtonLabelText="Limpar filtro"
            value={filter}
            onChange={(e) => setFilter((e as unknown as { target?: { value?: string } }).target?.value ?? '')}
          />
        </div>
      </div>
    </div>
  );
}