// falador-graph — teste de entropia do runId (ADR-012).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistry, runGraph } from '../src/index.ts';

test('runGraph gera runId com entropia (run-<ts>-<sufixo>)', async () => {
  const reg = createRegistry();
  const flow = { version: 1, stopWhenSourcesDone: true, nodes: [], edges: [] };
  const rg = await runGraph(flow, reg);
  await rg.done;
  assert.match(rg.runId, /^run-\d+-[a-z0-9]+$/, `runId malformado: ${rg.runId}`);
});

test('runGraph respeita runId fornecido via opts', async () => {
  const reg = createRegistry();
  const flow = { version: 1, stopWhenSourcesDone: true, nodes: [], edges: [] };
  const rg = await runGraph(flow, reg, { runId: 'run-custom-42' });
  await rg.done;
  assert.equal(rg.runId, 'run-custom-42');
});