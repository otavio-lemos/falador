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
    outputs: (def.outputs ?? []).map((p) => ({ name: p.name, type: p.type })),
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

  const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  let rg;
  try {
    rg = await runGraph(flow, registry);
  } catch (err) {
    line({ type: 'flow_invalid', error: String(err?.message ?? err) });
    process.exit(1);
  }
  (async () => {
    try {
      for await (const ev of rg.events()) line({ ...ev });
    } catch { /* stop encerra o iterador */ }
  })();
  const summary = await rg.done.catch((e) => ({ error: String(e?.message ?? e) }));
  const results = {};
  for (const [id, holder] of collected) {
    results[id] = holder.received
      .map((m) => (m?.control ? undefined : m?.payload))
      .filter((p) => p !== undefined)
      .map((p) => (p instanceof Uint8Array ? `<bytes:${p.byteLength}>` : truncate(p)));
  }
  line({ type: 'summary', summary: { stopped: summary?.stopped ?? true }, results });
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
