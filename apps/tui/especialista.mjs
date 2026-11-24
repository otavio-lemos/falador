#!/usr/bin/env node
// especialista.mjs — CLI dedicada ao workflow "especialista-ti"
// Renderiza em tempo real: conversa, pensamento, passos, comandos, output, gates.
// Entrada: chat livre; quando um gate aparece, o prompt muda para aprovação.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Carrega .env.falador (OMLX_API_KEY) se existir
try {
  const text = readFileSync(join(ROOT, '.env.falador'), 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!m || process.env[m[1]]) continue;
    const v = m[2].replace(/^['"]|['"]$/g, '').trim();
    if (v) process.env[m[1]] = v;
  }
} catch {}
const RUNNER = join(ROOT, 'packages', 'falador-cli', 'run-flow.mjs');
const FLOW = join(ROOT, 'apps', 'tui', 'flows', 'especialista-ti.json');

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', italic: '\x1b[3m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
  bgYellow: '\x1b[43m',
};

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let mode = 'chat'; // 'chat' | 'gate'
let activeGate = null;
const gateQueue = [];

function ts() { return new Date().toLocaleTimeString('pt-BR', { hour12: false }); }
function hr(ch = '─', n = 90) { return c.gray + ch.repeat(n) + c.reset; }

function prompt() {
  if (mode === 'gate' && activeGate) {
    rl.setPrompt(`${c.yellow}  gate[${activeGate.nodeId}] a/e/r/cmd > ${c.reset}`);
  } else {
    rl.setPrompt(`${c.cyan}  você > ${c.reset}`);
  }
  rl.prompt();
}

function render(ev) {
  switch (ev.type) {
    case 'run_started':
      console.log(hr('═'));
      console.log(`${c.bold}${c.cyan}  FALADOR · ESPECIALISTA DE TI${c.reset}   ${c.gray}${ts()}${c.reset}`);
      console.log(hr('═'));
      break;
    case 'caption': {
      const who = ev.kind === 'stt' ? '🎙 STT' : '🤖';
      const color = ev.final ? c.green : c.gray;
      process.stdout.write(`\r${c.dim}[${ts()}]${c.reset} ${color}${who}${c.reset} ${ev.text}${ev.final ? '\n' : ''}`);
      if (ev.final) prompt();
      break;
    }
    case 'thought':
      console.log(`${c.magenta}  💭 [${ts()}] ${ev.nodeId ?? 'agente'}:${c.reset} ${c.dim}${ev.text}${c.reset}`);
      break;
    case 'agent_step':
      console.log(`${c.blue}  ▸ [${ts()}] step ${ev.step ?? '?'} ${ev.phase ?? ''}${ev.tool ? ' (' + ev.tool + ')' : ''}${ev.durationMs ? c.gray + ' ' + ev.durationMs + 'ms' + c.reset : ''}${c.reset}`);
      if (ev.args) console.log(`${c.gray}      args: ${JSON.stringify(ev.args).slice(0, 400)}${c.reset}`);
      if (ev.ok === false) console.log(`${c.red}      ✗ ${ev.error ?? 'falhou'}${c.reset}`);
      break;
    case 'execution':
      console.log(`${c.yellow}  ⚙ [${ts()}] ${ev.nodeId ?? 'exec'}${ev.host ? ' @' + ev.host : ''}${ev.dryRun ? ' (dry-run)' : ''}${c.reset}`);
      if (ev.command) console.log(`${c.gray}      $ ${ev.command}${c.reset}`);
      if (ev.output) console.log(ev.output.split('\n').map(l => `${c.gray}      ${l}${c.reset}`).join('\n'));
      if (typeof ev.exitCode === 'number') console.log(`${ev.exitCode === 0 ? c.green : c.red}      exit=${ev.exitCode}${ev.timedOut ? ' (timeout)' : ''}${c.reset}`);
      break;
    case 'gate': {
      gateQueue.push(ev);
      if (!activeGate) processGate(ev);
      break;
    }
    case 'gate_cancelled':
      console.log(`${c.gray}  [gate ${ev.nodeId} cancelado: ${ev.reason}]${c.reset}`);
      break;
    case 'gate_rejected':
      console.log(`${c.red}  [gate ${ev.nodeId} rejeitado: ${ev.text}]${c.reset}`);
      break;
    case 'chat_sent':
      console.log(`${c.cyan}  📨 [${ts()}] ${ev.nodeId}: ${ev.text}${c.reset}`);
      break;
    case 'audit':
      if (ev.op === 'gate' || ev.op === 'chat_input') {
        console.log(`${c.dim}  📋 audit#${ev.seq} ${ev.op} ${ev.nodeId ?? ''} ${ev.gate ?? ''}${c.reset}`);
      }
      break;
    case 'node_error':
      console.log(`${c.red}  ❌ node_error ${ev.nodeId ?? ''}: ${ev.error ?? ev.message ?? ''}${c.reset}`);
      break;
    case 'flow_invalid':
      console.log(`${c.red}  ❌ flow_invalid: ${ev.error}${c.reset}`);
      break;
    case 'edge_overflow':
      console.log(`${c.yellow}  ⚠ edge_overflow ${ev.from}→${ev.to}${c.reset}`);
      break;
    case 'run_stopped':
      console.log(`${c.gray}  [run_stopped: ${ev.reason ?? 'ok'}]${c.reset}`);
      break;
    case 'summary':
      console.log(hr('═'));
      console.log(`${c.bold}${c.green}  FIM DO RUN${c.reset}`);
      break;
    default:
      break;
  }
}

function processGate(ev) {
  activeGate = ev;
  mode = 'gate';
  console.log(hr('─'));
  console.log(`${c.bold}${c.yellow}  ⛔ GATE DE APROVAÇÃO — ${ev.nodeId}${c.reset}`);
  if (ev.text) console.log(`${c.yellow}     ${ev.text}${c.reset}`);
  const meta = ev.meta || {};
  if (meta.command) console.log(`${c.gray}     comando: ${meta.command}${c.reset}`);
  if (meta.host) console.log(`${c.gray}     host: ${meta.host}${c.reset}`);
  if (meta.reason) console.log(`${c.gray}     motivo: ${meta.reason}${c.reset}`);
  console.log(`${c.bold}  [a]provar  [e]ditar  [r]ejeitar  (ou digite comando)${c.reset}`);
  prompt();
}

function sendGate(text) {
  child.stdin.write(JSON.stringify({ type: 'gate_action', nodeId: activeGate.nodeId, text }) + '\n');
  activeGate = null;
  mode = 'chat';
  const next = gateQueue.shift();
  if (next && next !== activeGate) processGate(next);
  prompt();
}

const child = spawn('node', [RUNNER, FLOW], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });

let buf = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try { render(JSON.parse(line)); } catch { console.log(line); }
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => {
  console.log(hr('═'));
  console.log(`${c.gray}  processo encerrado (exit ${code})${c.reset}`);
  process.exit(code ?? 0);
});

rl.on('line', (line) => {
  const text = line.trim();
  if (!text) { prompt(); return; }
  if (text === '/quit' || text === '/exit') { child.kill('SIGINT'); return; }
  if (mode === 'gate' && activeGate) {
    const a = text.toLowerCase();
    const meta = activeGate.meta || {};
    if (a === 'r' || a === 'rejeitar') {
      rl.question(`${c.yellow}  motivo da rejeição: ${c.reset}`, (mot) => {
        child.stdin.write(JSON.stringify({ type: 'gate_action', nodeId: activeGate.nodeId, text: null, rejectionText: mot.trim() }) + '\n');
        activeGate = null; mode = 'chat';
        const next = gateQueue.shift();
        if (next) processGate(next); else prompt();
      });
      return;
    }
    if (a === 'e' || a === 'editar') {
      const cmd = meta.command ?? '';
      rl.question(`${c.yellow}  comando editado [${cmd}]: ${c.reset}`, (edited) => {
        sendGate((edited.trim() || cmd));
      });
      return;
    }
    if (a === 'a' || a === 'aprovar') {
      sendGate(meta.command ?? activeGate.text ?? '');
      return;
    }
    // raw input treated as approved command
    sendGate(text);
    return;
  }
  // chat mode
  child.stdin.write(JSON.stringify({ type: 'chat_input', text }) + '\n');
  console.log(`${c.cyan}  👤 você: ${text}${c.reset}`);
  prompt();
});

console.log(`${c.dim}  Chat livre. /quit para sair. Gates: a/e/r ou comando direto.${c.reset}`);
prompt();
