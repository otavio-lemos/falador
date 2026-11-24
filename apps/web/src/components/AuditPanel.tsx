// AuditPanel — aba Auditoria do Live (ADR-012).
// Recebe a trilha REAL de eventos audit do runner (via SSE) e deriva as visões:
// Decisões, Execuções, Gates, RAG, Plano e Latência. Nada fabricado.
import { useMemo, useState } from 'react';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableContainer,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
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
  return <Tag type={risk === 'seguro' ? 'green' : 'magenta'} size="sm">{risk}</Tag>;
}

function gateTag(gate?: string) {
  if (!gate) return null;
  const type = gate === 'approved' ? 'green' : gate === 'rejected' || gate === 'missing_gate' ? 'red' : gate === 'edited' ? 'cyan' : gate === 'pending' ? 'purple' : 'gray';
  return <Tag type={type} size="sm">{gate}</Tag>;
}

function matches(filter: string, ...fields: Array<string | undefined>): boolean {
  if (!filter.trim()) return true;
  const f = filter.toLowerCase();
  return fields.some((x) => (x ?? '').toLowerCase().includes(f));
}

function Empty({ label }: { label: string }) {
  return <p className="audit-empty">{label}</p>;
}

function DecisionsTable({ data, filter }: { data: AuditEvent[]; filter: string }) {
  const rows = data.filter((d) => matches(filter, d.tool, JSON.stringify(d.args ?? {}), d.risk, d.gate));
  if (rows.length === 0) return <Empty label="Nenhuma decisão registrada." />;
  return (
    <TableContainer>
      <Table size="sm">
        <TableHeader>
          <TableRow>
            <TableHead>Step</TableHead>
            <TableHead>Tool</TableHead>
            <TableHead>Args</TableHead>
            <TableHead>Risco d1</TableHead>
            <TableHead>Gate</TableHead>
            <TableHead>OK</TableHead>
            <TableHead>Duração</TableHead>
            <TableHead>Hora</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <TableRow key={`${d.runId}-${d.seq}`}>
              <TableCell>{d.step ?? '—'}</TableCell>
              <TableCell>{d.tool ?? '—'}</TableCell>
              <TableCell><CodeSnippet type="single" hideCopyButton>{truncateText(JSON.stringify(d.args ?? {}), 100)}</CodeSnippet></TableCell>
              <TableCell>{riskTag(d.risk) ?? '—'}</TableCell>
              <TableCell>{gateTag(d.gate) ?? '—'}</TableCell>
              <TableCell>{typeof d.ok === 'boolean' ? <Tag type={d.ok ? 'green' : 'red'} size="sm">{d.ok ? '✓' : '✗'}</Tag> : '—'}</TableCell>
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
  if (rows.length === 0) return <Empty label="Nenhuma execução registrada." />;
  return (
    <TableContainer>
      <Table size="sm">
        <TableHeader>
          <TableRow>
            <TableHead>Tool</TableHead>
            <TableHead>Host</TableHead>
            <TableHead>Transport</TableHead>
            <TableHead>Comando</TableHead>
            <TableHead>Exit</TableHead>
            <TableHead>Duração</TableHead>
            <TableHead>Output</TableHead>
            <TableHead>Modo</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((e) => (
            <TableRow key={`${e.runId}-${e.seq}`}>
              <TableCell>{e.tool}</TableCell>
              <TableCell>{e.host ?? 'local'}</TableCell>
              <TableCell>{e.transport ?? 'local'}</TableCell>
              <TableCell><CodeSnippet type="single" hideCopyButton>{truncateText(String(e.args?.command ?? ''), 80)}</CodeSnippet></TableCell>
              <TableCell>{e.exitCode != null ? <Tag type={e.exitCode === 0 ? 'green' : 'red'} size="sm">{e.exitCode}</Tag> : '—'}</TableCell>
              <TableCell>{fmtMs(e.durationMs)}</TableCell>
              <TableCell>
                {e.outputPreview ? (
                  <Accordion>
                    <AccordionItem title="output">
                      <CodeSnippet type="multi" hideCopyButton>{e.outputPreview}</CodeSnippet>
                    </AccordionItem>
                  </Accordion>
                ) : '—'}
              </TableCell>
              <TableCell>{e.dryRun === undefined ? '—' : <Tag type={e.dryRun ? 'cyan' : 'red'} size="sm">{e.dryRun ? 'dry-run' : 'exec ativo'}</Tag>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function GatesList({ data, filter }: { data: AuditEvent[]; filter: string }) {
  const rows = data.filter((g) => matches(filter, g.nodeId, g.tool, g.text, g.gate));
  if (rows.length === 0) return <Empty label="Nenhum gate registrado." />;
  return (
    <div className="audit-gates-list">
      {rows.map((g) => (
        <div key={`${g.runId}-${g.seq}`} className="audit-gate-field">
          <strong>{fmtTs(g.ts)} · {g.nodeId}{g.tool ? ` · ${g.tool}` : ''}</strong> {gateTag(g.gate)}
          {g.text ? <CodeSnippet type="single" hideCopyButton>{truncateText(g.text, 160)}</CodeSnippet> : null}
        </div>
      ))}
    </div>
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

function PlanView({ plan }: { plan: PlanItem[] | null }) {
  if (!plan || plan.length === 0) return <Empty label="Nenhum plano registrado (o agente cria via update_plan)." />;
  return (
    <TableContainer>
      <Table size="sm">
        <TableHeader>
          <TableRow>
            <TableHead>ID</TableHead>
            <TableHead>Item</TableHead>
            <TableHead>Verificação</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Evidência</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plan.map((p) => (
            <TableRow key={p.id}>
              <TableCell>{p.id}</TableCell>
              <TableCell>{p.description}</TableCell>
              <TableCell>{p.verification}</TableCell>
              <TableCell>
                <Tag type={p.status === 'verified' ? 'green' : p.status === 'failed' ? 'red' : 'purple'} size="sm">{p.status}</Tag>
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

function LatencyTable({ data }: { data: AuditEvent[] }) {
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
  if (rows.length === 0) return <Empty label="Nenhuma latência registrada." />;
  return (
    <TableContainer>
      <Table size="sm">
        <TableHeader>
          <TableRow>
            <TableHead>Etapa</TableHead>
            <TableHead>Amostras</TableHead>
            <TableHead>p50</TableHead>
            <TableHead>p95</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((l) => (
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

function ValidationList({ data }: { data: AuditEvent[] }) {
  if (data.length === 0) return <Empty label="Nenhuma validação de objetivo registrada." />;
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
        {data.map((v) => {
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
    () => toolCalls.filter((a) => (a.tool ?? '').startsWith('exec_') || (a.transport ?? '').startsWith('mcp') || a.transport === 'ssh'),
    [toolCalls],
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
      <Tabs selectedIndex={activeTab} onChange={({ selectedIndex }) => setActiveTab(selectedIndex ?? 0)}>
        <TabList aria-label="Auditoria do run">
          <Tab>Decisões ({toolCalls.length})</Tab>
          <Tab>Execuções ({executions.length})</Tab>
          <Tab>Gates ({gates.length})</Tab>
          <Tab>RAG ({rag.length})</Tab>
          <Tab>Plano ({plan?.length ?? 0})</Tab>
          <Tab>Validação ({validations.length})</Tab>
          <Tab>Latência</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <TableToolbar>
              <TableToolbarContent>
                <TableToolbarSearch id="audit-filter-decisions" placeholder="Filtrar decisões…" value={filter} onChange={(e) => setFilter((e as unknown as { target?: { value?: string } }).target?.value ?? '')} />
              </TableToolbarContent>
            </TableToolbar>
            <DecisionsTable data={toolCalls} filter={filter} />
          </TabPanel>
          <TabPanel>
            <TableToolbar>
              <TableToolbarContent>
                <TableToolbarSearch id="audit-filter-exec" placeholder="Filtrar execuções…" value={filter} onChange={(e) => setFilter((e as unknown as { target?: { value?: string } }).target?.value ?? '')} />
              </TableToolbarContent>
            </TableToolbar>
            <ExecutionsTable data={executions} filter={filter} />
          </TabPanel>
          <TabPanel><GatesList data={gates} filter={filter} /></TabPanel>
          <TabPanel><RagList data={rag} filter={filter} /></TabPanel>
          <TabPanel><PlanView plan={plan} /></TabPanel>
          <TabPanel><ValidationList data={validations} /></TabPanel>
          <TabPanel><LatencyTable data={audit} /></TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  );
}