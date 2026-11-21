// falador-cli — runner headless de fluxo (host oficialmente consumido pela TUI, pela web e pela CI)
// Uso:
//   node run-flow.mjs --catalog                       → catálogo JSON (defs registradas)
//   node run-flow.mjs <flow.json> [--no-bindings]     → roda o fluxo; eventos NDJSON no stdout
// Eventos NDJSON (uma linha por evento):
//   {"type":"run_started",...} / node_error / edge_overflow / run_stopped
//   {"type":"result",...} no fim (payloads coletados por sink.collect, truncados)
// Stdout é 100% NDJSON (logs do server ficam no stderr do spawn da TUI).
import { createRegistry, runGraph, sourceTone, pipeDelay, pipeParcs, sinkCollect } from '../falador-graph/src/index.ts';
import { registerFaladorNodes } from '../falador-nodes/src/index.ts';

function buildRegistry() {
  return registerFaladorNodes(createRegistry())
    .register(sourceTone)
    .register(pipeDelay)
    .register(pipeParcs)
    .register(sinkCollect);
}

function defToCatalog(def) {
  return {
    type: def.type,
    sourceOnly: def.sourceOnly === true,
    paramNames: def.paramNames ?? [],
    inputs: (def.inputs ?? []).map((p) => ({ name: p.name, type: p.type })),
    outputs: (def.outputs ?? []).map((p) => ({ name: p.name, type: p.type, required: p.required !== false })),
    // saídas dinâmicas por instância (ex.: decision.llm → porta por opção)
    dynamicOutputs: typeof def.outputsFor === 'function',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const registry = buildRegistry();

  if (args.includes('--catalog')) {
    const catalog = [];
    for (const [type, def] of registry.asMap()) catalog.push(defToCatalog(def));
    console.log(JSON.stringify({ type: 'catalog', nodes: catalog }));
    return;
  }

  const flowPath = args.find((a) => !a.startsWith('--'));
  if (!flowPath) {
    console.error('uso: node run-flow.mjs <flow.json> | --catalog');
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const flow = JSON.parse(readFileSync(flowPath, 'utf-8'));

  // binding automático: todo sink.collect no fluxo coleta para o runner
  const collected = new Map(); // nodeId -> { received: [] }
  for (const n of flow.nodes ?? []) {
    if (n.type === 'sink.collect' && !(n.bindings?.__collect)) {
      collected.set(n.id, { received: [] });
    }
  }
  flow.bindings = { ...(flow.bindings ?? {}) };
  for (const [id, holder] of collected) {
    flow.bindings[id] = { ...(flow.bindings[id] ?? {}), __collect: holder };
  }

  // binding automático de legenda: sink.captions sem __onCaption emite eventos NDJSON
  // {"type":"caption","nodeId","text","final","trace"?} — assim a TUI/web recebem a legenda ao vivo
  // mesmo rodando headless (sem poluir o stdout servido para o host).
  for (const n of flow.nodes ?? []) {
    if (n.type === 'sink.captions' && !(flow.bindings[n.id]?.__onCaption)) {
      flow.bindings[n.id] = {
        ...(flow.bindings[n.id] ?? {}),
        __onCaption: (cap) => line({
          type: 'caption',
          nodeId: n.id,
          text: cap.text,
          final: cap.final,
          ...(cap.trace ? { trace: cap.trace } : {}),
        }),
      };
    }
  }

  // reset de histórico em runtime para nós llm.omlx e agent.tools (ADR-006 Fase 4 / ADR-008 Fase 5)
  const resetters = new Map(); // nodeId -> () => void
  // chatbox interativo (input.chat): envia prompts digitados para os nós input.chat
  const chatSenders = new Map(); // nodeId -> (text: string) => Promise<void>
  for (const n of flow.nodes ?? []) {
    if (n.type === 'llm.omlx' || n.type === 'agent.tools') {
      flow.bindings[n.id] = {
        ...(flow.bindings[n.id] ?? {}),
        __registerReset: (fn) => { resetters.set(n.id, fn); },
      };
    }
    if (n.type === 'agent.tools' && !(flow.bindings[n.id]?.__onAgentStep)) {
      flow.bindings[n.id] = {
        ...(flow.bindings[n.id] ?? {}),
        __onAgentStep: (ev) => line({ type: 'agent_step', ...ev }),
      };
    }
    if (n.type === 'input.chat' && !(flow.bindings[n.id]?.__registerChatInput)) {
      flow.bindings[n.id] = {
        ...(flow.bindings[n.id] ?? {}),
        __registerChatInput: (fn) => { chatSenders.set(n.id, fn); },
      };
    }
  }

  // gates human.approve e agent.tools (quando approvalPolicy !== 'never'):
  // runner cria holder por nó, anuncia {"type":"gate","nodeId","text","meta"?} e
  // resolve via stdin JSON {"type":"gate_action","nodeId","text"} (null = rejeitar).
  const gates = new Map(); // nodeId -> resolve
  const pendingGates = new Set(); // resolvers abertos (reject all no stop do run)
  for (const n of flow.nodes ?? []) {
    const needsGate =
      n.type === 'human.approve' ||
      (n.type === 'agent.tools' && n.params?.approvalPolicy !== 'never');
    if (needsGate) {
      flow.bindings[n.id] = {
        ...(flow.bindings[n.id] ?? {}),
        __gate: {
          request: (text, meta) =>
            new Promise((resolve) => {
              const res = (t) => { pendingGates.delete(res); resolve(typeof t === 'string' ? t : null); };
              pendingGates.add(res);
              gates.set(n.id, res);
              const ev = { type: 'gate', nodeId: n.id, text };
              if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
                ev.meta = meta;
              }
              line(ev);
            }),
          cancel: (reason) => {
            gates.delete(n.id);
            line({ type: 'gate_cancelled', nodeId: n.id, reason: reason ?? 'interrupted' });
          },
        },
      };
    }
  }
  // stop do run nunca pode pendurar num gate sem resposta: resolve tudo como rejeições
  const rejectPendingGates = () => { for (const res of [...pendingGates]) res(null); };
  // Sinal do host (SIGTERM em POST /api/stop) ou Ctrl-C: parar o grafo DE VERDADE.
  // Sem rg.stop() os nós nunca rodam seu stop() e os children (capture-sck,
  // ffmpeg, sidecars) ficam ÓRFÃOS capturando para sempre (12+ acumulados).
  // `rg` é atribuído mais abaixo (runGraph é async): declará-lo AQUI deixa o
  // closure enxergar a instância real.
  let rg;
  let stoppingOnSignal = false;
  const shutdownOnSignal = (sig) => {
    if (stoppingOnSignal) return;
    stoppingOnSignal = true;
    rejectPendingGates();
    const finish = () => {
      try { process.exit(0); } catch { /* já saindo */ }
    };
    // rede de segurança: stop() que pendure não pode deixar o host esperando
    const safety = setTimeout(finish, 2500);
    safety.unref?.();
    Promise.resolve()
      .then(() => rg?.stop?.(`sinal ${sig}`))
      .catch(() => {})
      .then(() => { clearTimeout(safety); finish(); });
  };
  process.on('SIGTERM', () => shutdownOnSignal('SIGTERM'));
  process.on('SIGINT', () => shutdownOnSignal('SIGINT'));
  let stdinBuf = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (d) => {
    stdinBuf += d;
    let idx;
    while ((idx = stdinBuf.indexOf('\n')) >= 0) {
      const l = stdinBuf.slice(0, idx).trim();
      stdinBuf = stdinBuf.slice(idx + 1);
      if (!l) continue;
      try {
        const m = JSON.parse(l);
        if (m.type === 'gate_action' && gates.has(m.nodeId)) {
          gates.get(m.nodeId)(typeof m.text === 'string' ? m.text : null);
          gates.delete(m.nodeId);
        } else if (m.type === 'reset_history') {
          const target = typeof m.nodeId === 'string' && m.nodeId.trim() ? m.nodeId.trim() : '*';
          if (target === '*') {
            for (const fn of resetters.values()) fn();
          } else if (resetters.has(target)) {
            resetters.get(target)();
          }
          line({ type: 'history_reset', nodeId: target });
        } else if (m.type === 'chat_input' && typeof m.text === 'string') {
          const text = m.text.trim();
          if (!text) continue;
          const target = typeof m.nodeId === 'string' && m.nodeId.trim() ? m.nodeId.trim() : '*';
          if (target === '*') {
            for (const [id, fn] of chatSenders.entries()) {
              Promise.resolve(fn(text)).catch(() => {});
              line({ type: 'chat_sent', nodeId: id, text });
            }
          } else if (chatSenders.has(target)) {
            Promise.resolve(chatSenders.get(target)(text)).catch(() => {});
            line({ type: 'chat_sent', nodeId: target, text });
          }
        }
      } catch { /* linha inválida: ignora */ }
    }
  });

  const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  // --run-seconds N: fonte contínua (mic/BlackHole) não "esgota" — o host pede stop programático
  const runSecondsArg = args.find((a) => a === '--run-seconds');
  const runSeconds = runSecondsArg ? Number(args[args.indexOf('--run-seconds') + 1]) : 0;
  try {
    rg = await runGraph(flow, registry);
  } catch (err) {
    line({ type: 'flow_invalid', error: String(err?.message ?? err) });
    process.exit(1);
  }
  // fase 3: métricas por nó AO VIVO (1 Hz) — o snapshot final também vai no summary.
  const metricsTimer = setInterval(() => line({ type: 'metrics', snapshot: rg.snapshot() }), 1000);
  metricsTimer.unref?.();
  if (runSeconds > 0) {
    setTimeout(() => { rejectPendingGates(); void rg.stop(`run-seconds ${runSeconds}`); }, runSeconds * 1000).unref?.();
  }
  (async () => {
    try {
      for await (const ev of rg.events()) line({ ...ev });
    } catch { /* stop encerra o iterador */ }
  })();
  const summary = await rg.done.catch((e) => ({ error: String(e?.message ?? e) }));
  clearInterval(metricsTimer);
  const results = {};
  for (const [id, holder] of collected) {
    results[id] = holder.received
      .map((m) => (m?.control ? undefined : m?.payload))
      .filter((p) => p !== undefined)
      .map((p) => (p instanceof Uint8Array ? `<bytes:${p.byteLength}>` : truncate(p)));
  }
  line({ type: 'summary', summary: { stopped: summary?.stopped ?? true, metrics: rg.snapshot() }, results });
}

function truncate(p) {
  try {
    // audio_chunk {data: Uint8Array} → resumo rico em vez de mapa numérico
    if (p && typeof p === 'object' && p.data instanceof Uint8Array) {
      const { data, ...rest } = p;
      return JSON.stringify({ ...rest, data: `<bytes:${data.byteLength}>` });
    }
    const s = typeof p === 'string' ? p : JSON.stringify(p);
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  } catch {
    return String(p);
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(1);
});
