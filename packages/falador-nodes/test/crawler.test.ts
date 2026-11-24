import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRegistry, runGraph, type Envelope, type NodeCtx } from '../../falador-graph/src/index.ts';
import {
  extractPageData,
  isDomainAllowed,
  registerFaladorNodes,
  toolCrawler,
  type AgentStepEvent,
  type ChatSendFn,
  type FetcherFn,
} from '../src/index.ts';

function makeDirectCtx(
  id: string,
  params: Record<string, unknown>,
  bindings: Record<string, unknown> = {},
): NodeCtx {
  const ac = new AbortController();
  return {
    id,
    params,
    bindings,
    signal: ac.signal,
    metrics: { counter: () => {}, timer: () => {} },
    log: () => {},
    isCancelled: () => false,
    getTools: () => [],
    emit: async () => {},
    emitControl: () => {},
  };
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

describe('tool.crawler — scraping / crawler BFS zero-deps com anti-SSRF', () => {
  test('CR1: web_scrape extrai título, texto limpo (sem script/style/noscript/svg) e links resolvidos', async () => {
    const reg = registerFaladorNodes(createRegistry());
    assert.ok(reg.get('tool.crawler'), 'tool.crawler deve estar registrado no registry');

    const mockHtml = `<!doctype html>
      <html>
        <head>
          <title>Documentação &amp; Guia</title>
          <style>body { color: red; } .hidden { display: none; }</style>
          <script>const secret = "nao_deve_aparecer"; alert(1);</script>
        </head>
        <body>
          <noscript>Ative JS</noscript>
          <svg><path d="M0 0"/><text>svg_oculto</text></svg>
          <h1>Bem-vindo ao Falador</h1>
          <p>Texto principal com &lt;entidades&gt; &amp; espaços.</p>
          <a href="/docs/intro#sec1">Intro</a>
          <a href="/docs/intro#sec2">Intro duplicado</a>
          <a href="https://docs.example.com/api">API</a>
          <a href="javascript:alert(1)">Ignorar JS</a>
          <a href="#topo">Ignorar ancora</a>
        </body>
      </html>`;

    const extracted = extractPageData(mockHtml, 'https://example.com/start');
    assert.equal(extracted.title, 'Documentação & Guia');
    assert.ok(extracted.text.includes('Bem-vindo ao Falador'));
    assert.ok(extracted.text.includes('Texto principal com <entidades> & espaços.'));
    assert.ok(!extracted.text.includes('nao_deve_aparecer'), 'script deve ser removido');
    assert.ok(!extracted.text.includes('color: red'), 'style deve ser removido');
    assert.ok(!extracted.text.includes('Ative JS'), 'noscript deve ser removido');
    assert.ok(!extracted.text.includes('svg_oculto'), 'svg deve ser removido');
    assert.deepEqual(extracted.links, [
      'https://example.com/docs/intro',
      'https://docs.example.com/api',
    ]);

    const seenHeaders: Array<string | null> = [];
    const seenRedirect: Array<RequestRedirect | undefined> = [];
    const mockFetcher: FetcherFn = async (input, init) => {
      seenRedirect.push(init?.redirect);
      const headers = new Headers(init?.headers);
      seenHeaders.push(headers.get('user-agent'));
      assert.equal(String(input), 'https://example.com/start');
      return htmlResponse(mockHtml);
    };

    const rt = toolCrawler.create(makeDirectCtx('crawler', {}, { __fetcher: mockFetcher }));
    const tp = rt.toolProvider!;
    const tools = tp.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['web_scrape', 'web_crawl'],
    );
    assert.equal(tools[0].readonly, true);
    assert.equal(tools[1].readonly, true);

    const ac = new AbortController();
    const res = await tp.invoke(
      'web_scrape',
      { url: 'https://example.com/start' },
      { signal: ac.signal, runId: 'run-cr1', callerNodeId: 'test' },
    );

    assert.equal(res.ok, true, res.output);
    assert.equal(seenRedirect[0], 'manual');
    assert.equal(seenHeaders[0], 'FaladorCrawler/1.0 (local-on-device)');
    assert.ok(res.output.includes('Título: Documentação & Guia'));
    assert.ok(res.output.includes('URL: https://example.com/start'));
    assert.ok(res.output.includes('Bem-vindo ao Falador'));
    assert.ok(res.output.includes('https://example.com/docs/intro'));
    assert.ok(!res.output.includes('nao_deve_aparecer'));
  });

  test('CR2: web_crawl faz BFS respeitando maxDepth=1, maxPages=3, sameOriginOnly=true e ciclos A<->B', async () => {
    const pages: Record<string, string> = {
      'https://site.example.com/a': `
        <html><head><title>Página A</title></head><body>
          <p>Conteudo A</p>
          <a href="/b">Ir para B</a>
          <a href="/c">Ir para C</a>
          <a href="/d">Ir para D</a>
          <a href="https://externo.example.org/fora">Link Externo</a>
        </body></html>`,
      'https://site.example.com/b': `
        <html><head><title>Página B</title></head><body>
          <p>Conteudo B</p>
          <a href="/a">Voltar para A (ciclo)</a>
          <a href="/profundidade2">Profundidade 2</a>
        </body></html>`,
      'https://site.example.com/c': `
        <html><head><title>Página C</title></head><body>
          <p>Conteudo C</p>
          <a href="/profundidade2">Profundidade 2</a>
        </body></html>`,
      'https://site.example.com/d': `
        <html><head><title>Página D</title></head><body><p>Conteudo D</p></body></html>`,
      'https://site.example.com/profundidade2': `
        <html><head><title>Profundidade 2</title></head><body><p>Nao deveria visitar</p></body></html>`,
      'https://externo.example.org/fora': `
        <html><head><title>Externo</title></head><body><p>Fora da origem</p></body></html>`,
    };

    const visitedCalls: string[] = [];
    const mockFetcher: FetcherFn = async (input) => {
      const url = String(input);
      visitedCalls.push(url);
      const html = pages[url];
      if (!html) return new Response('Not Found', { status: 404 });
      return htmlResponse(html);
    };

    const rt = toolCrawler.create(
      makeDirectCtx(
        'crawler',
        { maxPages: 3, maxDepth: 1, sameOriginOnly: true },
        { __fetcher: mockFetcher },
      ),
    );
    const tp = rt.toolProvider!;
    const ac = new AbortController();

    // Mesmo pedindo maxPages=10 e maxDepth=3 nos args, nunca pode exceder os limites do nó (3 e 1)
    const res = await tp.invoke(
      'web_crawl',
      { url: 'https://site.example.com/a', maxPages: 10, maxDepth: 3 },
      { signal: ac.signal, runId: 'run-cr2', callerNodeId: 'test' },
    );

    assert.equal(res.ok, true, res.output);
    assert.deepEqual(visitedCalls, [
      'https://site.example.com/a',
      'https://site.example.com/b',
      'https://site.example.com/c',
    ]);
    assert.ok(res.output.includes('Página A'));
    assert.ok(res.output.includes('Página B'));
    assert.ok(res.output.includes('Página C'));
    assert.ok(!res.output.includes('Página D'), 'deve respeitar maxPages=3');
    assert.ok(!res.output.includes('Nao deveria visitar'), 'deve respeitar maxDepth=1');
    assert.ok(!res.output.includes('Fora da origem'), 'deve ignorar origem externa');

    // Garante também que sem limite de maxPages=3 (ex.: maxPages=10, maxDepth=1) profundidade 2 continua bloqueada
    visitedCalls.length = 0;
    const rtDepth = toolCrawler.create(
      makeDirectCtx(
        'crawler-depth',
        { maxPages: 10, maxDepth: 1, sameOriginOnly: true },
        { __fetcher: mockFetcher },
      ),
    );
    const resDepth = await rtDepth.toolProvider!.invoke(
      'web_crawl',
      { url: 'https://site.example.com/a' },
      { signal: ac.signal, runId: 'run-cr2b', callerNodeId: 'test' },
    );
    assert.equal(resDepth.ok, true);
    assert.ok(!visitedCalls.includes('https://site.example.com/profundidade2'), 'maxDepth=1 não deve visitar depth 2');
    assert.ok(!visitedCalls.includes('https://externo.example.org/fora'), 'sameOriginOnly=true deve ignorar externo');
    assert.equal(visitedCalls.filter((u) => u === 'https://site.example.com/a').length, 1, 'não deve revisitar A em ciclo');
  });

  test('CR3 (Adversarial): bloqueia SSRF, domínio fora de allowedDomains e HTTP 302 redirect', async () => {
    let fetcherCalled = 0;
    const failIfCalledFetcher: FetcherFn = async () => {
      fetcherCalled++;
      throw new Error('Fetcher não deveria ser chamado para URL bloqueada');
    };

    const rt = toolCrawler.create(makeDirectCtx('crawler', {}, { __fetcher: failIfCalledFetcher }));
    const tp = rt.toolProvider!;
    const ac = new AbortController();
    const opts = { signal: ac.signal, runId: 'run-cr3', callerNodeId: 'test' };

    const ssrfUrls = [
      'http://127.0.0.1:8080',
      'http://localhost:8787',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1',
      'file:///etc/passwd',
    ];

    for (const url of ssrfUrls) {
      const res = await tp.invoke('web_scrape', { url }, opts);
      assert.equal(res.ok, false, `URL SSRF deveria ser bloqueada: ${url}`);
      assert.ok(res.output.includes('SSRF_BLOCKED'), `Esperava SSRF_BLOCKED para ${url}, veio: ${res.output}`);
    }
    assert.equal(fetcherCalled, 0, 'Fetcher nunca deve ser invocado em URLs SSRF');

    // allowedDomains
    assert.equal(isDomainAllowed('https://docs.example.com/a', ['example.com']), true);
    assert.equal(isDomainAllowed('https://example.com/a', ['example.com']), true);
    assert.equal(isDomainAllowed('https://evil-example.com/a', ['example.com']), false);
    assert.equal(isDomainAllowed('https://other.org/a', ['example.com']), false);

    const rtAllowed = toolCrawler.create(
      makeDirectCtx(
        'crawler-allowed',
        { allowedDomains: ['example.com'] },
        { __fetcher: failIfCalledFetcher },
      ),
    );
    const blockedDomain = await rtAllowed.toolProvider!.invoke(
      'web_scrape',
      { url: 'https://forbidden.org/page' },
      opts,
    );
    assert.equal(blockedDomain.ok, false);
    assert.ok(blockedDomain.output.includes('DOMAIN_NOT_ALLOWED'));
    assert.equal(fetcherCalled, 0);

    // Bloqueio de HTTP 302 redirect (verifica redirect:'error' e resposta 302)
    let seenRedirectOpt: RequestRedirect | undefined;
    const redirectFetcher: FetcherFn = async (_input, init) => {
      seenRedirectOpt = init?.redirect;
      return new Response('', {
        status: 302,
        headers: { location: 'http://127.0.0.1:8080/internal' },
      });
    };
    const rtRedir = toolCrawler.create(makeDirectCtx('crawler-redir', {}, { __fetcher: redirectFetcher }));
    const redirRes = await rtRedir.toolProvider!.invoke(
      'web_scrape',
      { url: 'https://example.com/redirect-me' },
      opts,
    );
    assert.equal(seenRedirectOpt, 'manual', 'fetch deve usar redirect: "manual"');
    assert.equal(redirRes.ok, false);
    assert.ok(redirRes.output.includes('REDIRECT_BLOCKED'), `Esperava REDIRECT_BLOCKED, veio: ${redirRes.output}`);
  });

  test('CR4: modo linear (in -> out com trace), integração com agent.tools e cancelamento via interrupt', async () => {
    // 1) Modo linear (URL direta + JSON) com trace preservado
    const linearFetcher: FetcherFn = async (input) => {
      const u = String(input);
      if (u === 'https://docs.example.com/') {
        return htmlResponse('<html><head><title>Home</title></head><body><p>Guia inicial</p><a href="/sub">Sub</a></body></html>');
      }
      if (u === 'https://docs.example.com/sub') {
        return htmlResponse('<html><head><title>Sub</title></head><body><p>Detalhes tecnicos</p></body></html>');
      }
      return new Response('Not found', { status: 404 });
    };

    const emitted: Array<{ port: string; payload: unknown; meta?: Record<string, unknown> }> = [];
    const baseCtx = makeDirectCtx('crawler-lin', { maxPages: 3, maxDepth: 1 }, { __fetcher: linearFetcher });
    const linCtx: NodeCtx = {
      ...baseCtx,
      emit: async (port, payload, opts) => {
        emitted.push({ port, payload, meta: opts?.meta as Record<string, unknown> | undefined });
      },
    };
    const linRt = toolCrawler.create(linCtx);

    const envDirect: Envelope = {
      seq: 1,
      ts: Date.now(),
      payload: 'https://docs.example.com/',
      meta: { trace: { turnId: 'turn-cr4-1' } },
    };
    await linRt.onInput('in', envDirect);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].port, 'out');
    assert.ok(String(emitted[0].payload).includes('Guia inicial'));
    assert.ok(String(emitted[0].payload).includes('Detalhes tecnicos'));
    const trace1 = emitted[0].meta?.trace as { turnId?: string; tExecStartMs?: number; tExecEndMs?: number } | undefined;
    assert.equal(trace1?.turnId, 'turn-cr4-1');
    assert.equal(typeof trace1?.tExecStartMs, 'number');
    assert.equal(typeof trace1?.tExecEndMs, 'number');

    // JSON input com maxDepth: 0
    const envJson: Envelope = {
      seq: 2,
      ts: Date.now(),
      payload: JSON.stringify({ url: 'https://docs.example.com/', maxPages: 2, maxDepth: 0 }),
      meta: { trace: { turnId: 'turn-cr4-2' } },
    };
    await linRt.onInput('in', envJson);
    assert.equal(emitted.length, 2);
    assert.ok(String(emitted[1].payload).includes('Guia inicial'));
    assert.ok(!String(emitted[1].payload).includes('Detalhes tecnicos'), 'maxDepth=0 no JSON deve parar na página inicial');

    // 2) Cancelamento via interrupt no modo linear
    let abortedInFetch = false;
    const slowFetcher: FetcherFn = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal;
        if (sig?.aborted) {
          abortedInFetch = true;
          reject(new Error('Aborted'));
          return;
        }
        sig?.addEventListener(
          'abort',
          () => {
            abortedInFetch = true;
            reject(new Error('Aborted'));
          },
          { once: true },
        );
      });

    const emittedAbort: unknown[] = [];
    const abortBase = makeDirectCtx('crawler-abort', { timeoutMs: 10000 }, { __fetcher: slowFetcher });
    const abortRt = toolCrawler.create({
      ...abortBase,
      emit: async (_p, payload) => {
        emittedAbort.push(payload);
      },
    });
    const pendingInput = abortRt.onInput('in', {
      seq: 3,
      ts: Date.now(),
      payload: 'https://docs.example.com/',
    });
    await new Promise((r) => setTimeout(r, 20));
    abortRt.onControl?.({ kind: 'interrupt', reason: 'barge-in' });
    await pendingInput;
    assert.equal(abortedInFetch, true, 'interrupt deve abortar o fetch em andamento');
    assert.equal(emittedAbort.length, 0, 'interrupt não deve emitir saída');

    // 3) Integração como ToolProvider no agent.tools via runGraph
    let llmCall = 0;
    let sawCrawlerTools = false;
    const mockOmlx = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          tools?: Array<{ function: { name: string } }>;
          messages?: Array<{ role: string; content?: string }>;
        };
        llmCall++;
        const toolNames = (body.tools ?? []).map((t) => t.function.name);
        if (toolNames.includes('web_scrape') && toolNames.includes('web_crawl')) {
          sawCrawlerTools = true;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (llmCall === 1) {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_scrape_1',
                        type: 'function',
                        function: {
                          name: 'web_scrape',
                          arguments: JSON.stringify({ url: 'https://docs.example.com/' }),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
          );
          return;
        }
        const toolMsg = body.messages?.find((m) => m.role === 'tool');
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: `Resumo obtido: ${toolMsg?.content?.includes('Guia inicial') ? 'OK' : 'FALHA'}`,
                },
              },
            ],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => mockOmlx.listen(0, '127.0.0.1', () => resolve()));
    const addr = mockOmlx.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const reg = registerFaladorNodes(createRegistry());
      const finals: string[] = [];
      const steps: AgentStepEvent[] = [];
      let sendChat: ChatSendFn | undefined;

      const run = await runGraph(
        {
          version: 1,
          stopWhenSourcesDone: false,
          nodes: [
            { id: 'chat', type: 'input.chat', params: {} },
            {
              id: 'crawler',
              type: 'tool.crawler',
              params: { maxPages: 3, maxDepth: 1, sameOriginOnly: true },
            },
            {
              id: 'agent',
              type: 'agent.tools',
              params: {
                baseUrl,
                model: 'mock-model',
                approvalPolicy: 'never',
                maxSteps: 3,
              },
            },
            { id: 'cap', type: 'sink.captions', params: { mode: 'callback', showParcials: false } },
          ],
          edges: [
            { from: 'chat.out', to: 'agent.in', capacity: 8, overflow: 'block' },
            { from: 'crawler.tool', to: 'agent.tools', capacity: 4, overflow: 'block' },
            { from: 'agent.out', to: 'cap.in', capacity: 8, overflow: 'block' },
          ],
          bindings: {
            chat: {
              __registerChatInput: (fn: ChatSendFn) => {
                sendChat = fn;
              },
            },
            crawler: { __fetcher: linearFetcher },
            agent: { __onAgentStep: (ev: AgentStepEvent) => steps.push(ev) },
            cap: {
              __onCaption: (c: { text: string; final: boolean }) => {
                if (c.final) finals.push(c.text);
              },
            },
          },
        },
        reg,
      );

      assert.ok(sendChat, '__registerChatInput deve estar registrado');
      await sendChat!('Raspe https://docs.example.com/');

      for (let i = 0; i < 100 && finals.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }

      await run.stop('fim-teste');
      await run.done;

      assert.equal(sawCrawlerTools, true, 'agent.tools deve receber web_scrape e web_crawl do tool.crawler');
      assert.ok(steps.some((s) => s.tool === 'web_scrape' && s.phase === 'result' && s.ok === true));
      assert.equal(finals.length, 1);
      assert.equal(finals[0], 'Resumo obtido: OK');
    } finally {
      await new Promise<void>((resolve) => mockOmlx.close(() => resolve()));
    }
  });
});
