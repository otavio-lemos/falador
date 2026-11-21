// falador-nodes — input.chat: fonte de texto/prompt interativo (chatbox).
// Permite digitar prompts na UI (LiveView ou BuilderView) e ligar diretamente
// em qualquer nó que receba texto:
//   - out   (phrase):         llm.omlx.in, agent.tools.in, exec.command.in, tts.sts.phrase, sink.captions.phrase
//   - parcs (tokens_parcial): llm.omlx.parcs, agent.tools.parcs, decision.llm.in, human.approve.in, turn.detector.in, sink.captions.in
import type { NodeCtx, NodeRuntime, NodeTypeDef } from '../../falador-graph/src/index.ts';
import { inheritTrace } from './trace.ts';

export type ChatSendFn = (text: string) => Promise<void>;

export const inputChat: NodeTypeDef = {
  type: 'input.chat',
  sourceOnly: true,
  paramNames: ['placeholder', 'initialMessage'],
  bindingNames: ['__registerChatInput'],
  inputs: [],
  outputs: [
    { name: 'out', type: 'phrase', required: false },
    { name: 'parcs', type: 'tokens_parcial', required: false },
  ],
  create: (ctx: NodeCtx): NodeRuntime => {
    const initialMessage =
      typeof ctx.params.initialMessage === 'string' ? ctx.params.initialMessage.trim() : '';

    let stopped = false;

    const emitText = async (raw: string): Promise<void> => {
      if (stopped || ctx.signal.aborted) return;
      const text = raw.trim();
      if (!text) return;
      const meta = inheritTrace(undefined, { tCaptureMs: Date.now() });
      ctx.metrics.counter('input.chat.messages', 1);
      await ctx.emit('out', text, { meta });
      await ctx.emit('parcs', { text, final: true }, { meta });
    };

    const register = ctx.bindings?.__registerChatInput as
      | ((fn: ChatSendFn) => void)
      | undefined;

    return {
      async start(): Promise<void> {
        if (register) register(emitText);
        if (initialMessage) {
          await emitText(initialMessage);
        }
      },
      async onInput(): Promise<void> {},
      async stop(): Promise<void> {
        stopped = true;
      },
    };
  },
};
