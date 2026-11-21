// falador web host — servidor local ZERO-DEP que amarra a UI ao runner oficial (run-flow.mjs).
//   GET  /api/catalog                → catálogo JSON (spawn run-flow --catalog)
//   GET  /api/flows                  → lista de flows salvos (apps/tui/flows/*.json)
//   GET  /api/flows/<name>           → JSON do flow
//   POST /api/flows                  → { name, flow } salva
//   POST /api/run                    → { flow, flowName?, runSeconds? } ; eventos do runner como SSE (text/event-stream)
//   POST /api/run/reset-history      → { nodeId? } limpa histórico conversacional do llm.omlx em runtime
//   POST /api/gate                   → { nodeId, text|null } aprovação/edição/rejeição do human.approve
//   POST /api/stop                   → mata o run corrente
//   POST /api/session/export         → { saveMarkdown?, webhookUrl?, flowName? } exporta ata .md e/ou envia webhook
//   GET  /api/context                → lista docs RAG (tags, chunksCount, points, chars)
//   POST /api/context/doc            → indexa .md/.txt/.pdf/.yaml/.yml/.json com chunks BM25
//   estático: serve apps/web/dist (build) — um único processo para tudo.
// Executa APENAS local (127.0.0.1). Nada de rede externa (exceto webhook opt-in explícito).
import { spawn } from 'node:child_process';
import { createServer, get as httpGet, request as httpRequest } from 'node:http';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chunkDocument } from '../packages/falador-nodes/src/context-store.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'packages/falador-cli/run-flow.mjs');
const FLOWS_DIR = join(ROOT, 'apps/tui/flows');
const DIST = join(ROOT, 'apps/web/dist');
const PORT = Number(process.env.FALADOR_WEB_PORT ?? 8787);

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const ALLOWED_DOC_EXTS = new Set(['.md', '.markdown', '.txt', '.pdf', '.yaml', '.yml', '.json']);

const OMLX = process.env.FALADOR_OMLX_URL || 'http://127.0.0.1:8080';
const TEXT_MODEL = 'LFM3-1.7B-MLX-4bit';

function getContextDir() {
  return process.env.FALADOR_CONTEXT_DIR || join(ROOT, 'context');
}
function getContextFile() {
  return join(getContextDir(), 'docs.json');
}
function getSessionsDir() {
  return process.env.FALADOR_SESSIONS_DIR || join(ROOT, 'sessions');
}

let currentRun = null; // { child, clients:Set<res>, stopRequested }

function createEmptySession(flowName = 'sessao') {
  return {
    startedAt: new Date().toISOString(),
    endedAt: null,
    flowName,
    captions: [], // { ts, nodeId, kind, text, trace? }
    approved: [], // { ts, nodeId, text }
    topics: [],
    traces: [],
  };
}

let sessionBuffer = createEmptySession();

// ---- Contexto & RAG genérico (100% on-device) ----

function loadDocs() {
  try {
    const parsed = JSON.parse(readFileSync(getContextFile(), 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveDocs(docs) {
  const dir = getContextDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getContextFile(), JSON.stringify(docs, null, 2));
}

// chamada síncrona (stream:false) ao omlx — enable_thinking:false OBRIGATÓRIO (LFM3)
function omlxChat(messages, maxTokens = 256) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: TEXT_MODEL,
      messages,
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    const req = httpRequest(
      OMLX + '/v1/chat/completions',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 10000,
      },
      (r) => {
        let out = '';
        r.on('data', (d) => (out += d));
        r.on('end', () => {
          try {
            resolve(JSON.parse(out).choices?.[0]?.message?.content ?? '');
          } catch {
            resolve('');
          }
        });
      },
    );
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end(body);
  });
}

// LFM3 pode devolver JSON ou linhas — extrai lista de strings defensivamente
function parseList(raw) {
  if (!raw || !raw.trim()) return [];
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const a = JSON.parse(m[0]);
      if (Array.isArray(a)) return a.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 6);
    } catch { /* cai p/ linhas */ }
  }
  return raw
    .split('\n')
    .map((s) => s.replace(/^[-*\d.\s]+/, '').trim())
    .filter((s) => s.length > 1 && s.length < 120)
    .slice(0, 6);
}

async function extractPoints(text) {
  try {
    const raw = await omlxChat([
      {
        role: 'system',
        content: 'Você extrai pontos-chave objetivos de documentos técnicos e runbooks. Responda APENAS com um array JSON de até 3 strings curtas em português.',
      },
      {
        role: 'user',
        content: 'Extraia até 3 pontos-chave objetivos deste documento:\n\n' + text.slice(0, 6000),
      },
    ], 200);
    return parseList(raw);
  } catch {
    return [];
  }
}

// PDF → texto via pdftotext (poppler, já instalado) — zero dependência nova
function pdfToText(buf) {
  return new Promise((resolve) => {
    const tmp = join(tmpdir(), `falador-doc-${Date.now()}.pdf`);
    writeFileSync(tmp, buf);
    const child = spawn('pdftotext', [tmp, '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const done = (txt) => {
      try { unlinkSync(tmp); } catch { /* já removido */ }
      resolve(txt);
    };
    child.on('exit', () => done(out));
    child.on('error', () => done(''));
  });
}

// ---- Sessão & Exportação (ADR-006 Fase 6) ----

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

function summarizeTraces(traces) {
  const asr = [];
  const turn = [];
  const llmTtft = [];
  const decision = [];
  const total = [];

  for (const t of traces) {
    if (!t || typeof t !== 'object') continue;
    if (typeof t.tAsrFinalMs === 'number' && typeof t.tAsrFirstMs === 'number') {
      asr.push(Math.max(0, t.tAsrFinalMs - t.tAsrFirstMs));
    }
    if (typeof t.tTurnMs === 'number' && typeof t.tAsrFinalMs === 'number') {
      turn.push(Math.max(0, t.tTurnMs - t.tAsrFinalMs));
    }
    const baseLlm = typeof t.tTurnMs === 'number' ? t.tTurnMs : t.tAsrFinalMs;
    if (typeof t.tLlmTtftMs === 'number' && typeof baseLlm === 'number') {
      llmTtft.push(Math.max(0, t.tLlmTtftMs - baseLlm));
    }
    if (typeof t.tDecisionMs === 'number' && typeof t.tLlmFinalMs === 'number') {
      decision.push(Math.max(0, t.tDecisionMs - t.tLlmFinalMs));
    }
    const endTotal = typeof t.tDecisionMs === 'number' ? t.tDecisionMs : t.tLlmTtftMs;
    if (typeof endTotal === 'number' && typeof t.tAsrFinalMs === 'number') {
      total.push(Math.max(0, endTotal - t.tAsrFinalMs));
    }
  }

  return {
    samples: traces.length,
    asrMs: { p50: percentile(asr, 50), p95: percentile(asr, 95) },
    turnMs: { p50: percentile(turn, 50), p95: percentile(turn, 95) },
    llmTtftMs: { p50: percentile(llmTtft, 50), p95: percentile(llmTtft, 95) },
    decisionMs: { p50: percentile(decision, 50), p95: percentile(decision, 95) },
    totalMs: { p50: percentile(total, 50), p95: percentile(total, 95) },
  };
}

function formatSessionMarkdown(session, latencySummary) {
  const lines = [];
  lines.push(`# Sessão Falador — ${session.flowName}`);
  lines.push('');
  lines.push(`- **Início:** ${session.startedAt}`);
  lines.push(`- **Fim:** ${session.endedAt ?? new Date().toISOString()}`);
  lines.push(`- **Fluxo:** \`${session.flowName}\``);
  if (session.topics.length > 0) {
    lines.push(`- **Tópicos:** ${session.topics.join(', ')}`);
  }
  lines.push('');

  const transcriptions = session.captions.filter((c) => c.kind === 'transcription');
  const suggestions = session.captions.filter((c) => c.kind !== 'transcription');

  lines.push('## Transcrições');
  lines.push('');
  if (transcriptions.length === 0) {
    lines.push('_Nenhuma transcrição registrada._');
  } else {
    for (const c of transcriptions) {
      lines.push(`- [${c.ts}] (${c.nodeId}) ${c.text}`);
    }
  }
  lines.push('');

  lines.push('## Sugestões e Diagnósticos');
  lines.push('');
  if (suggestions.length === 0) {
    lines.push('_Nenhuma sugestão ou diagnóstico registrado._');
  } else {
    for (const c of suggestions) {
      lines.push(`- [${c.ts}] (${c.nodeId}) ${c.text}`);
    }
  }
  lines.push('');

  lines.push('## Aprovações e Comandos');
  lines.push('');
  if (session.approved.length === 0) {
    lines.push('_Nenhuma aprovação manual registrada._');
  } else {
    for (const a of session.approved) {
      lines.push(`- [${a.ts}] (${a.nodeId}) \`${a.text}\``);
    }
  }
  lines.push('');

  lines.push('## Resumo de Latência');
  lines.push('');
  const fmt = (stat) => (stat.p50 == null ? '—' : `p50=${stat.p50}ms / p95=${stat.p95}ms`);
  lines.push(`- **Amostras de trace:** ${latencySummary.samples}`);
  lines.push(`- **ASR:** ${fmt(latencySummary.asrMs)}`);
  lines.push(`- **Turn Detector:** ${fmt(latencySummary.turnMs)}`);
  lines.push(`- **LLM TTFT:** ${fmt(latencySummary.llmTtftMs)}`);
  lines.push(`- **Decisão d1:** ${fmt(latencySummary.decisionMs)}`);
  lines.push(`- **Total:** ${fmt(latencySummary.totalMs)}`);
  lines.push('');

  return lines.join('\n');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function buildMarkdownFilename(flowName) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
  const slug = String(flowName || 'sessao')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'sessao';
  return `${stamp}-${slug}.md`;
}

function classifyFlowTranscriptionSinks(flow) {
  const asrIds = new Set((flow?.nodes ?? []).filter((n) => String(n.type ?? '').startsWith('asr')).map((n) => n.id));
  const transcription = new Set();
  for (const n of flow?.nodes ?? []) {
    if (n.type !== 'sink.captions') continue;
    const edge = (flow?.edges ?? []).find((e) => String(e.to ?? '').split('.')[0] === n.id);
    const src = edge ? String(edge.from ?? '').split('.')[0] : '';
    if (asrIds.has(src)) transcription.add(n.id);
  }
  return transcription;
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function broadcast(event, data) {
  if (!currentRun) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of currentRun.clients) res.write(payload);
}

function startRun(flow, runSeconds, flowName) {
  if (currentRun) return { error: 'run já em andamento (POST /api/stop antes)' };
  const tmp = join(FLOWS_DIR, '.web-run.tmp.json');
  writeFileSync(tmp, JSON.stringify(flow));
  const args = [CLI, tmp];
  if (runSeconds) args.push('--run-seconds', String(runSeconds));
  const child = spawn('node', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const clients = new Set();
  const transcriptionSinks = classifyFlowTranscriptionSinks(flow);
  sessionBuffer = createEmptySession(flowName || flow?.name || 'sessao');
  currentRun = { child, clients, stopRequested: false };
  const sses = (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: attached\ndata: {}\n\n`);
    clients.add(res);
    res.on('close', () => clients.delete(res));
  };
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === 'caption' && ev.final && typeof ev.text === 'string' && ev.text.trim()) {
        sessionBuffer.captions.push({
          ts: new Date().toISOString(),
          nodeId: String(ev.nodeId ?? ''),
          kind: transcriptionSinks.has(String(ev.nodeId ?? '')) ? 'transcription' : 'suggestion',
          text: ev.text.trim(),
          ...(ev.trace ? { trace: ev.trace } : {}),
        });
        if (sessionBuffer.captions.length > 500) sessionBuffer.captions.shift();
        if (ev.trace && typeof ev.trace === 'object') {
          sessionBuffer.traces.push(ev.trace);
          if (sessionBuffer.traces.length > 500) sessionBuffer.traces.shift();
        }
      }
      // undici keep-alive: o child do runner pode não sair sozinho no fim do run
      // (lição §4) — emitido run_stopped/summary, encerra o child e libera o next run.
      if (ev.type === 'summary' || ev.type === 'run_stopped') {
        setTimeout(() => {
          try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* race de exit */ }
        }, 300);
      }
      broadcast('runner', ev);
    }
  });
  child.stderr.on('data', (d) => broadcast('runner_stderr', { line: d.toString().trim() }));
  child.on('exit', (code) => {
    sessionBuffer.endedAt = new Date().toISOString();
    broadcast('ended', { code });
    for (const res of clients) {
      try { res.end(); } catch { /* já fechado */ }
    }
    currentRun = null;
  });
  return { sse: sses, pid: child.pid };
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/catalog') {
    const child = spawn('node', [CLI, '--catalog'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', () => { try { json(res, 200, JSON.parse(out)); } catch { json(res, 500, { error: 'catálogo inválido' }); } });
    return true;
  }
  if (pathname === '/api/flows' && req.method === 'GET') {
    if (!existsSync(FLOWS_DIR)) mkdirSync(FLOWS_DIR, { recursive: true });
    const files = readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
    const flows = files.map((f) => {
      let description = '';
      try { description = JSON.parse(readFileSync(join(FLOWS_DIR, f), 'utf-8')).description ?? ''; } catch { /* corrompido */ }
      return { name: f.replace(/\.json$/, ''), description };
    });
    return json(res, 200, { flows }), true;
  }
  if (pathname === '/api/models' && req.method === 'GET') {
    // REUTILIZA serviços que existem: /v1/models do omlx (:8080) + cache HF local (nomes de dir).
    const omlx = await new Promise((resolve) => {
      let out = '';
      const h = httpGet(`${OMLX}/v1/models`, { timeout: 2500 }, (r) => {
        r.on('data', (d) => (out += d));
        r.on('end', () => { try { resolve(JSON.parse(out).data.map((m) => m.id)); } catch { resolve([]); } });
      });
      h.on('error', () => resolve([]));
      h.on('timeout', () => { h.destroy(); resolve([]); });
    });
    const cacheDir = join(process.env.HOME ?? '', '.cache', 'huggingface', 'hub');
    const cache = existsSync(cacheDir)
      ? readdirSync(cacheDir).filter((d) => d.startsWith('models--')).map((d) => d.replace(/^models--/, '').replace(/--/g, '/'))
      : [];
    return json(res, 200, { omlx, cache }), true;
  }
  if (pathname === '/api/apps' && req.method === 'GET') {
    // apps rodando via ScreenCaptureKit (--list) — picker de captura por app (W10)
    const bin = join(ROOT, 'services/capture-sck');
    if (!existsSync(bin)) return json(res, 200, { apps: [], note: 'capture-sck ainda não compilado (rode um flow sck primeiro)' }), true;
    const child = spawn(bin, ['--list'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* já morto */ } }, 6000);
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', () => {
      clearTimeout(to);
      try {
        const raw = JSON.parse(out);
        const SKIP_PREFIXES = ['com.apple.'];
        const SKIP_SUFFIXES = ['.xpc', '.helper', 'Service', 'Agent', 'Daemon'];
        const SKIP_NAMES = [
          'loginwindow', 'Dock', 'Finder', 'WindowManager',
          'CursorUIViewService', 'LocalAuthenticationRemoteService',
          'AccessibilityVisualsAgent', 'MenuBarAgent', 'TextInputSwitcher',
          'UserNotificationCenter',
        ];
        const apps = raw.filter((a) => {
          if (!a.bundleId) return false;
          if (SKIP_PREFIXES.some((p) => a.bundleId.startsWith(p))) return false;
          if (SKIP_SUFFIXES.some((s) => a.bundleId.endsWith(s) || a.name.endsWith(s))) return false;
          if (SKIP_NAMES.includes(a.name)) return false;
          return true;
        });
        return json(res, 200, { apps });
      } catch { return json(res, 200, { apps: [] }); }
    });
    return true;
  }
  if (pathname.startsWith('/api/flows/') && req.method === 'GET') {
    const name = decodeURIComponent(pathname.slice('/api/flows/'.length));
    const p = join(FLOWS_DIR, name + '.json');
    if (!p.startsWith(FLOWS_DIR) || !existsSync(p)) { res.writeHead(404); return res.end('not found'), true; }
    const flow = JSON.parse(readFileSync(p, 'utf-8'));
    return json(res, 200, { name, flow }), true;
  }
  if (pathname === '/api/flows' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name || !body.flow) return json(res, 400, { error: 'name e flow obrigatórios' }), true;
    if (!existsSync(FLOWS_DIR)) mkdirSync(FLOWS_DIR, { recursive: true });
    // descrição vai DENTRO do flow (um arquivo, uma verdade); rename apaga o antigo
    const flow = { ...body.flow, description: body.flow.description ?? '' };
    writeFileSync(join(FLOWS_DIR, body.name.replace(/\.json$/, '') + '.json'), JSON.stringify(flow, null, 2));
    if (body.renameFrom && body.renameFrom !== body.name) {
      const old = join(FLOWS_DIR, body.renameFrom.replace(/\.json$/, '') + '.json');
      if (old.startsWith(FLOWS_DIR) && existsSync(old)) { try { unlinkSync(old); } catch { /* busy */ } }
    }
    return json(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/run' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.flow) return json(res, 400, { error: 'flow obrigatório' }), true;
    const r = startRun(body.flow, body.runSeconds ?? 0, body.flowName);
    if (r.error) return json(res, 409, r), true;
    r.sse(res);
    return true;
  }
  if (pathname === '/api/run/reset-history' && req.method === 'POST') {
    const body = await readBody(req);
    const nodeId = typeof body.nodeId === 'string' && body.nodeId.trim() ? body.nodeId.trim() : '*';
    if (!currentRun) {
      return json(res, 200, { ok: true, sent: false, nodeId, note: 'nenhum run em andamento' }), true;
    }
    currentRun.child.stdin?.write(JSON.stringify({ type: 'reset_history', nodeId }) + '\n');
    return json(res, 200, { ok: true, sent: true, nodeId }), true;
  }
  if (pathname === '/api/gate' && req.method === 'POST') {
    // aprovação/edição/rejeição do human.approve: {"nodeId","text"|null}
    if (!currentRun) return json(res, 409, { error: 'nenhum run' }), true;
    const body = await readBody(req);
    if (!body.nodeId) return json(res, 400, { error: 'nodeId obrigatório' }), true;
    if (typeof body.text === 'string' && body.text.trim()) {
      sessionBuffer.approved.push({
        ts: new Date().toISOString(),
        nodeId: String(body.nodeId),
        text: body.text.trim(),
      });
    }
    currentRun.child.stdin?.write(JSON.stringify({ type: 'gate_action', nodeId: body.nodeId, text: body.text ?? null }) + '\n');
    return json(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/stop' && req.method === 'POST') {
    if (!currentRun) return json(res, 200, { ok: 'nenhum run' }), true;
    currentRun.stopRequested = true;
    currentRun.child.kill('SIGTERM');
    return json(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/session/export' && req.method === 'POST') {
    const body = await readBody(req);
    const flowName = (typeof body.flowName === 'string' && body.flowName.trim())
      ? body.flowName.trim()
      : (sessionBuffer.flowName || 'sessao');
    const sessionSnapshot = {
      ...sessionBuffer,
      flowName,
      endedAt: sessionBuffer.endedAt ?? new Date().toISOString(),
    };
    const latencySummary = summarizeTraces(sessionSnapshot.traces);
    const result = { ok: true };

    if (body.saveMarkdown !== false) {
      const sessionsDir = getSessionsDir();
      if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
      const fileName = buildMarkdownFilename(flowName);
      const mdPath = join(sessionsDir, fileName);
      writeFileSync(mdPath, formatSessionMarkdown(sessionSnapshot, latencySummary), 'utf-8');
      result.markdownPath = mdPath;
    }

    const rawWebhook = typeof body.webhookUrl === 'string' && body.webhookUrl.trim()
      ? body.webhookUrl.trim()
      : (body.useEnvWebhook === true && process.env.FALADOR_WEBHOOK_URL ? process.env.FALADOR_WEBHOOK_URL.trim() : '');

    if (rawWebhook) {
      try {
        const resp = await fetch(rawWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...sessionSnapshot,
            latencySummary,
          }),
          signal: AbortSignal.timeout(5000),
        });
        result.webhookStatus = resp.status;
      } catch (err) {
        result.webhookError = String(err?.message ?? err);
      }
    }

    return json(res, 200, result), true;
  }
  if (pathname === '/api/context' && req.method === 'GET') {
    const docs = loadDocs().map((d) => ({
      id: d.id ?? d.name,
      name: d.name,
      tags: Array.isArray(d.tags) ? d.tags : [],
      addedAt: d.addedAt ?? null,
      points: Array.isArray(d.points) ? d.points : [],
      chunksCount: Array.isArray(d.chunks) ? d.chunks.length : 0,
      chars: typeof d.text === 'string' ? d.text.length : 0,
    }));
    return json(res, 200, { docs }), true;
  }
  if (pathname === '/api/context/doc' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name || typeof body.name !== 'string') return json(res, 400, { error: 'name obrigatório' }), true;
    const ext = extname(body.name).toLowerCase();
    if (ext && !ALLOWED_DOC_EXTS.has(ext)) {
      return json(res, 400, { error: `extensão não suportada (${ext}); use .md, .txt, .pdf, .yaml, .yml ou .json` }), true;
    }
    const text = body.pdfB64 ? await pdfToText(Buffer.from(body.pdfB64, 'base64')) : String(body.text ?? '');
    if (!text.trim()) return json(res, 400, { error: 'documento vazio (PDF sem camada de texto ou arquivo vazio)' }), true;
    const tags = Array.isArray(body.tags)
      ? body.tags.map((t) => String(t).trim()).filter(Boolean)
      : [];
    const chunks = chunkDocument(body.name, text, { tags });
    const points = await extractPoints(text);
    const addedAt = new Date().toISOString();
    const id = randomUUID();
    const docs = loadDocs().filter((d) => d.name !== body.name);
    docs.push({ id, name: body.name, tags, addedAt, points, chunks, text });
    saveDocs(docs);
    return json(res, 200, { id, name: body.name, tags, addedAt, points, chunksCount: chunks.length, chars: text.length }), true;
  }
  if (pathname === '/api/context/remove' && req.method === 'POST') {
    const body = await readBody(req);
    saveDocs(loadDocs().filter((d) => d.name !== body.name));
    return json(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/context/topics' && req.method === 'POST') {
    const body = await readBody(req);
    const raw = await omlxChat([
      { role: 'system', content: 'Você detecta tópicos técnicos numa conversa. Responda APENAS com um array JSON de 3 a 5 strings curtas (1-2 palavras).' },
      { role: 'user', content: 'Detecte os tópicos técnicos desta fala:\n\n' + String(body.text ?? '').slice(0, 2000) },
    ], 120);
    const topics = parseList(raw);
    for (const t of topics) {
      if (!sessionBuffer.topics.includes(t)) sessionBuffer.topics.push(t);
    }
    return json(res, 200, { topics }), true;
  }
  return false;
}

export function createWebServer() {
  return createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
    try {
      if (await handleApi(req, res, pathname)) return;
      // estático do build
      let file = join(DIST, pathname === '/' ? 'index.html' : pathname);
      if (!existsSync(file)) file = join(DIST, 'index.html');
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createWebServer();
  server.listen(PORT, '127.0.0.1', () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : PORT;
    console.log(`falador host http://127.0.0.1:${boundPort}`);
  });
}
