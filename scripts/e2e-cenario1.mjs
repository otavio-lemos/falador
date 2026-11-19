// e2e-cenario1.mjs — CENÁRIO 1 E2E com mídia real:
//   ffmpeg(BlackHole :0) → asr.realtime (Voxtral streaming) → llm.omlx (EN→PT) → sink no terminal
// O áudio EN é tocado via afplay (Multi-Output → BlackHole). Requer: stack residente (8080/8090).
// Rodar: node scripts/e2e-cenario1.mjs [arquivo-wav-EN]
import { spawn, spawnSync } from 'node:child_process';
import { runGraph, createRegistry } from '../packages/falador-graph/src/index.ts';
import { registerFaladorNodes, VOXTRAL_SNAPSHOT } from '../packages/falador-nodes/src/index.ts';

const WAV = process.argv[2] ?? '/tmp/g3b-en.wav';
const RUN_SECONDS = Number(process.env.E2E_SECONDS ?? 22);
const REF = 'Effective caching in inference engines depends on prefill length, KV layout, and the residency of the model in unified memory.';

const capturas = [];
const traducoes = [];

// sink.captions com callback hiding? Nó sink.captions imprime na máquina; para o experimento
// usamos sinks sintéticos que coletam + logam parciais ao vivo.
const collectCaptions = {
  type: 'coletor.captions', paramNames: [], sink: true,
  inputs: [{ name: 'in', type: 'tokens_parcial' }], outputs: [],
  create: (ctx) => ({
    async start() {},
    async onInput(_p, m) {
      if (m.control) return;
      capturas.push(m.payload);
      const { text, final } = m.payload;
      process.stdout.write(`\r[ASR${final ? ' FINAL' : ''}] ${text.slice(0, 90)}`);
      if (final) process.stdout.write('\n');
    },
    async stop() {},
  }),
};
const collectLLM = {
  type: 'coletor.llm', paramNames: [], sink: true,
  inputs: [{ name: 'parcs', type: 'tokens_parcial' }, { name: 'in', type: 'phrase' }], outputs: [],
  create: (ctx) => ({
    async start() {},
    async onInput(_p, m) {
      if (m.control) return;
      traducoes.push(m.payload);
      const { text, final } = m.payload;
      process.stdout.write(`\r  [PT${final ? ' FINAL' : ''}] ${text.slice(0, 80)}   `);
      if (final) process.stdout.write('\n');
    },
    async stop() {},
  }),
};

const registry = registerFaladorNodes(createRegistry())
  .register(collectCaptions).register(collectLLM);

const flow = {
  version: 1,
  nodes: [
    { id: 'mic', type: 'capture.ffmpeg', params: { input: ':0', chunkMs: 80 } },
    { id: 'asr', type: 'asr.realtime', params: { model: VOXTRAL_SNAPSHOT, serverVad: true, inputRate: 16000 } },
    { id: 'llm', type: 'llm.omlx', params: { baseUrl: 'http://127.0.0.1:8080', system: 'Você traduz LEGENDAS em tempo real de inglês para português. Responda APENAS com a tradução fiel em português, sem comentários.' } },
    { id: 'snk', type: 'coletor.llm' },
  ],
  edges: [
    { from: 'mic.out', to: 'asr.in', capacity: 128, overflow: 'block' },
    { from: 'asr.out', to: 'llm.parcs', capacity: 16, overflow: 'drop_oldest' },
    { from: 'llm.out', to: 'snk.parcs', capacity: 16, overflow: 'drop_oldest' },
  ],
};

console.log(`[e2e] mídia: ${WAV} · run de ${RUN_SECONDS}s`);
console.log('        (o Multi-Output do Audio MIDI Setup deve estar como saída do sistema)');

const rg = await runGraph(flow, registry, { stopWhenSourcesDone: false });
const runner = (async () => { try { for await (const ev of rg.events()) { if (ev.type === 'node_error') console.log('\n[ev]', ev.nodeId, ev.message?.slice(0, 150)); } } catch {} })();

// toca o áudio EN 1,5 s depois da captura abrir
await new Promise((r) => setTimeout(r, 1500));
console.log('\n[e2e] afplay (EN pela Multi-Output)…');
const play = spawn('afplay', [WAV], { stdio: 'ignore' });

await new Promise((r) => setTimeout(r, (RUN_SECONDS - 1.5) * 1000));
await rg.stop('fim do e2e');
play.kill();
void runner;

const lerFinal = (arr) => [...arr].reverse().find((x) => x?.final === true)?.text ?? null;
const asrFinal = lerFinal(capturas);
const ptFinal = lerFinal(traducoes);

const palavras = ['caching', 'inferência', 'memória', 'layout'];
const ptOk = ptFinal && palavras.filter((w) => ptFinal.toLowerCase().includes(w)).length >= 2;
const asrOk = asrFinal && ['caching', 'inference', 'memory'].filter((w) => asrFinal.toLowerCase().includes(w)).length >= 2;

console.log('\n===== RESUMO E2E =====');
console.log(`ASR final  : ${asrFinal ? asrFinal.slice(0, 110) : '—'}`);
console.log(`Tradução   : ${ptFinal ? ptFinal.slice(0, 110) : '—'}`);
console.log(`parciais ASR: ${capturas.length} · parciais LLM: ${traducoes.length}`);
console.log(`ASR com sinal esperado: ${asrOk ? 'SIM' : 'NÃO VERIFICADO'}`);
console.log(`PT legenda coerente   : ${ptOk ? 'SIM' : 'FECHA AQUI'}`);
console.log(`referência: ${REF.slice(0, 90)}…`);
process.exit(asrOk && ptOk ? 0 : 1);
