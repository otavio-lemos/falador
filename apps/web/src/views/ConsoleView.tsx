// Console em janela própria: anexa ao run atual por SSE e mostra execuções + gates.
// Nunca inicia run e não depende da aba da conversa.
import { useEffect, useRef, useState } from 'react';
import { Button, Tag, TextInput, Theme } from '@carbon/react';
import { openEvents, gateAction, stopRun, type RunnerEvent } from '../api';
import type { Execution, Gate } from '../useRunner';

type StreamFilter = 'all' | 'stdout' | 'stderr';

function stamp(ts: number): string {
  try { return new Date(ts).toLocaleTimeString(); } catch { return ''; }
}

export function ConsoleView() {
  const [execs, setExecs] = useState<Execution[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<StreamFilter>('all');
  const [connected, setConnected] = useState(false);
  const [retry, setRetry] = useState(0);
  const ctlRef = useRef<AbortController | null>(null);

  // A janela é persistente: se abrir antes do run ou o run terminar, volta a anexar sozinha.
  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => setRetry((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, [connected]);

  useEffect(() => {
    const onEvent = (ev: RunnerEvent) => {
      setConnected(true);
      const ts = typeof ev.ts === 'number' ? ev.ts : Date.now();
      if (ev.type === 'exec_start') {
        const id = String(ev.id ?? '');
        if (!id) return;
        const entry: Execution = {
          id, ts, nodeId: String(ev.nodeId ?? ''), step: 0,
          tool: ev.transport === 'ssh' ? 'exec_ssh' : 'exec_local',
          host: typeof ev.host === 'string' ? ev.host : 'local',
          transport: typeof ev.transport === 'string' ? ev.transport : 'local',
          command: String(ev.command ?? ''), output: '', stdout: '', stderr: '',
          status: 'running', exitCode: null, dryRun: ev.dryRun === true,
          ...(typeof ev.bastion === 'string' && ev.bastion ? { bastion: ev.bastion } : {}),
        };
        setExecs((x) => [...x.filter((e) => e.id !== id), entry]);
      } else if (ev.type === 'exec_chunk') {
        const id = String(ev.id ?? ''); const text = typeof ev.text === 'string' ? ev.text : '';
        if (!id || !text) return;
        const stream: 'stdout' | 'stderr' = ev.stream === 'stderr' ? 'stderr' : 'stdout';
        setExecs((x) => x.map((e) => e.id === id ? {
          ...e,
          [stream]: `${e[stream]}${text}`,
          output: `${e.output}${stream === 'stderr' ? '[stderr] ' : ''}${text}`,
          chunks: [...(e.chunks ?? []), { stream, text, ts }],
        } : e));
      } else if (ev.type === 'exec_end') {
        const id = String(ev.id ?? '');
        setExecs((x) => x.map((e) => e.id === id ? {
          ...e, status: 'done',
          ...(typeof ev.exitCode === 'number' ? { exitCode: ev.exitCode } : {}),
          ...(typeof ev.ok === 'boolean' ? { ok: ev.ok } : {}),
          ...(typeof ev.durationMs === 'number' ? { durationMs: ev.durationMs } : {}),
        } : e));
      } else if (ev.type === 'execution') {
        const id = String(ev.id ?? `${ev.nodeId ?? ''}:exec:${ts}`);
        const entry: Execution = {
          id, ts, nodeId: String(ev.nodeId ?? ''), step: 0,
          tool: typeof ev.tool === 'string' ? ev.tool : 'exec.command',
          host: typeof ev.host === 'string' ? ev.host : 'local',
          transport: typeof ev.transport === 'string' ? ev.transport : 'local',
          command: String(ev.command ?? ''), output: String(ev.output ?? ''),
          stdout: '', stderr: '', status: 'done',
          exitCode: typeof ev.exitCode === 'number' ? ev.exitCode : null,
          ...(typeof ev.dryRun === 'boolean' ? { dryRun: ev.dryRun } : {}),
          ...(typeof ev.ok === 'boolean' ? { ok: ev.ok } : {}),
        };
        setExecs((x) => [...x.filter((e) => e.id !== id), entry]);
      } else if (ev.type === 'gate') {
        const meta = ev.meta && typeof ev.meta === 'object' ? ev.meta : undefined;
        const nodeId = String(ev.nodeId ?? '');
        if (!nodeId) return;
        const gate: Gate = { nodeId, text: String(ev.text ?? ''), ts, ...(meta ? { meta: meta as Gate['meta'] } : {}) };
        setGates((g) => [...g.filter((x) => x.nodeId !== nodeId), gate]);
        setDrafts((d) => ({ ...d, [nodeId]: gateCommand(gate) }));
      } else if (ev.type === 'gate_cancelled') {
        const nodeId = String(ev.nodeId ?? '');
        setGates((g) => g.filter((x) => x.nodeId !== nodeId));
      }
    };
    const ctl = openEvents(onEvent, () => setConnected(false));
    ctlRef.current = ctl;
    return () => { ctl.abort(); if (ctlRef.current === ctl) ctlRef.current = null; };
  }, [retry]);

  const anyRunning = execs.some((e) => e.status === 'running');
  const approve = async (gate: Gate, text: string | null) => {
    const answer = text && text.trim() ? text : null;
    try { await gateAction(gate.nodeId, answer); } catch { /* host sem run */ }
    setGates((g) => g.filter((x) => x.nodeId !== gate.nodeId));
    // A aba da conversa registra o mesmo histórico de aprovação sem duplicar o POST.
    const bc = new BroadcastChannel('falador-console');
    bc.postMessage({ type: 'gate_answered', nodeId: gate.nodeId, text: answer, ts: Date.now() });
    bc.close();
  };

  const visibleText = (e: Execution): string => {
    if (filter === 'all') return e.output;
    if (filter === 'stdout') return (e.chunks ?? []).length ? (e.chunks ?? []).filter((c) => c.stream === 'stdout').map((c) => c.text).join('') : e.stdout;
    return (e.chunks ?? []).length ? (e.chunks ?? []).filter((c) => c.stream === 'stderr').map((c) => c.text).join('') : e.stderr;
  };

  return (
    <Theme theme="g100">
      <div className="console-view">
        <header className="console-head">
          <h1>Console do Agente</h1>
          <div className="console-head-status">
            <Tag type={connected ? 'green' : 'gray'} size="sm">{connected ? 'Conectado ao run' : 'Sem run em andamento'}</Tag>
            {anyRunning && <Button kind="danger--tertiary" size="sm" onClick={() => void stopRun()}>Cancelar</Button>}
            <Button kind="tertiary" size="sm" onClick={() => setRetry((n) => n + 1)}>Reconectar</Button>
          </div>
        </header>
        {!connected && <p className="console-empty">Inicie um fluxo na aba principal. Esta janela acompanha o mesmo run.</p>}

        {gates.map((g) => (
          <section className="console-card console-gate" key={g.nodeId} aria-label={`Aprovação pendente ${g.nodeId}`}>
            <div className="console-card-head">
              <h2>Aprovar e executar</h2>
              <Tag type="cyan" size="sm">{g.nodeId}</Tag>
            </div>
            <pre className="console-plain">{g.text}</pre>
            <TextInput
              id={`console-gate-${g.nodeId}`}
              labelText="Comando / resposta (editável)"
              value={drafts[g.nodeId] ?? gateCommand(g)}
              onChange={(e) => setDrafts((d) => ({ ...d, [g.nodeId]: e.target.value }))}
            />
            <div className="console-actions">
              <Button kind="primary" size="sm" onClick={() => void approve(g, drafts[g.nodeId] ?? gateCommand(g))}>Aprovar e executar</Button>
              <Button kind="danger--tertiary" size="sm" onClick={() => void approve(g, null)}>Negar</Button>
            </div>
          </section>
        ))}

        <div className="console-card-head console-list-head">
          <h2>Execuções</h2>
          <div className="console-filters" role="group" aria-label="Filtrar saída">
            {(['all', 'stdout', 'stderr'] as const).map((f) => (
              <Button key={f} kind={filter === f ? 'secondary' : 'ghost'} size="sm" onClick={() => setFilter(f)}>{f}</Button>
            ))}
          </div>
        </div>
        {execs.length === 0 && <p className="console-empty">Nenhum comando executado neste run.</p>}
        {execs.map((e) => (
          <section className="console-card" key={e.id} aria-label={`Execução ${e.command}`}>
            <div className="console-card-head">
              <Tag type={e.dryRun ? 'blue' : 'red'} size="sm">{e.dryRun ? 'DRY-RUN' : 'EXEC ATIVO'}</Tag>
              <Tag type="gray" size="sm">{e.tool} · {e.host}</Tag>
              {e.bastion && <Tag type="purple" size="sm">Bastion: {e.bastion}</Tag>}
              <Tag type={e.status === 'running' ? 'cyan' : e.exitCode === 0 || e.dryRun ? 'green' : 'red'} size="sm">
                {e.status === 'running' ? 'executando' : `saída ${e.exitCode ?? '—'}`}
              </Tag>
              <span className="console-time">{stamp(e.ts)}</span>
            </div>
            <code className="console-command">{e.command}</code>
            <pre className="console-output">{visibleText(e) || '(sem saída)'}</pre>
          </section>
        ))}
      </div>
    </Theme>
  );
}

function gateCommand(gate: Gate): string {
  const meta = gate.meta as { command?: unknown } | undefined;
  if (meta && typeof meta.command === 'string') return meta.command;
  return gate.text;
}
