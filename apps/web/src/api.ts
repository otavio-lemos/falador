// Camada de API — fala com o host zero-dep (apps/web-server.mjs :8787).
// Catálogo, flows (save/load), run via SSE, gate humano, modelos, apps.

export interface CatalogPort { name: string; type: string }
export interface CatalogNode {
  type: string;
  paramNames: string[];
  inputs: CatalogPort[];
  outputs: CatalogPort[];
  outputsFor?: unknown;
}
export interface Catalog { nodes: CatalogNode[] }

export interface FlowNode { id: string; type: string; params: Record<string, unknown>; enabled?: boolean }
export interface FlowEdge { from: string; to: string; capacity?: number; overflow?: string; ttlMs?: number }
export interface Flow {
  version?: number;
  stopWhenSourcesDone?: boolean;
  description?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface TimerStat { count: number; lastMs: number; avgMs: number; minMs: number; maxMs: number }
export interface NodeMetrics {
  in: number; out: number; errors: number; dropped: number; expired: number;
  procMsP50?: number; procMsP95?: number;
  counters: Record<string, number>;
  timers: Record<string, TimerStat>;
}
export type RunSnapshot = Record<string, NodeMetrics>;
export type RunnerEvent = { type: string; [k: string]: unknown };

export async function fetchCatalog(): Promise<Catalog> {
  return (await fetch('/api/catalog')).json();
}
export async function fetchFlows(): Promise<{ name: string; description: string }[]> {
  return (await fetch('/api/flows')).json().then((j) => j.flows);
}
export async function fetchFlow(name: string): Promise<Flow> {
  return (await fetch('/api/flows/' + encodeURIComponent(name))).json().then((j) => j.flow);
}
export async function saveFlow(name: string, flow: Flow, renameFrom?: string): Promise<void> {
  const r = await fetch('/api/flows', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, flow, renameFrom }),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? 'falha ao salvar');
}
export async function deleteFlow(name: string): Promise<void> {
  const r = await fetch('/api/flows/' + encodeURIComponent(name), { method: 'DELETE' });
  if (!r.ok) throw new Error('falha ao remover workflow');
}
export async function fetchModels(): Promise<{ omlx: string[]; cache: string[] }> {
  return (await fetch('/api/models')).json();
}
export interface MicInfo { id: number; name: string; sampleRate: number }
export async function fetchApps(): Promise<string[]> {
  const j = await (await fetch('/api/apps')).json();
  return [...new Set((j.apps as { name: string }[]).map((a) => a.name).filter((n) => n && n.trim() && !n.startsWith('Open and Save Panel Service')))];
}
export async function fetchMics(): Promise<MicInfo[]> {
  try {
    const j = await (await fetch('/api/mics')).json();
    const list = (j.mics ?? []) as { id?: number; name?: string; sampleRate?: number }[];
    return list
      .map((m) => ({ id: Number(m.id ?? 0), name: String(m.name ?? ''), sampleRate: Number(m.sampleRate ?? 16000) }))
      .filter((m) => m.name.trim() !== '');
  } catch {
    return [];
  }
}

export interface ServiceStatusMap {
  web: boolean;
  asr: boolean;
  omlx: boolean;
  tts: boolean;
}
export interface ServiceStatusResult {
  services: ServiceStatusMap;
  ts: number;
}
export async function fetchServiceStatus(): Promise<ServiceStatusResult> {
  const r = await fetch(`/api/services/status?_t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`falha ao verificar serviços (HTTP ${r.status})`);
  return r.json();
}

// ---- Contexto & RAG local (runbooks / docs) ----
export interface ContextDoc {
  id?: string;
  name: string;
  tags?: string[];
  addedAt?: string | null;
  points: string[];
  chunksCount?: number;
  chars: number;
}
export async function fetchContext(): Promise<ContextDoc[]> {
  return (await fetch('/api/context')).json().then((j) => j.docs);
}
export async function uploadDoc(
  name: string,
  payload: { text?: string; pdfB64?: string; tags?: string[] },
): Promise<ContextDoc> {
  const r = await fetch('/api/context/doc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, ...payload }),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? 'falha no upload');
  return r.json();
}
export async function removeDoc(name: string): Promise<void> {
  await fetch('/api/context/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
}
export async function fetchTopics(text: string): Promise<string[]> {
  return (await fetch('/api/context/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json().then((j) => j.topics);
}
export async function stopRun(): Promise<void> {
  await fetch('/api/stop', { method: 'POST' });
}
export async function resetHistory(nodeId?: string): Promise<{ ok: boolean; sent?: boolean; nodeId?: string }> {
  const r = await fetch('/api/run/reset-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId: nodeId ?? '*' }),
  });
  return r.json();
}
export async function sendChatInput(text: string, nodeId?: string): Promise<{ ok: boolean; sent?: boolean; nodeId?: string }> {
  const r = await fetch('/api/run/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, nodeId: nodeId ?? '*' }),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? 'falha ao enviar mensagem');
  return r.json();
}
export interface ExportSessionOptions {
  saveMarkdown?: boolean;
  webhookUrl?: string;
  flowName?: string;
}
export interface ExportSessionResult {
  ok: boolean;
  markdownPath?: string;
  webhookStatus?: number;
  webhookError?: string;
}
export async function exportSession(opts: ExportSessionOptions): Promise<ExportSessionResult> {
  const r = await fetch('/api/session/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!r.ok) throw new Error((await r.json()).error ?? 'falha ao exportar sessão');
  return r.json();
}
// ---- Logs dos serviços residentes (omlx/asr/tts/web) ----
export interface LogsResult {
  name: string;
  path?: string;
  lines: string[];
  total?: number;
  truncated?: boolean;
  note?: string;
}
export async function fetchLogs(name: string, lines = 200): Promise<LogsResult> {
  const r = await fetch(`/api/logs?name=${encodeURIComponent(name)}&lines=${lines}&_t=${Date.now()}`, {
    cache: 'no-store',
  });
  if (!r.ok) {
    let msg = `falha ao ler logs (HTTP ${r.status})`;
    try {
      const j = (await r.json()) as { error?: unknown };
      if (j && typeof j.error === 'string' && j.error) msg = j.error;
    } catch { /* resposta não-JSON */ }
    throw new Error(msg);
  }
  return r.json();
}
export interface ClearLogsResult {
  ok: boolean;
  cleared: string[];
}
export async function clearLogs(names?: string[]): Promise<ClearLogsResult> {
  const r = await fetch('/api/logs/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(names ? { names } : {}),
  });
  if (!r.ok) {
    let msg = `falha ao limpar logs (HTTP ${r.status})`;
    try {
      const j = (await r.json()) as { error?: unknown };
      if (j && typeof j.error === 'string' && j.error) msg = j.error;
    } catch { /* resposta não-JSON */ }
    throw new Error(msg);
  }
  return r.json();
}
export async function gateAction(nodeId: string, text: string | null): Promise<void> {
  await fetch('/api/gate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, text }),
  });
}

// SSE do host: "event: <nome>\ndata: <json>". Usado por openRun (dono do run)
// e openEvents (console anexado ao run já existente).
async function readSse(r: Response, onEvent: (ev: RunnerEvent) => void, onEnd: (code: number) => void): Promise<void> {
  if (!r.body) { onEnd(-1); return; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let evName = 'message'; let data = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) evName = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed: unknown; try { parsed = JSON.parse(data); } catch { continue; }
      if (evName === 'runner') onEvent(parsed as RunnerEvent);
      else if (evName === 'runner_stderr') onEvent({ type: 'runner_stderr', ...(parsed as Record<string, unknown>) });
      else if (evName === 'ended') { onEnd((parsed as { code: number }).code ?? 0); return; }
    }
  }
  onEnd(-1); // stream fechou sem 'ended'
}

// GET /api/events → anexa o console ao run atual, sem iniciar outro.
export function openEvents(
  onEvent: (ev: RunnerEvent) => void,
  onEnd: (code: number) => void,
): AbortController {
  const ctl = new AbortController();
  fetch('/api/events', { signal: ctl.signal }).then(async (r) => {
    if (!r.ok) { onEnd(-1); return; }
    await readSse(r, onEvent, onEnd);
  }).catch(() => { if (!ctl.signal.aborted) onEnd(-1); });
  return ctl;
}

// POST /api/run → SSE. Cada frame: "event: <nome>\ndata: <json>".
// nome 'runner' = evento do motor; 'ended' = fim (code); 'attached' = conectou.
export function openRun(
  flow: Flow,
  onEvent: (ev: RunnerEvent) => void,
  onEnd: (code: number) => void,
  onOpen?: () => void,
  flowName?: string,
  // onError é opcional para não quebrar chamadas existentes: recebe a mensagem
  // do host (ex.: 409 "run já em andamento") antes de onEnd(-1).
  onError?: (msg: string) => void,
  testMode?: boolean,
): AbortController {
  const ctl = new AbortController();
  fetch('/api/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flow, ...(flowName ? { flowName } : {}), ...(testMode ? { testMode: true } : {}) }), signal: ctl.signal,
  }).then(async (r) => {
    if (!r.ok) {
      let msg = `falha ao iniciar run (HTTP ${r.status})`;
      try {
        const j = (await r.json()) as { error?: unknown };
        if (j && typeof j.error === 'string' && j.error) msg = j.error;
      } catch { /* corpo não-JSON: mantém a mensagem padrão */ }
      onError?.(msg);
      onEnd(-1);
      return;
    }
    if (!r.body) { onError?.('resposta do host sem corpo SSE'); onEnd(-1); return; }
    onOpen?.();
    await readSse(r, onEvent, onEnd);
  }).catch((err: unknown) => {
    if (!ctl.signal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      onError?.(`falha de conexão com o host (:8787): ${msg}`);
    }
    onEnd(-1);
  });
  return ctl;
}