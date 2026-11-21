import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRegistry, runGraph } from '../../falador-graph/src/index.ts';
import { registerFaladorNodes, type ChatSendFn } from '../src/index.ts';

describe('input.chat — componente de entrada por texto/prompt', () => {
  test('CH1: emite em out (phrase) e parcs (tokens_parcial final) via __registerChatInput e encerra limpo no stop()', async () => {
    const reg = registerFaladorNodes(createRegistry());
    let sendChat: ChatSendFn | null = null;
    const phrases: Array<{ text: string; final: boolean; trace?: unknown }> = [];
    const parcs: Array<{ text: string; final: boolean; trace?: unknown }> = [];

    const rg = await runGraph(
      {
        version: 1,
        stopWhenSourcesDone: false,
        nodes: [
          { id: 'chat', type: 'input.chat', params: { placeholder: 'Digite aqui…' } },
          { id: 'cap_p', type: 'sink.captions', params: { mode: 'callback', showParcials: true } },
          { id: 'cap_t', type: 'sink.captions', params: { mode: 'callback', showParcials: true } },
        ],
        edges: [
          { from: 'chat.out', to: 'cap_p.phrase', capacity: 8, overflow: 'block' },
          { from: 'chat.parcs', to: 'cap_t.in', capacity: 8, overflow: 'block' },
        ],
        bindings: {
          chat: { __registerChatInput: (fn: ChatSendFn) => { sendChat = fn; } },
          cap_p: { __onCaption: (c: { text: string; final: boolean; trace?: unknown }) => phrases.push(c) },
          cap_t: { __onCaption: (c: { text: string; final: boolean; trace?: unknown }) => parcs.push(c) },
        },
      },
      reg,
    );

    // aguarda registro do callback
    for (let i = 0; i < 20 && !sendChat; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(sendChat, 'esperava __registerChatInput registrado');

    await sendChat!('Verificar disco do servidor');
    await sendChat!('   '); // vazio ignorado
    await sendChat!('Listar containers ativos');

    await new Promise((r) => setTimeout(r, 40));
    await rg.stop('teste');
    await rg.done;

    assert.equal(phrases.length, 2);
    assert.equal(phrases[0].text, 'Verificar disco do servidor');
    assert.equal(phrases[1].text, 'Listar containers ativos');
    assert.ok((phrases[0].trace as { turnId?: string })?.turnId, 'deve propagar trace.turnId');

    assert.equal(parcs.length, 2);
    assert.equal(parcs[0].text, 'Verificar disco do servidor');
    assert.equal(parcs[0].final, true);
    assert.equal(parcs[1].text, 'Listar containers ativos');
  });

  test('CH2: integra input.chat -> llm.omlx (mock SSE) -> sink.captions', async () => {
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        const userMsg = parsed.messages.at(-1)?.content ?? '';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `Echo: ${userMsg}` } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;

    try {
      const reg = registerFaladorNodes(createRegistry());
      const finals: string[] = [];

      const rg = await runGraph(
        {
          version: 1,
          stopWhenSourcesDone: true,
          nodes: [
            { id: 'chat', type: 'input.chat', params: { initialMessage: 'Qual o status da API?' } },
            { id: 'llm', type: 'llm.omlx', params: { baseUrl: `http://127.0.0.1:${port}`, enableThinking: false } },
            { id: 'cap', type: 'sink.captions', params: { mode: 'callback', showParcials: false } },
          ],
          edges: [
            { from: 'chat.out', to: 'llm.in', capacity: 8, overflow: 'block' },
            { from: 'llm.out', to: 'cap.in', capacity: 8, overflow: 'block' },
          ],
          bindings: {
            cap: { __onCaption: (c: { text: string; final: boolean }) => { if (c.final) finals.push(c.text); } },
          },
        },
        reg,
      );
      await rg.done;
      assert.deepEqual(finals, ['Echo: Qual o status da API?']);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
