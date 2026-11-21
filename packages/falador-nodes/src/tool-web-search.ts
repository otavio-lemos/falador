// falador-nodes — tool.web_search: pesquisa externa zero-deps com proteção anti-SSRF
import type {
  NodeCtx,
  NodeRuntime,
  NodeTypeDef,
  ParamError,
  ToolCallResult,
  ToolDef,
  ToolProvider,
} from '../../falador-graph/src/index.ts';

const DEFAULT_ENDPOINT = 'https://api.duckduckgo.com/';
const FALLBACK_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS = 4000;

export type FetcherFn = typeof fetch;

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformado → bloqueia
  }
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  const normalized = host.toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '::' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized === '0:0:0:0:0:0:0:0'
  ) {
    return true;
  }
  // IPv4-mapped IPv6 (ex.: ::ffff:127.0.0.1 ou ::ffff:7f00:1)
  if (normalized.startsWith('::ffff:') || normalized.startsWith('0:0:0:0:0:ffff:')) {
    return true;
  }
  // Unique local fc00::/7
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }
  // Link-local fe80::/10
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  // Multicast ff00::/8
  if (normalized.startsWith('ff')) {
    return true;
  }
  return false;
}

export function validateExternalUrl(
  rawUrl: unknown,
): { ok: true; url: URL } | { ok: false; reason: string } {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, reason: 'URL obrigatória e não pode ser vazia.' };
  }
  const clean = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    return { ok: false, reason: `URL inválida: ${clean}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Protocolo não permitido: ${parsed.protocol}` };
  }
  const rawHost = parsed.hostname.toLowerCase();
  // Remove dots finais (FQDN absoluto): `localhost.` resolve para loopback e não pode
  // escapar do bloqueio de `localhost`. O URL parser canonicaliza IPs, mas não nomes.
  const host = (rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost).replace(/\.+$/, '');
  if (!host) {
    return { ok: false, reason: 'Hostname vazio.' };
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return { ok: false, reason: `Host local/interno bloqueado (anti-SSRF): ${host}` };
  }
  if (isPrivateIpv4(host)) {
    return { ok: false, reason: `IPv4 privado/reservado bloqueado (anti-SSRF): ${host}` };
  }
  if (isPrivateIpv6(host)) {
    return { ok: false, reason: `IPv6 privado/loopback bloqueado (anti-SSRF): ${host}` };
  }
  return { ok: true, url: parsed };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function stripHtmlToText(html: string): string {
  // Remove blocos script/style/noscript sem regex com backtracking catastrófico
  let s = html;
  for (const tag of ['script', 'style', 'noscript']) {
    const lowerTagOpen = `<${tag}`;
    const lowerTagClose = `</${tag}>`;
    let out = '';
    let idx = 0;
    const lower = s.toLowerCase();
    while (idx < s.length) {
      const start = lower.indexOf(lowerTagOpen, idx);
      if (start === -1) {
        out += s.slice(idx);
        break;
      }
      out += s.slice(idx, start);
      const end = lower.indexOf(lowerTagClose, start);
      if (end === -1) {
        break;
      }
      idx = end + lowerTagClose.length;
    }
    s = out;
  }

  // Remove tags HTML char-a-char
  let stripped = '';
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '<') {
      inTag = true;
      stripped += ' ';
    } else if (ch === '>') {
      inTag = false;
    } else if (!inTag) {
      stripped += ch;
    }
  }

  return decodeHtmlEntities(stripped).replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = '\n[...truncado]';
  const keep = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, keep)}${suffix}`;
}

interface SearchHit {
  title: string;
  snippet: string;
  url?: string;
}

function parseDdgInstantAnswer(data: unknown, maxResults: number): SearchHit[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as {
    Heading?: unknown;
    AbstractText?: unknown;
    AbstractURL?: unknown;
    Answer?: unknown;
    RelatedTopics?: unknown[];
  };
  const hits: SearchHit[] = [];

  if (typeof obj.Answer === 'string' && obj.Answer.trim()) {
    hits.push({
      title: typeof obj.Heading === 'string' && obj.Heading.trim() ? obj.Heading.trim() : 'Resposta direta',
      snippet: obj.Answer.trim(),
    });
  }
  if (typeof obj.AbstractText === 'string' && obj.AbstractText.trim()) {
    hits.push({
      title: typeof obj.Heading === 'string' && obj.Heading.trim() ? obj.Heading.trim() : 'Resumo',
      snippet: obj.AbstractText.trim(),
      url: typeof obj.AbstractURL === 'string' && obj.AbstractURL.trim() ? obj.AbstractURL.trim() : undefined,
    });
  }

  const collectTopics = (items: unknown[]) => {
    for (const item of items) {
      if (hits.length >= maxResults) return;
      if (!item || typeof item !== 'object') continue;
      const rec = item as { Text?: unknown; FirstURL?: unknown; Topics?: unknown[] };
      if (Array.isArray(rec.Topics)) {
        collectTopics(rec.Topics);
        continue;
      }
      if (typeof rec.Text === 'string' && rec.Text.trim()) {
        const text = rec.Text.trim();
        const dashIdx = text.indexOf(' - ');
        const title = dashIdx > 0 && dashIdx < 100 ? text.slice(0, dashIdx).trim() : text.slice(0, 80);
        const snippet = dashIdx > 0 && dashIdx < 100 ? text.slice(dashIdx + 3).trim() : text;
        hits.push({
          title,
          snippet,
          url: typeof rec.FirstURL === 'string' && rec.FirstURL.trim() ? rec.FirstURL.trim() : undefined,
        });
      }
    }
  };

  if (Array.isArray(obj.RelatedTopics)) {
    collectTopics(obj.RelatedTopics);
  }

  return hits.slice(0, maxResults);
}

function parseDdgHtmlFallback(html: string, maxResults: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split('result__a');
  for (let i = 1; i < blocks.length && hits.length < maxResults; i++) {
    const chunk = blocks[i];
    const gtIdx = chunk.indexOf('>');
    const closeA = chunk.indexOf('</a>', gtIdx + 1);
    if (gtIdx === -1 || closeA === -1) continue;
    const title = stripHtmlToText(chunk.slice(gtIdx + 1, closeA));
    if (!title) continue;

    let url: string | undefined;
    const hrefPrefix = blocks[i - 1];
    const hrefIdx = hrefPrefix.lastIndexOf('href="');
    if (hrefIdx !== -1) {
      const hrefEnd = hrefPrefix.indexOf('"', hrefIdx + 6);
      if (hrefEnd !== -1) {
        const rawHref = hrefPrefix.slice(hrefIdx + 6, hrefEnd);
        if (rawHref.startsWith('http://') || rawHref.startsWith('https://')) {
          url = rawHref;
        }
      }
    }

    let snippet = '';
    const snipIdx = chunk.indexOf('result__snippet');
    if (snipIdx !== -1) {
      const snipGt = chunk.indexOf('>', snipIdx);
      const snipClose = chunk.indexOf('</', snipGt + 1);
      if (snipGt !== -1 && snipClose !== -1) {
        snippet = stripHtmlToText(chunk.slice(snipGt + 1, snipClose));
      }
    }

    hits.push({ title, snippet: snippet || title, url });
  }
  return hits;
}

function formatHits(query: string, hits: SearchHit[], maxChars: number): string {
  if (hits.length === 0) {
    return `Nenhum resultado encontrado para "${query}".`;
  }
  const lines = hits.map((h, idx) => {
    const urlLine = h.url ? `\n   URL: ${h.url}` : '';
    return `${idx + 1}. ${h.title}\n   ${h.snippet}${urlLine}`;
  });
  return truncateText(lines.join('\n\n'), maxChars);
}

async function fetchWithTimeout(
  fetcher: FetcherFn,
  url: string,
  timeoutMs: number,
  signals: AbortSignal[],
): Promise<Response> {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort(new Error(`Timeout após ${timeoutMs} ms`));
  }, timeoutMs);
  timer.unref?.();

  const onAbort = () => ac.abort(new Error('Requisição cancelada'));
  for (const s of signals) {
    if (s.aborted) {
      clearTimeout(timer);
      throw new Error('Requisição cancelada (signal abortado)');
    }
    s.addEventListener('abort', onAbort, { once: true });
  }

  try {
    return await fetcher(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Falador-WebSearch/0.2 (+https://github.com/otaviolemos/falador)',
        Accept: 'application/json, text/html, text/plain;q=0.9',
      },
      redirect: 'error',
      signal: ac.signal,
    });
  } catch (err: unknown) {
    if (timedOut) {
      throw new Error(`Timeout após ${timeoutMs} ms ao consultar ${url}`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
    for (const s of signals) {
      s.removeEventListener('abort', onAbort);
    }
  }
}

export const toolWebSearch: NodeTypeDef = {
  type: 'tool.web_search',
  paramNames: ['endpoint', 'timeoutMs', 'maxResults', 'maxChars'],
  bindingNames: ['__fetcher'],
  inputs: [],
  outputs: [{ name: 'tool', type: 'tool', required: false }],
  validateParams: (p): ParamError[] => {
    const errs: ParamError[] = [];
    if (p.endpoint !== undefined && (typeof p.endpoint !== 'string' || p.endpoint.trim().length === 0)) {
      errs.push({ path: 'params.endpoint', code: 'INVALID_PARAM', message: 'endpoint deve ser string não vazia' });
    }
    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || Number.isNaN(p.timeoutMs) || p.timeoutMs <= 0)) {
      errs.push({ path: 'params.timeoutMs', code: 'INVALID_PARAM', message: 'timeoutMs deve ser número positivo' });
    }
    if (
      p.maxResults !== undefined &&
      (typeof p.maxResults !== 'number' || Number.isNaN(p.maxResults) || p.maxResults <= 0)
    ) {
      errs.push({ path: 'params.maxResults', code: 'INVALID_PARAM', message: 'maxResults deve ser número positivo' });
    }
    if (p.maxChars !== undefined && (typeof p.maxChars !== 'number' || Number.isNaN(p.maxChars) || p.maxChars <= 0)) {
      errs.push({ path: 'params.maxChars', code: 'INVALID_PARAM', message: 'maxChars deve ser número positivo' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const endpoint = ((ctx.params.endpoint as string | undefined) ?? DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
    const rawTimeout = (ctx.params.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(100, rawTimeout), MAX_TIMEOUT_MS);
    const maxResults = Math.max(1, Math.floor((ctx.params.maxResults as number | undefined) ?? DEFAULT_MAX_RESULTS));
    const maxChars = Math.max(100, Math.floor((ctx.params.maxChars as number | undefined) ?? DEFAULT_MAX_CHARS));

    const customFetcher = ctx.bindings?.__fetcher as FetcherFn | undefined;
    const fetcher: FetcherFn = typeof customFetcher === 'function' ? customFetcher : fetch;

    const defs: ToolDef[] = [
      {
        name: 'web_search',
        description: 'Pesquisa externa na web (DuckDuckGo Instant Answer + fallback HTML) para consultar documentação e referências.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Termos da pesquisa.' },
          },
          required: ['query'],
        },
        readonly: true,
        sourceNodeId: ctx.id,
      },
      {
        name: 'web_fetch_doc',
        description: 'Baixa e extrai o texto limpo de uma URL pública (http/https) com proteção anti-SSRF.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL pública http:// ou https:// a consultar.' },
          },
          required: ['url'],
        },
        readonly: true,
        sourceNodeId: ctx.id,
      },
    ];

    const toolProvider: ToolProvider = {
      listTools(): ToolDef[] {
        return defs;
      },

      async invoke(
        toolName: string,
        args: Record<string, unknown>,
        opts: { signal: AbortSignal; runId: string; callerNodeId: string },
      ): Promise<ToolCallResult> {
        const t0 = Date.now();
        if (opts.signal.aborted || ctx.signal.aborted) {
          return {
            ok: false,
            output: 'Pesquisa cancelada (signal abortado).',
            durationMs: Date.now() - t0,
            meta: { interrupted: true },
          };
        }

        if (toolName === 'web_search') {
          const query = typeof args.query === 'string' ? args.query.trim() : '';
          if (!query) {
            return {
              ok: false,
              output: 'Parâmetro "query" é obrigatório e não pode ser vazio.',
              durationMs: Date.now() - t0,
            };
          }

          if (!customFetcher) {
            const epCheck = validateExternalUrl(endpoint);
            if (!epCheck.ok) {
              return {
                ok: false,
                output: `SSRF_BLOCKED: endpoint inválido — ${epCheck.reason}`,
                durationMs: Date.now() - t0,
                meta: { code: 'SSRF_BLOCKED' },
              };
            }
          }

          let searchUrl: URL;
          try {
            searchUrl = new URL(endpoint);
            searchUrl.searchParams.set('q', query);
            searchUrl.searchParams.set('format', 'json');
            searchUrl.searchParams.set('no_html', '1');
            searchUrl.searchParams.set('skip_disambig', '1');
          } catch {
            return {
              ok: false,
              output: `Endpoint de busca inválido: ${endpoint}`,
              durationMs: Date.now() - t0,
            };
          }

          try {
            const res = await fetchWithTimeout(fetcher, searchUrl.toString(), timeoutMs, [opts.signal, ctx.signal]);
            const body = await res.text();
            if (!res.ok) {
              return {
                ok: false,
                output: `Erro HTTP ${res.status} na busca: ${body.slice(0, 300)}`,
                durationMs: Date.now() - t0,
                meta: { status: res.status },
              };
            }

            let hits: SearchHit[] = [];
            try {
              const parsed: unknown = JSON.parse(body);
              hits = parseDdgInstantAnswer(parsed, maxResults);
            } catch {
              hits = parseDdgHtmlFallback(body, maxResults);
            }

            if (hits.length === 0) {
              const fbUrl = new URL(FALLBACK_HTML_ENDPOINT);
              fbUrl.searchParams.set('q', query);
              try {
                const fbRes = await fetchWithTimeout(fetcher, fbUrl.toString(), timeoutMs, [opts.signal, ctx.signal]);
                if (fbRes.ok) {
                  const fbHtml = await fbRes.text();
                  hits = parseDdgHtmlFallback(fbHtml, maxResults);
                }
              } catch {
                /* fallback best-effort */
              }
            }

            const durationMs = Date.now() - t0;
            ctx.metrics.counter('tool.web_search.queries', 1);
            ctx.metrics.timer('tool.web_search.durationMs', durationMs);
            return {
              ok: true,
              output: formatHits(query, hits, maxChars),
              durationMs,
              meta: { query, hits: hits.length },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log('warn', `tool.web_search erro em web_search: ${msg}`);
            return {
              ok: false,
              output: `Erro ao pesquisar: ${msg}`,
              durationMs: Date.now() - t0,
            };
          }
        }

        if (toolName === 'web_fetch_doc') {
          const checked = validateExternalUrl(args.url);
          if (!checked.ok) {
            ctx.metrics.counter('tool.web_search.ssrf_blocked', 1);
            return {
              ok: false,
              output: `SSRF_BLOCKED: ${checked.reason}`,
              durationMs: Date.now() - t0,
              meta: { code: 'SSRF_BLOCKED' },
            };
          }

          try {
            const res = await fetchWithTimeout(fetcher, checked.url.toString(), timeoutMs, [opts.signal, ctx.signal]);
            const raw = await res.text();
            if (!res.ok) {
              return {
                ok: false,
                output: `Erro HTTP ${res.status} ao acessar ${checked.url.toString()}: ${raw.slice(0, 300)}`,
                durationMs: Date.now() - t0,
                meta: { status: res.status, url: checked.url.toString() },
              };
            }
            const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
            const text = contentType.includes('text/html') || raw.includes('<html') ? stripHtmlToText(raw) : raw.trim();
            const durationMs = Date.now() - t0;
            ctx.metrics.counter('tool.web_search.fetches', 1);
            ctx.metrics.timer('tool.web_search.fetchMs', durationMs);
            return {
              ok: true,
              output: truncateText(text, maxChars),
              durationMs,
              meta: { status: res.status, url: checked.url.toString() },
            };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log('warn', `tool.web_search erro em web_fetch_doc: ${msg}`);
            return {
              ok: false,
              output: `Erro ao buscar URL: ${msg}`,
              durationMs: Date.now() - t0,
            };
          }
        }

        return {
          ok: false,
          output: `Tool desconhecida em ${ctx.id}: ${toolName}`,
          durationMs: Date.now() - t0,
        };
      },
    };

    return {
      toolProvider,
      async start() {},
      async onInput() {},
      async stop() {},
    };
  },
};
