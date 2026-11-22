import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRegistry, runGraph, validateFlow, type FlowSpec } from '../../falador-graph/src/index.ts';
import { captureFfmpeg, resolveSounddeviceInput } from '../src/capture-ffmpeg.ts';
import { registerFaladorNodes, type ChatSendFn } from '../src/index.ts';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

test('capture.ffmpeg exporta node type', () => {
  assert.equal(captureFfmpeg.type, 'capture.ffmpeg');
});

test('sounddevice: input vazio usa Microfone; nome explícito é preservado', () => {
  assert.equal(resolveSounddeviceInput(''), 'Microfone');
  assert.equal(resolveSounddeviceInput('   '), 'Microfone');
  assert.equal(resolveSounddeviceInput('Microfone (MacBook Pro)'), 'Microfone (MacBook Pro)');
  assert.equal(resolveSounddeviceInput(':0'), '0');
});

test('capture-sidecar --list devolve JSON de devices de entrada', () => {
  const repoPython = join(REPO_ROOT, '.venv/bin/python');
  const pythonBin = existsSync(repoPython) ? repoPython : '/Users/otaviolemos/ml/falador/.venv/bin/python';
  const sidecarPath = join(REPO_ROOT, 'services/capture-sidecar.py');
  const out = execFileSync(
    pythonBin,
    [sidecarPath, '--list'],
    { encoding: 'utf8', timeout: 10000 },
  );
  const devices = JSON.parse(out) as { id: number; name: string; sampleRate: number }[];
  assert.ok(Array.isArray(devices));
  for (const d of devices) {
    assert.equal(typeof d.id, 'number');
    assert.ok(d.name.trim().length > 0);
    assert.ok(d.sampleRate > 0);
  }
});

test('capture.ffmpeg aceita backend chat, placeholder e initialMessage e rejeita backend inválido', () => {
  assert.equal(captureFfmpeg.outputsFor, undefined);
  assert.deepEqual(
    captureFfmpeg.outputs.map((o) => ({ name: o.name, type: o.type, required: o.required })),
    [
      { name: 'out', type: 'pcm16k', required: false },
      { name: 'out_text', type: 'phrase', required: false },
      { name: 'parcs', type: 'tokens_parcial', required: false },
    ],
  );
  for (const backend of ['ffmpeg', 'sounddevice', 'sck', 'chat'] as const) {
    assert.equal(captureFfmpeg.validateParams!({ backend }).length, 0);
  }
  assert.equal(
    captureFfmpeg.validateParams!({ backend: 'chat', placeholder: 'Digite…', initialMessage: 'Olá' }).length,
    0,
  );

  const badBackend = captureFfmpeg.validateParams!({ backend: 'invalido' });
  assert.ok(badBackend.some((e) => e.path === 'params.backend' && e.code === 'INVALID_PARAM'));

  const badPlaceholder = captureFfmpeg.validateParams!({ placeholder: 123 });
  assert.ok(badPlaceholder.some((e) => e.path === 'params.placeholder' && e.code === 'INVALID_PARAM'));

  const badInitial = captureFfmpeg.validateParams!({ initialMessage: 456 });
  assert.ok(badInitial.some((e) => e.path === 'params.initialMessage' && e.code === 'INVALID_PARAM'));
});

test('capture.ffmpeg com backend chat não spawna binário, registra __registerChatInput e emite out_text e parcs', async () => {
  const reg = registerFaladorNodes(createRegistry());
  let sendChat: ChatSendFn | null = null;
  const phrases: Array<{ text: string; final: boolean; trace?: { turnId?: string; tCaptureMs?: number } }> = [];
  const parcs: Array<{ text: string; final: boolean; trace?: { turnId?: string; tCaptureMs?: number } }> = [];

  const rg = await runGraph(
    {
      version: 1,
      stopWhenSourcesDone: false,
      nodes: [
        {
          id: 'inp',
          type: 'capture.ffmpeg',
          params: {
            backend: 'chat',
            sckPath: '/nao/existe/capture',
            placeholder: 'Prompt…',
            initialMessage: '  Mensagem inicial  ',
          },
        },
        { id: 'cap_p', type: 'sink.captions', params: { mode: 'callback', showParcials: true } },
        { id: 'cap_t', type: 'sink.captions', params: { mode: 'callback', showParcials: true } },
      ],
      edges: [
        { from: 'inp.out_text', to: 'cap_p.phrase', capacity: 8, overflow: 'block' },
        { from: 'inp.parcs', to: 'cap_t.in', capacity: 8, overflow: 'block' },
      ],
      bindings: {
        inp: { __registerChatInput: (fn: ChatSendFn) => { sendChat = fn; } },
        cap_p: { __onCaption: (c: { text: string; final: boolean; trace?: { turnId?: string; tCaptureMs?: number } }) => phrases.push(c) },
        cap_t: { __onCaption: (c: { text: string; final: boolean; trace?: { turnId?: string; tCaptureMs?: number } }) => parcs.push(c) },
      },
    },
    reg,
  );

  for (let i = 0; i < 30 && !sendChat; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(sendChat, 'esperava __registerChatInput registrado');

  await sendChat!('Primeira pergunta');
  await sendChat!('   ');
  await sendChat!('');
  await sendChat!('Segunda pergunta');

  for (let i = 0; i < 50 && (phrases.length < 3 || parcs.length < 3); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(rg.snapshot().nodes.inp.counters['input.chat.messages'], 3);
  await rg.stop('teste');
  await rg.done;

  assert.deepEqual(
    phrases.map((c) => c.text),
    ['Mensagem inicial', 'Primeira pergunta', 'Segunda pergunta'],
  );
  for (const c of phrases) {
    assert.equal(typeof c.trace?.turnId, 'string');
    assert.ok((c.trace?.turnId?.length ?? 0) > 0);
    assert.equal(typeof c.trace?.tCaptureMs, 'number');
  }

  assert.deepEqual(
    parcs.map((c) => ({ text: c.text, final: c.final })),
    [
      { text: 'Mensagem inicial', final: true },
      { text: 'Primeira pergunta', final: true },
      { text: 'Segunda pergunta', final: true },
    ],
  );
  for (const c of parcs) {
    assert.equal(typeof c.trace?.turnId, 'string');
    assert.ok((c.trace?.turnId?.length ?? 0) > 0);
  }

  await sendChat!('após stop');
  assert.equal(phrases.length, 3);
  assert.equal(parcs.length, 3);
});

test('grafo híbrido com um único capture.ffmpeg ligado em out -> asr.in e out_text -> sink.phrase valida em sck, sounddevice e chat', () => {
  const reg = registerFaladorNodes(createRegistry());
  for (const backend of ['sck', 'sounddevice', 'chat'] as const) {
    const flow: FlowSpec = {
      version: 1,
      nodes: [
        { id: 'inp', type: 'capture.ffmpeg', params: { backend } },
        { id: 'asr', type: 'asr.realtime', params: {} },
        { id: 'snk', type: 'sink.captions', params: { mode: 'callback' } },
      ],
      edges: [
        { from: 'inp.out', to: 'asr.in' },
        { from: 'inp.out_text', to: 'snk.phrase' },
      ],
    };
    const validated = validateFlow(flow, reg.asMap());
    assert.equal(validated.nodes.size, 3);
    assert.equal(validated.edges.length, 2);
  }
});
