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
import { createServer, get as httpGet } from 'node:http';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'packages/falador-cli/run-flow.mjs');
const FLOWS_DIR = join(ROOT, 'apps/tui/flows');
const DIST = join(ROOT, 'apps/web/dist');
const PORT = 8787;

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

let currentRun = null; // { child, clients:Set<res>, stopRequested }

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
