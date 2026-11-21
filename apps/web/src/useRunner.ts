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
  step: number;
  phase: 'calling' | 'rejected' | 'result' | 'repeated';
  tool: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  durationMs?: number;
  dryRun?: boolean;
}

export interface Caption {
  nodeId: string;
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
  const [chatMessages, setChatMessages] = useState<{ nodeId: string; text: string; ts: number }[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const [latencyBreakdown, setLatencyBreakdown] = useState<LatencyBreakdown | null>(null);
  const [lastRunError, setLastRunError] = useState<string | null>(null);
  const ctlRef = useRef<AbortController | null>(null);

  const applyMetrics = (snap: RunSnapshot) => {
    setMetrics(snap);
    let ttft: number | null = null;
    for (const m of Object.values(snap)) {
      for (const [k, t] of Object.entries(m.timers ?? {})) {
        if (k.includes('ttft')) ttft = t.lastMs;
      }
    }
    if (ttft != null) setLatency((cur) => cur ?? ttft);
  };

  const start = (flow: Flow, flowName?: string) => {
    // Run único no host: pare (idempotente) o run anterior ANTES de abrir outro,
    // senão o host responde 409 e a UI fica "parada" sem mostrar erro.
    ctlRef.current?.abort();
    ctlRef.current = null;
    void stopRun();

    setRunning(true);
    setLastRunError(null);
    setMetrics({});
    setEvents([]);
    setCaptions([]);
    setGates([]);
    setAgentSteps([]);
    setChatMessages([]);
    setLatency(null);
    setLatencyBreakdown(null);
    // Guarda de geração: callbacks de um run antigo (abortado/desconectado) não
    // podem derrubar o estado `running` nem sobrescrever o erro do run atual.
    let myCtl: AbortController;
    myCtl = openRun(
      flow,
      (ev) => {
        setEvents((e) => [...e.slice(-400), ev]);
        if (ev.type === 'metrics') applyMetrics(ev.snapshot as RunSnapshot);
        else if (ev.type === 'summary') applyMetrics((ev.metrics as RunSnapshot) ?? {});
        else if (ev.type === 'caption') {
          const trace = ev.trace && typeof ev.trace === 'object' ? (ev.trace as TraceMeta) : undefined;
          setCaptions((c) => [
            ...c.slice(-120),
            { nodeId: String(ev.nodeId), text: String(ev.text ?? ''), final: !!ev.final, ts: Date.now(), ...(trace ? { trace } : {}) },
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
              step: typeof ev.step === 'number' ? ev.step : 0,
              phase,
              tool: String(ev.tool ?? ''),
              ...(ev.args && typeof ev.args === 'object' ? { args: ev.args as Record<string, unknown> } : {}),
              ...(typeof ev.ok === 'boolean' ? { ok: ev.ok } : {}),
              ...(typeof ev.durationMs === 'number' ? { durationMs: ev.durationMs } : {}),
              ...(typeof ev.dryRun === 'boolean' ? { dryRun: ev.dryRun } : {}),
            },
          ]);
        } else if (ev.type === 'chat_sent') {
          setChatMessages((m) => [
            ...m.slice(-100),
            { nodeId: String(ev.nodeId ?? ''), text: String(ev.text ?? ''), ts: Date.now() },
          ]);
        }
      },
      () => { if (ctlRef.current === myCtl) setRunning(false); },
      undefined,
      flowName,
      (msg) => { if (ctlRef.current === myCtl) setLastRunError(msg); },
    );
    ctlRef.current = myCtl;
  };
  const stop = () => { void stopRun(); ctlRef.current?.abort(); ctlRef.current = null; setRunning(false); };
  const gate = (nodeId: string, text: string | null) => {
    void gateAction(nodeId, text);
    setGates((g) => g.filter((x) => x.nodeId !== nodeId));
  };
  const sendChat = async (text: string, nodeId?: string) => {
    await sendChatInput(text, nodeId);
  };
  return { running, metrics, events, captions, gates, agentSteps, chatMessages, latency, latencyBreakdown, lastRunError, start, stop, gate, sendChat };
}
export type Runner = ReturnType<typeof useRunner>;
