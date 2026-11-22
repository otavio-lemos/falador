// Estado de execução compartilhado entre Builder (Testar Fluxo) e Live.
import { useRef, useState } from 'react';
import { openRun, stopRun, gateAction, sendChatInput, type Flow, type RunnerEvent, type RunSnapshot } from './api';

export interface TraceMeta {
  turnId?: string;
  tCaptureMs?: number;
  tAsrFirstMs?: number;
  tAsrFinalMs?: number;
  tTurnMs?: number;
  tLlmTtftMs?: number;
  tLlmFinalMs?: number;
  tDecisionMs?: number;
  tExecStartMs?: number;
  tExecEndMs?: number;
  exitCode?: number;
}

export interface LatencyBreakdown {
  asrMs?: number;
  turnMs?: number;
  llmTtftMs?: number;
  decisionMs?: number;
  totalMs?: number;
}

export interface GateMeta {
  tool?: string;
  decision?: string;
  host?: string;
  command?: string;
  reason?: string;
  args?: Record<string, unknown>;
  step?: number;
  trace?: TraceMeta;
}

export interface AgentStep {
  nodeId: string;
  ts: number;
  step: number;
  phase: 'calling' | 'rejected' | 'result' | 'repeated';
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  durationMs?: number;
  dryRun?: boolean;
}

export interface Execution {
  id: string;
  ts: number;
  nodeId: string;
  step: number;
  tool: string;
  host: string;
  transport: string;
  command: string;
  output: string;
  exitCode: number | null;
  durationMs?: number;
  dryRun?: boolean;
  ok?: boolean;
  truncated?: boolean;
}

export interface Thought {
  nodeId: string;
  thoughtId: string;
  text: string;
  final: boolean;
  ts: number;
}

export interface Caption {
  nodeId: string;
  kind?: 'stt';
  text: string;
  final: boolean;
  ts: number;
  trace?: TraceMeta;
}

export interface Gate {
  nodeId: string;
  text: string;
  meta?: GateMeta;
}

function computeBreakdown(trace: TraceMeta): LatencyBreakdown {
  const out: LatencyBreakdown = {};
  if (typeof trace.tAsrFinalMs === 'number' && typeof trace.tAsrFirstMs === 'number') {
    out.asrMs = Math.max(0, Math.round(trace.tAsrFinalMs - trace.tAsrFirstMs));
  }
  if (typeof trace.tTurnMs === 'number' && typeof trace.tAsrFinalMs === 'number') {
    out.turnMs = Math.max(0, Math.round(trace.tTurnMs - trace.tAsrFinalMs));
  }
  const baseLlm = typeof trace.tTurnMs === 'number' ? trace.tTurnMs : trace.tAsrFinalMs;
  if (typeof trace.tLlmTtftMs === 'number' && typeof baseLlm === 'number') {
    out.llmTtftMs = Math.max(0, Math.round(trace.tLlmTtftMs - baseLlm));
  }
  if (typeof trace.tDecisionMs === 'number' && typeof trace.tLlmFinalMs === 'number') {
    out.decisionMs = Math.max(0, Math.round(trace.tDecisionMs - trace.tLlmFinalMs));
  }
  const endTotal = typeof trace.tDecisionMs === 'number' ? trace.tDecisionMs : trace.tLlmTtftMs;
  if (typeof endTotal === 'number' && typeof trace.tAsrFinalMs === 'number') {
    out.totalMs = Math.max(0, Math.round(endTotal - trace.tAsrFinalMs));
  }
  return out;
}

export function useRunner() {
  const [running, setRunning] = useState(false);
  const [metrics, setMetrics] = useState<RunSnapshot>({});
  const [events, setEvents] = useState<RunnerEvent[]>([]);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [chatMessages, setChatMessages] = useState<{ nodeId: string; text: string; ts: number }[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [latencyBreakdown, setLatencyBreakdown] = useState<LatencyBreakdown | null>(null);
  const [lastRunError, setLastRunError] = useState<string | null>(null);
  const [collectResults, setCollectResults] = useState<Record<string, unknown[]>>({});
  const ctlRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);

  const extractNodesSnapshot = (raw: unknown): RunSnapshot => {
    if (!raw || typeof raw !== 'object') return {};
    const obj = raw as Record<string, unknown>;
    if (obj.nodes && typeof obj.nodes === 'object') return obj.nodes as RunSnapshot;
    return obj as RunSnapshot;
  };

  const applyMetrics = (raw: unknown) => {
    const snap = extractNodesSnapshot(raw);
    setMetrics(snap);
    let ttft: number | null = null;
    for (const m of Object.values(snap)) {
      if (!m || typeof m !== 'object') continue;
      for (const [k, t] of Object.entries(m.timers ?? {})) {
        if (k.includes('ttft')) ttft = t.lastMs;
      }
    }
    if (ttft != null) setLatency((cur) => cur ?? ttft);
  };

  const clearState = () => {
    setRunning(false);
    setLastRunError(null);
    setMetrics({});
    setEvents([]);
    setCaptions([]);
    setGates([]);
    setAgentSteps([]);
    setExecutions([]);
    setThoughts([]);
    setChatMessages([]);
    setCollectResults({});
    setLatency(null);
    setLatencyBreakdown(null);
  };

  const start = (flow: Flow, flowName?: string) => {
    // Run único no host: serializa stopRun() + guarda de geração antes de abrir outro,
    // evitando 409 e impedindo que um stop atrasado mate o run recém-aberto.
    const myGen = ++genRef.current;
    ctlRef.current?.abort();
    ctlRef.current = null;

    clearState();
    setRunning(true);

    void (async () => {
      try { await stopRun(); } catch { /* host pode estar offline; openRun reportará */ }
      if (genRef.current !== myGen) return;

      let myCtl: AbortController;
      myCtl = openRun(
        flow,
        (ev) => {
          if (genRef.current !== myGen) return;
          setEvents((e) => [...e.slice(-400), { ...ev, _uiTs: Date.now() }]);
          if (ev.type === 'flow_invalid') {
            setLastRunError(String(ev.error ?? 'Workflow inválido'));
          } else if (ev.type === 'runner_stderr' && typeof ev.line === 'string' && ev.line.trim()) {
            setLastRunError((cur) => cur ?? String(ev.line).trim());
          } else if (ev.type === 'metrics') {
            applyMetrics(ev.snapshot);
          } else if (ev.type === 'summary') {
            const sum = ev.summary as { metrics?: unknown } | undefined;
            applyMetrics(sum?.metrics ?? ev.metrics);
            if (ev.results && typeof ev.results === 'object') {
              setCollectResults(ev.results as Record<string, unknown[]>);
            }
          } else if (ev.type === 'caption') {
            const trace = ev.trace && typeof ev.trace === 'object' ? (ev.trace as TraceMeta) : undefined;
            setCaptions((c) => [
              ...c.slice(-120),
              { nodeId: String(ev.nodeId), text: String(ev.text ?? ''), final: !!ev.final, ts: Date.now(), ...(ev.kind === 'stt' ? { kind: 'stt' as const } : {}), ...(trace ? { trace } : {}) },
            ]);
            if (trace) {
              const bd = computeBreakdown(trace);
              if (Object.keys(bd).length > 0) {
                setLatencyBreakdown(bd);
                if (bd.totalMs != null) setLatency(bd.totalMs);
                else if (bd.llmTtftMs != null) setLatency(bd.llmTtftMs);
              }
            }
          } else if (ev.type === 'gate') {
            const meta = ev.meta && typeof ev.meta === 'object' ? (ev.meta as GateMeta) : undefined;
            setGates((g) => [
              ...g.filter((x) => x.nodeId !== ev.nodeId),
              { nodeId: String(ev.nodeId), text: String(ev.text ?? ''), ...(meta ? { meta } : {}) },
            ]);
          } else if (ev.type === 'gate_cancelled') {
            setGates((g) => g.filter((x) => x.nodeId !== ev.nodeId));
          } else if (ev.type === 'thought') {
            const nodeId = String(ev.nodeId ?? '');
            const thoughtId = String(ev.thoughtId ?? nodeId);
            const text = String(ev.text ?? '');
            const final = !!ev.final;
            if (!text) return;
            setThoughts((t) => {
              const idx = t.findIndex((x) => x.thoughtId === thoughtId);
              if (idx >= 0) {
                const next = [...t];
                next[idx] = { ...next[idx], text, final };
                return next;
              }
              return [...t.slice(-99), { nodeId, thoughtId, text, final, ts: Date.now() }];
            });
          } else if (ev.type === 'agent_step') {
            const phaseRaw = String(ev.phase ?? 'calling');
            const phase: AgentStep['phase'] =
              phaseRaw === 'rejected' || phaseRaw === 'result' || phaseRaw === 'repeated'
                ? phaseRaw
                : 'calling';
            setAgentSteps((s) => [
              ...s.slice(-100),
              {
                nodeId: String(ev.nodeId ?? ''),
                ts: Date.now(),
                step: typeof ev.step === 'number' ? ev.step : 0,
                phase,
                tool: String(ev.tool ?? ''),
                ...(ev.args && typeof ev.args === 'object' ? { args: ev.args as Record<string, unknown> } : {}),
                ...(typeof ev.ok === 'boolean' ? { ok: ev.ok } : {}),
                ...(typeof ev.durationMs === 'number' ? { durationMs: ev.durationMs } : {}),
                ...(typeof ev.dryRun === 'boolean' ? { dryRun: ev.dryRun } : {}),
              },
            ]);
            const isExecTool =
              String(ev.tool ?? '').startsWith('exec_') ||
              (typeof ev.transport === 'string' && String(ev.transport).startsWith('mcp'));
            if (phase === 'result' && isExecTool) {
              const cmd =
                ev.args && typeof ev.args === 'object' && typeof (ev.args as Record<string, unknown>).command === 'string'
                  ? String((ev.args as Record<string, unknown>).command)
                  : '';
              setExecutions((x) => [
                ...x.slice(-99),
                {
                  id: `${String(ev.nodeId ?? '')}:${typeof ev.step === 'number' ? ev.step : 0}`,
                  ts: Date.now(),
                  nodeId: String(ev.nodeId ?? ''),
                  step: typeof ev.step === 'number' ? ev.step : 0,
                  tool: String(ev.tool ?? ''),
                  host: typeof ev.host === 'string' ? ev.host : 'local',
                  transport: typeof ev.transport === 'string' ? ev.transport : 'local',
                  command: cmd,
                  output: typeof ev.output === 'string' ? ev.output : '',
                  exitCode: typeof ev.exitCode === 'number' ? ev.exitCode : null,
                  ...(typeof ev.durationMs === 'number' ? { durationMs: ev.durationMs } : {}),
                  ...(typeof ev.dryRun === 'boolean' ? { dryRun: ev.dryRun } : {}),
                  ...(typeof ev.ok === 'boolean' ? { ok: ev.ok } : {}),
                  ...(typeof ev.truncated === 'boolean' ? { truncated: ev.truncated } : {}),
                },
              ]);
            }
          } else if (ev.type === 'execution') {
            const nodeId = String(ev.nodeId ?? '');
            const ts = typeof ev.ts === 'number' ? ev.ts : Date.now();
            setExecutions((x) => [
              ...x.slice(-99),
              {
                id: String(ev.id ?? `${nodeId}:exec:${ts}:${x.length}`),
                ts,
                nodeId,
                step: typeof ev.step === 'number' ? ev.step : 0,
                tool: String(ev.tool ?? 'exec.command'),
                host: typeof ev.host === 'string' ? ev.host : 'local',
                transport: typeof ev.transport === 'string' ? ev.transport : 'local',
                command: String(ev.command ?? ''),
                output: typeof ev.output === 'string' ? ev.output : '',
                exitCode: typeof ev.exitCode === 'number' ? ev.exitCode : null,
                ...(typeof ev.durationMs === 'number' ? { durationMs: ev.durationMs } : {}),
                ...(typeof ev.dryRun === 'boolean' ? { dryRun: ev.dryRun } : {}),
                ...(typeof ev.ok === 'boolean' ? { ok: ev.ok } : {}),
                ...(typeof ev.truncated === 'boolean' ? { truncated: ev.truncated } : {}),
              },
            ]);
          } else if (ev.type === 'chat_sent') {
            setChatMessages((m) => [
              ...m.slice(-100),
              { nodeId: String(ev.nodeId ?? ''), text: String(ev.text ?? ''), ts: Date.now() },
            ]);
          }
        },
        () => { if (genRef.current === myGen && ctlRef.current === myCtl) setRunning(false); },
        undefined,
        flowName,
        (msg) => { if (genRef.current === myGen && ctlRef.current === myCtl) setLastRunError(msg); },
      );
      ctlRef.current = myCtl;
    })();
  };
  const stop = () => {
    genRef.current += 1;
    ctlRef.current?.abort();
    ctlRef.current = null;
    setRunning(false);
    void stopRun().catch(() => {});
  };
  const reset = () => {
    genRef.current += 1;
    ctlRef.current?.abort();
    ctlRef.current = null;
    clearState();
    void stopRun().catch(() => {});
  };
  const gate = (nodeId: string, text: string | null) => {
    void gateAction(nodeId, text);
    setGates((g) => g.filter((x) => x.nodeId !== nodeId));
  };
  const sendChat = async (text: string, nodeId?: string) => {
    await sendChatInput(text, nodeId);
  };
  return { running, metrics, events, captions, gates, agentSteps, executions, thoughts, chatMessages, collectResults, latency, latencyBreakdown, lastRunError, start, stop, reset, gate, sendChat };
}
export type Runner = ReturnType<typeof useRunner>;
