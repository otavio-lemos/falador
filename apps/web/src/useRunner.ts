// Estado de execução compartilhado entre Builder (Testar Fluxo) e Live.
import { useRef, useState } from 'react';
import { openRun, stopRun, gateAction, type Flow, type RunnerEvent, type RunSnapshot } from './api';

export interface Caption { nodeId: string; text: string; final: boolean }
export interface Gate { nodeId: string; text: string }

export function useRunner() {
  const [running, setRunning] = useState(false);
  const [metrics, setMetrics] = useState<RunSnapshot>({});
  const [events, setEvents] = useState<RunnerEvent[]>([]);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [latency, setLatency] = useState<number | null>(null);
  const ctlRef = useRef<AbortController | null>(null);

  const applyMetrics = (snap: RunSnapshot) => {
    setMetrics(snap);
    let ttft: number | null = null;
    for (const m of Object.values(snap)) {
      for (const [k, t] of Object.entries(m.timers ?? {})) {
        if (k.includes('ttft')) ttft = t.lastMs;
      }
    }
    if (ttft != null) setLatency(ttft);
  };

  const start = (flow: Flow) => {
    setRunning(true); setMetrics({}); setEvents([]); setCaptions([]); setGates([]); setLatency(null);
    ctlRef.current = openRun(
      flow,
      (ev) => {
        setEvents((e) => [...e.slice(-400), ev]);
        if (ev.type === 'metrics') applyMetrics(ev.snapshot as RunSnapshot);
        else if (ev.type === 'summary') applyMetrics((ev.metrics as RunSnapshot) ?? {});
        else if (ev.type === 'caption') {
          setCaptions((c) => [...c.slice(-120), { nodeId: String(ev.nodeId), text: String(ev.text ?? ''), final: !!ev.final }]);
        } else if (ev.type === 'gate') {
          setGates((g) => [...g.filter((x) => x.nodeId !== ev.nodeId), { nodeId: String(ev.nodeId), text: String(ev.text ?? '') }]);
        }
      },
      () => setRunning(false),
    );
  };
  const stop = () => { void stopRun(); ctlRef.current?.abort(); setRunning(false); };
  const gate = (nodeId: string, text: string | null) => {
    void gateAction(nodeId, text);
    setGates((g) => g.filter((x) => x.nodeId !== nodeId));
  };
  return { running, metrics, events, captions, gates, latency, start, stop, gate };
}
export type Runner = ReturnType<typeof useRunner>;