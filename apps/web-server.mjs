// falador web host — servidor local ZERO-DEP que amarra a UI ao runner oficial (run-flow.mjs).
//   GET  /api/catalog                → catálogo JSON (spawn run-flow --catalog)
//   GET  /api/flows                  → lista de flows salvos (apps/tui/flows/*.json)
//   GET  /api/flows/<name>           → JSON do flow
//   POST /api/flows                  → { name, flow } salva
//   POST /api/run                    → { flow, runSeconds? } ; eventos do runner como SSE (text/event-stream)
//   POST /api/stop                   → mata o run corrente
//   estático: serve apps/web/dist (build) — um único processo para tudo.
// Executa APENAS local (127.0.0.1). Nada de rede externa.
import { spawn } from 'node:child_process';
import { createServer, get as httpGet, request as httpRequest } from 'node:http';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'packages/falador-cli/run-flow.mjs');
const FLOWS_DIR = join(ROOT, 'apps/tui/flows');
const DIST = join(ROOT, 'apps/web/dist');
const PORT = 8787;

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

let currentRun = null; // { child, clients:Set<res>, stopRequested }

// ---- Contexto & Cheatsheet (RAG leve 100% on-device via omlx) ----
const CONTEXT_DIR = join(ROOT, 'context');
const CONTEXT_FILE = join(CONTEXT_DIR, 'docs.json');
const OMLX = 'http://127.0.0.1:8080';
const TEXT_MODEL = 'LFM3-1.7B-MLX-4bit';

function loadDocs() { try { return JSON.parse(readFileSync(CONTEXT_FILE, 'utf-8')); } catch { return []; } }
function saveDocs(docs) { if (!existsSync(CONTEXT_DIR)) mkdirSync(CONTEXT_DIR, { recursive: true }); writeFileSync(CONTEXT_FILE, JSON.stringify(docs, null, 2)); }

// chamada síncrona (stream:false) ao omlx — enable_thinking:false OBRIGATÓRIO (LFM3)
function omlxChat(messages, maxTokens = 256) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: TEXT_MODEL, messages, temperature: 0.2, max_tokens: maxTokens, stream: false, chat_template_kwargs: { enable_thinking: false } });
    const req = httpRequest(OMLX + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30000 }, (r) => {
      let out = ''; r.on('data', (d) => (out += d));
      r.on('end', () => { try { resolve(JSON.parse(out).choices?.[0]?.message?.content ?? ''); } catch { resolve(''); } });
    });
    req.on('error', () => resolve('')); req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end(body);
  });
}

// LFM3 pode devolver JSON ou linhas — extrai lista de strings defensivamente
function parseList(raw) {
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) { try { const a = JSON.parse(m[0]); if (Array.isArray(a)) return a.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 6); } catch { /* cai p/ linhas */ } }
  return raw.split('\n').map((s) => s.replace(/^[-*\d.\s]+/, '').trim()).filter((s) => s.length > 1 && s.length < 80).slice(0, 6);
}

async function extractPoints(text) {
  const raw = await omlxChat([
    { role: 'system', content: 'Você extrai pontos-chave de documentos para preparar uma entrevista técnica. Responda APENAS com um array JSON de até 3 strings curtas em português.' },
    { role: 'user', content: 'Extraia até 3 pontos-chave deste documento:\n\n' + text.slice(0, 6000) },
  ], 200);
  return parseList(raw);
}

// PDF → texto via pdftotext (poppler, já instalado) — zero dependência nova
function pdfToText(buf) {
  return new Promise((resolve) => {
    const tmp = join(tmpdir(), `falador-doc-${Date.now()}.pdf`);
    writeFileSync(tmp, buf);
    const child = spawn('pdftotext', [tmp, '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; child.stdout.on('data', (d) => (out += d));
    const done = (txt) => { try { unlinkSync(tmp); } catch { /* já removido */ } resolve(txt); };
    child.on('exit', () => done(out));
    child.on('error', () => done(''));
  });
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

function startRun(flow, runSeconds) {
  if (currentRun) return { error: 'run já em andamento (POST /api/stop antes)' };
  const tmp = join(FLOWS_DIR, '.web-run.tmp.json');
  writeFileSync(tmp, JSON.stringify(flow));
  const args = [CLI, tmp];
  if (runSeconds) args.push('--run-seconds', String(runSeconds));
  const child = spawn('node', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const clients = new Set();
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
      const h = httpGet('http://127.0.0.1:8080/v1/models', { timeout: 2500 }, (r) => {
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
        // Filtra só apps de usuário reais: bundle não vazio, não-Apple, não XPC/helper/agent
        const SKIP_PREFIXES = [
          'com.apple.', // exclui serviços Apple e helpers do sistema
        ];
        const SKIP_SUFFIXES = [
          '.xpc', '.helper', 'Service', 'Agent', 'Daemon',
        ];
        const SKIP_NAMES = [
          'loginwindow', 'Dock', 'Finder', 'WindowManager',
          'CursorUIViewService', 'LocalAuthenticationRemoteService',
          'AccessibilityVisualsAgent', 'MenuBarAgent', 'TextInputSwitcher',
          'UserNotificationCenter',
        ];
        const apps = raw.filter(a => {
          if (!a.bundleId) return false;
          if (SKIP_PREFIXES.some(p => a.bundleId.startsWith(p))) return false;
          if (SKIP_SUFFIXES.some(s => a.bundleId.endsWith(s) || a.name.endsWith(s))) return false;
          if (SKIP_NAMES.includes(a.name)) return false;
          return true;
        });
        return json(res, 200, { apps });
      } catch { return json(res, 200, []); }
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
    const r = startRun(body.flow, body.runSeconds ?? 0);
    if (r.error) return json(res, 409, r), true;
    r.sse(res);
    return true;
  }
  if (pathname === '/api/gate' && req.method === 'POST') {
    // aprovação/edição/rejeição do human.approve: {"nodeId","text"|null}
    if (!currentRun) return json(res, 409, { error: 'nenhum run' }), true;
    const body = await readBody(req);
    if (!body.nodeId) return json(res, 400, { error: 'nodeId obrigatório' }), true;
    currentRun.child.stdin?.write(JSON.stringify({ type: 'gate_action', nodeId: body.nodeId, text: body.text ?? null }) + '\n');
    return json(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/stop' && req.method === 'POST') {
    if (!currentRun) return json(res, 200, { ok: 'nenhum run' }), true;
    currentRun.stopRequested = true;
    currentRun.child.kill('SIGTERM');
    return json(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/context' && req.method === 'GET') {
    return json(res, 200, { docs: loadDocs().map((d) => ({ name: d.name, points: d.points, chars: d.text.length })) }), true;
  }
  if (pathname === '/api/context/doc' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return json(res, 400, { error: 'name obrigatório' }), true;
    const text = body.pdfB64 ? await pdfToText(Buffer.from(body.pdfB64, 'base64')) : String(body.text ?? '');
    if (!text.trim()) return json(res, 400, { error: 'documento vazio (PDF sem camada de texto ou arquivo vazio)' }), true;
    const points = await extractPoints(text);
    const docs = loadDocs().filter((d) => d.name !== body.name);
    docs.push({ name: body.name, text, points });
    saveDocs(docs);
    return json(res, 200, { name: body.name, points, chars: text.length }), true;
  }
  if (pathname === '/api/context/remove' && req.method === 'POST') {
    const body = await readBody(req);
    saveDocs(loadDocs().filter((d) => d.name !== body.name));
    return json(res, 200, { ok: true }), true;
  }
  if (pathname === '/api/context/topics' && req.method === 'POST') {
    const body = await readBody(req);
    const raw = await omlxChat([
      { role: 'system', content: 'Você detecta tópicos técnicos numa fala de entrevista. Responda APENAS com um array JSON de 3 a 5 strings curtas (1-2 palavras).' },
      { role: 'user', content: 'Detecte os tópicos técnicos desta fala:\n\n' + String(body.text ?? '').slice(0, 2000) },
    ], 120);
    return json(res, 200, { topics: parseList(raw) }), true;
  }
  return false;
}

const server = createServer(async (req, res) => {
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

server.listen(PORT, '127.0.0.1', () => console.log(`falador host http://127.0.0.1:${PORT}`));
