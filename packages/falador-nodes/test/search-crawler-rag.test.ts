import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { NodeCtx } from '../../falador-graph/src/index.ts';
import { chunkDocument, searchChunks, tokenize, type ContextDocument } from '../src/context-store.ts';
import { ragSearch } from '../src/rag-search.ts';
import { extractPageData, stripTagsToText, toolCrawler } from '../src/tool-crawler.ts';
import {
  decodeDdgRedirectUrl,
  parseDdgHtmlFallback,
  parseSearxngJson,
  toolWebSearch,
  validateExternalUrlWithDns,
  type DnsLookupFn,
  type FetcherFn,
} from '../src/tool-web-search.ts';

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

describe('P2 — Busca Web Real (SearXNG + DDG), Crawler com Código & RAG Técnico', () => {
  test('1. parseSearxngJson e provider=searxng / provider=auto com fallback para DDG HTML', async () => {
    const parsed = parseSearxngJson(
      {
        answers: ['42'],
        results: [
          {
            title: 'Nginx &amp; Reverse Proxy',
            url: 'https://nginx.org/en/docs/',
            content: 'Documentação oficial do Nginx.',
          },
          {
            title: 'Ignorar JS',
            url: 'javascript:alert(1)',
            content: 'Sem URL http/https',
          },
        ],
      },
      5,
    );
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].snippet, '42');
    assert.equal(parsed[1].title, 'Nginx & Reverse Proxy');
    assert.equal(parsed[1].url, 'https://nginx.org/en/docs/');
    assert.equal(parsed[2].url, undefined);

    // provider='auto' usando SEARXNG_URL do ambiente quando SearXNG responde 200 JSON
    const prevEnv = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = 'http://core.searxng.orb.local:8888';
    try {
      const seenUrls: string[] = [];
      const sxFetcher: FetcherFn = async (input) => {
        const u = String(input);
        seenUrls.push(u);
        return new Response(
          JSON.stringify({
            results: [
              {
                title: 'SearXNG Hit',
                url: 'https://docs.example.com/nginx',
                content: 'Resultado vindo do SearXNG local.',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };

      const rt = toolWebSearch.create(makeDirectCtx('ws-sx', { provider: 'auto' }, { __fetcher: sxFetcher }));
      const res = await rt.toolProvider!.invoke(
        'web_search',
        { query: 'nginx 502' },
        { signal: new AbortController().signal, runId: 'r-sx1', callerNodeId: 'test' },
      );
      assert.equal(res.ok, true, res.output);
      assert.equal((res.meta as { provider?: string }).provider, 'searxng');
      assert.match(seenUrls[0], /^http:\/\/core\.searxng\.orb\.local:8888\/search\?q=nginx\+502&format=json$/);
      assert.match(res.output, /SearXNG Hit/);
      assert.match(res.output, /https:\/\/docs\.example\.com\/nginx/);
    } finally {
      if (prevEnv === undefined) delete process.env.SEARXNG_URL;
      else process.env.SEARXNG_URL = prevEnv;
    }

    // provider='auto' faz fallback limpo para DDG HTML quando SearXNG falha (502 / unreachable)
    const fallbackCalls: string[] = [];
    const ddgHtml = `
      <div class="result">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnginx.org%2Fen%2Fdocs%2F&amp;rut=abc">Nginx <b>Docs</b></a>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnginx.org%2Fen%2Fdocs%2F">Configure <b>upstream</b> timeouts and <b>proxy_pass</b> properly.</a>
      </div>`;

    const fallbackFetcher: FetcherFn = async (input) => {
      const u = String(input);
      fallbackCalls.push(u);
      if (u.includes('core.searxng.orb.local')) {
        throw new Error('ECONNREFUSED');
      }
      if (u.includes('api.duckduckgo.com')) {
        return new Response(JSON.stringify({ AbstractText: '', RelatedTopics: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('html.duckduckgo.com')) {
        return new Response(ddgHtml, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('Not found', { status: 404 });
    };

    const rtFb = toolWebSearch.create(
      makeDirectCtx('ws-fb', { provider: 'auto' }, { __fetcher: fallbackFetcher }),
    );
    const fbRes = await rtFb.toolProvider!.invoke(
      'web_search',
      { query: 'nginx upstream' },
      { signal: new AbortController().signal, runId: 'r-sx2', callerNodeId: 'test' },
    );
    assert.equal(fbRes.ok, true, fbRes.output);
    assert.equal((fbRes.meta as { provider?: string }).provider, 'ddg');
    assert.ok(fallbackCalls.some((u) => u.includes('core.searxng.orb.local/search')));
    assert.ok(fallbackCalls.some((u) => u.includes('html.duckduckgo.com/html/')));
    assert.match(fbRes.output, /https:\/\/nginx\.org\/en\/docs\//);
    assert.match(fbRes.output, /Configure upstream timeouts and proxy_pass properly\./);
  });

  test('2. DDG HTML: decodifica uddg= e preserva snippets completos com tags inline <b>...</b>', () => {
    assert.equal(
      decodeDdgRedirectUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=123'),
      'https://example.com/a?x=1',
    );
    assert.equal(
      decodeDdgRedirectUrl('/l/?uddg=https%3A%2F%2Fexample.com%2Fb'),
      'https://example.com/b',
    );
    assert.equal(decodeDdgRedirectUrl('https://direct.example.com/page'), 'https://direct.example.com/page');

    const html = `
      <div class="results">
        <div class="result">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F&amp;rut=99">Node.js <b>API</b> Reference</a>
          </h2>
          <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2F">Read <b>Node.js</b> v26 docs for <b>fetch</b> and <b>fs</b> modules.</a>
        </div>
        <div class="result">
          <a class="result__a" href="https://example.org/plain">Plain Link</a>
          <div class="result__snippet">First part <b>bold</b> and <i>italic</i> end.</div>
        </div>
      </div>
    `;

    const hits = parseDdgHtmlFallback(html, 5);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].title, 'Node.js API Reference');
    assert.equal(hits[0].url, 'https://nodejs.org/api/');
    assert.equal(hits[0].snippet, 'Read Node.js v26 docs for fetch and fs modules.');
    assert.equal(hits[1].title, 'Plain Link');
    assert.equal(hits[1].url, 'https://example.org/plain');
    assert.equal(hits[1].snippet, 'First part bold and italic end.');
  });

  test('3. web_fetch_doc: segue redirects seguros até 3 saltos, bloqueia >3 saltos e rejeita SSRF via DNS', async () => {
    const publicDns: DnsLookupFn = async () => [{ address: '93.184.216.34', family: 4 }];
    const privateDns: DnsLookupFn = async (host) =>
      host === 'evil-rebind.example.com'
        ? [{ address: '10.0.0.5', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];

    // Validação direta de DNS anti-SSRF
    const dnsOk = await validateExternalUrlWithDns('https://example.com/docs', { dnsLookup: publicDns });
    assert.equal(dnsOk.ok, true);
    const dnsPrivate = await validateExternalUrlWithDns('https://evil-rebind.example.com/secret', {
      dnsLookup: privateDns,
    });
    assert.equal(dnsPrivate.ok, false);
    if (!dnsPrivate.ok) {
      assert.match(dnsPrivate.reason, /IP privado/i);
    }

    // 2 saltos válidos (status 301 -> 302 -> 200)
    const visited: string[] = [];
    const redirectFetcher: FetcherFn = async (input, init) => {
      assert.equal(init?.redirect, 'manual');
      const u = String(input);
      visited.push(u);
      if (u === 'https://example.com/step0') {
        return new Response('', { status: 301, headers: { location: '/step1' } });
      }
      if (u === 'https://example.com/step1') {
        return new Response('', { status: 302, headers: { location: 'https://docs.example.com/final' } });
      }
      if (u === 'https://docs.example.com/final') {
        return new Response('<html><body><h1>Final Doc</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (u.startsWith('https://example.com/loop')) {
        const n = Number(u.replace('https://example.com/loop', '')) || 0;
        return new Response('', { status: 302, headers: { location: `https://example.com/loop${n + 1}` } });
      }
      if (u === 'https://example.com/to-private') {
        return new Response('', { status: 302, headers: { location: 'https://evil-rebind.example.com/admin' } });
      }
      return new Response('Not found', { status: 404 });
    };

    const rt = toolWebSearch.create(
      makeDirectCtx('ws-redir', {}, { __fetcher: redirectFetcher, __dnsLookup: privateDns }),
    );
    const opts = { signal: new AbortController().signal, runId: 'r-wf1', callerNodeId: 'test' };

    const okRes = await rt.toolProvider!.invoke('web_fetch_doc', { url: 'https://example.com/step0' }, opts);
    assert.equal(okRes.ok, true, okRes.output);
    assert.match(okRes.output, /Final Doc/);
    assert.equal((okRes.meta as { url?: string }).url, 'https://docs.example.com/final');
    assert.deepEqual(visited, [
      'https://example.com/step0',
      'https://example.com/step1',
      'https://docs.example.com/final',
    ]);

    // Mais de 3 saltos bloqueado
    const tooManyRes = await rt.toolProvider!.invoke('web_fetch_doc', { url: 'https://example.com/loop0' }, opts);
    assert.equal(tooManyRes.ok, false);
    assert.match(tooManyRes.output, /REDIRECT_BLOCKED/);

    // Redirect que resolve via DNS para 10.0.0.5 é bloqueado sem fazer fetch no alvo privado
    const countBeforePrivate = visited.length;
    const ssrfRedir = await rt.toolProvider!.invoke('web_fetch_doc', { url: 'https://example.com/to-private' }, opts);
    assert.equal(ssrfRedir.ok, false);
    assert.match(ssrfRedir.output, /SSRF_BLOCKED/);
    assert.equal(visited.length, countBeforePrivate + 1);
    assert.ok(!visited.includes('https://evil-rebind.example.com/admin'));
  });

  test('4. tool.crawler: redirects seguros, anti-SSRF via DNS, maxBytes e preservação de <pre><code>', async () => {
    // 4a. stripTagsToText remove nav/header/footer/script/style e preserva <pre><code> com indentação e quebras de linha
    const htmlWithCode = `
      <html>
        <head>
          <style>.x { color: red; }</style>
          <script>console.log("hidden")</script>
        </head>
        <body>
          <header>Site Header Menu</header>
          <nav><a href="/a">Nav Link</a></nav>
          <main>
            <h1>Guia Nginx</h1>
            <p>Use o bloco abaixo com <code>nginx -t</code> antes de recarregar.</p>
            <pre><code class="language-nginx">server {
    listen 80;
    location / {
        proxy_pass http://127.0.0.1:8080;
    }
}</code></pre>
            <p>Depois rode:</p>
            <pre>systemctl reload nginx
systemctl status nginx</pre>
          </main>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;

    const cleaned = stripTagsToText(htmlWithCode);
    assert.ok(!cleaned.includes('Site Header Menu'), 'header deve ser removido');
    assert.ok(!cleaned.includes('Nav Link'), 'nav deve ser removido');
    assert.ok(!cleaned.includes('Copyright 2026'), 'footer deve ser removido');
    assert.ok(!cleaned.includes('console.log'), 'script deve ser removido');
    assert.ok(!cleaned.includes('color: red'), 'style deve ser removido');
    assert.ok(cleaned.includes('`nginx -t`'), 'code inline deve ser preservado');
    assert.ok(
      cleaned.includes('```nginx\nserver {\n    listen 80;\n    location / {\n        proxy_pass http://127.0.0.1:8080;\n    }\n}\n```'),
      `Bloco <pre><code class="language-nginx"> deve preservar quebras e indentação. Obtido:\n${cleaned}`,
    );
    assert.ok(
      cleaned.includes('```\nsystemctl reload nginx\nsystemctl status nginx\n```'),
      `Bloco <pre> simples deve virar fence Markdown. Obtido:\n${cleaned}`,
    );

    const extracted = extractPageData(htmlWithCode, 'https://docs.example.com/nginx');
    assert.ok(extracted.text.includes('```nginx\nserver {'));

    // 4b. Redirects seguros + bloqueio DNS privado + limite maxBytes em stream
    let canceledLargeStream = false;
    const dnsFn: DnsLookupFn = async (host) =>
      host === 'internal-dns.example.com'
        ? [{ address: '192.168.1.50', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];

    const crawlerFetcher: FetcherFn = async (input, init) => {
      assert.equal(init?.redirect, 'manual');
      const u = String(input);
      if (u === 'https://docs.example.com/old') {
        return new Response('', { status: 301, headers: { location: 'https://docs.example.com/new' } });
      }
      if (u === 'https://docs.example.com/new') {
        return new Response('<html><title>Nova</title><body><p>Conteúdo após redirect</p></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (u === 'https://docs.example.com/to-internal-dns') {
        return new Response('', { status: 302, headers: { location: 'https://internal-dns.example.com/panel' } });
      }
      if (u === 'https://docs.example.com/huge') {
        const chunk = new TextEncoder().encode('A'.repeat(1024));
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= 10) {
              controller.close();
              return;
            }
            sent++;
            controller.enqueue(chunk);
          },
          cancel() {
            canceledLargeStream = true;
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
      }
      return new Response('Not found', { status: 404 });
    };

    const rt = toolCrawler.create(
      makeDirectCtx('cr-p2', { maxBytes: 2048 }, { __fetcher: crawlerFetcher, __dnsLookup: dnsFn }),
    );
    const opts = { signal: new AbortController().signal, runId: 'r-cr-p2', callerNodeId: 'test' };

    const redirOk = await rt.toolProvider!.invoke('web_scrape', { url: 'https://docs.example.com/old' }, opts);
    assert.equal(redirOk.ok, true, redirOk.output);
    assert.match(redirOk.output, /Conteúdo após redirect/);
    assert.equal((redirOk.meta as { url?: string }).url, 'https://docs.example.com/new');

    const redirSsrf = await rt.toolProvider!.invoke(
      'web_scrape',
      { url: 'https://docs.example.com/to-internal-dns' },
      opts,
    );
    assert.equal(redirSsrf.ok, false);
    assert.match(redirSsrf.output, /REDIRECT_BLOCKED/);
    assert.match(redirSsrf.output, /IP privado/i);

    const hugeRes = await rt.toolProvider!.invoke('web_scrape', { url: 'https://docs.example.com/huge' }, opts);
    assert.equal(hugeRes.ok, true, hugeRes.output);
    assert.equal(canceledLargeStream, true, 'Stream deve ser cancelado ao atingir maxBytes');
  });

  test('5. RAG: tokenização técnica, FALADOR_CONTEXT_DIR e fallback não-destrutivo de defaultTags', async () => {
    // 5a. Tokenização preserva flags CLI, IPs, paths, versões e termos com hífen
    const tokens = tokenize('Execute --dry-run em 10.0.0.1 lendo /etc/nginx na versão 0.8.0 (anti-ssrf)');
    assert.ok(tokens.includes('--dry-run'), `Esperado --dry-run em ${JSON.stringify(tokens)}`);
    assert.ok(tokens.includes('10.0.0.1'), `Esperado 10.0.0.1 em ${JSON.stringify(tokens)}`);
    assert.ok(tokens.includes('/etc/nginx'), `Esperado /etc/nginx em ${JSON.stringify(tokens)}`);
    assert.ok(tokens.includes('0.8.0'), `Esperado 0.8.0 em ${JSON.stringify(tokens)}`);
    assert.ok(tokens.includes('anti-ssrf'), `Esperado anti-ssrf em ${JSON.stringify(tokens)}`);

    const docTech: ContextDocument = {
      id: 'd-tech',
      name: 'ops-cli.md',
      tags: ['infra'],
      addedAt: '2026-11-23T00:00:00.000Z',
      points: [],
      chunks: chunkDocument(
        'ops-cli.md',
        '# Deploy\nRode com --dry-run apontando para 10.0.0.1 e confira /etc/nginx na versão 0.8.0.',
        { tags: ['infra'] },
      ),
    };
    const docOther: ContextDocument = {
      id: 'd-other',
      name: 'other.md',
      tags: ['infra'],
      addedAt: '2026-11-23T00:00:00.000Z',
      points: [],
      chunks: chunkDocument('other.md', '# Outro\nDeploy simples sem flags ou ip.', { tags: ['infra'] }),
    };

    const hitsTech = searchChunks([docOther, docTech], '--dry-run /etc/nginx 10.0.0.1', { topK: 1 });
    assert.equal(hitsTech.length, 1);
    assert.equal(hitsTech[0].docName, 'ops-cli.md');

    // 5b. FALADOR_CONTEXT_DIR + fallback não-destrutivo de defaultTags
    const tmpDir = mkdtempSync(join(tmpdir(), 'falador-rag-ctx-'));
    const prevCtxDir = process.env.FALADOR_CONTEXT_DIR;
    try {
      const docs: ContextDocument[] = [
        {
          id: 'd-1',
          name: 'sre.md',
          tags: ['sre', 'linux'],
          addedAt: '2026-11-23T00:00:00.000Z',
          points: [],
          chunks: chunkDocument('sre.md', '# Nginx\nVerifique /etc/nginx com --dry-run no host 10.0.0.1.', {
            tags: ['sre', 'linux'],
          }),
        },
      ];
      writeFileSync(join(tmpDir, 'docs.json'), JSON.stringify(docs), 'utf8');
      process.env.FALADOR_CONTEXT_DIR = tmpDir;

      // Nó configurado com defaultTags=['ti'] que não bate com ['sre', 'linux']
      const rt = ragSearch.create(makeDirectCtx('rag-env', { tags: ['ti'], topK: 2 }));
      const opts = { signal: new AbortController().signal, runId: 'r-rag-env', callerNodeId: 'test' };

      // Sem args.tags: faz fallback não-destrutivo sobre todos os docs
      const fbRes = await rt.toolProvider!.invoke('search_docs', { query: '/etc/nginx --dry-run' }, opts);
      assert.equal(fbRes.ok, true, fbRes.output);
      assert.equal((fbRes.meta as { hits: number }).hits, 1);
      assert.equal((fbRes.meta as { tagFallback?: boolean }).tagFallback, true);
      assert.match(fbRes.output, /\/etc\/nginx/);

      // Com args.tags explícito que não existe: mantém filtro estrito (0 hits)
      const strictRes = await rt.toolProvider!.invoke(
        'search_docs',
        { query: '/etc/nginx --dry-run', tags: ['inexistente'] },
        opts,
      );
      assert.equal(strictRes.ok, true);
      assert.equal((strictRes.meta as { hits: number }).hits, 0);
      assert.equal((strictRes.meta as { tagFallback?: boolean }).tagFallback, false);
    } finally {
      if (prevCtxDir === undefined) delete process.env.FALADOR_CONTEXT_DIR;
      else process.env.FALADOR_CONTEXT_DIR = prevCtxDir;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
