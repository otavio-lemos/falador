// falador-nodes — tool.web_search: pesquisa externa zero-deps (SearXNG + DDG) com proteção anti-SSRF
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
const DEFAULT_SEARXNG_URL = 'http://core.searxng.orb.local';
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_MAX_CHARS = 4000;
export const MAX_REDIRECTS = 3;

export type FetcherFn = typeof fetch;
export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string; family?: number }>>;
export type WebSearchProvider = 'searxng' | 'ddg' | 'auto';
export type SafeFetchErrorCode =
  | 'SSRF_BLOCKED'
  | 'REDIRECT_BLOCKED'
  | 'DOMAIN_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'FETCH_ERROR';

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  readonly isRedirect: boolean;

  constructor(code: SafeFetchErrorCode, message: string, isRedirect = false) {
    super(message);
    this.name = 'SafeFetchError';
    this.code = code;
    this.isRedirect = isRedirect;
  }
}

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

export function isPrivateIp(ip: string): boolean {
  const clean = (ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip).trim().toLowerCase();
  if (!clean) return true;
  if (clean.includes(':')) return isPrivateIpv6(clean);
  return isPrivateIpv4(clean);
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

export async function validateExternalUrlWithDns(
  rawUrl: unknown,
  opts?: { dnsLookup?: DnsLookupFn; skipDns?: boolean },
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  const base = validateExternalUrl(rawUrl);
  if (!base.ok) return base;
  if (opts?.skipDns) return base;

  const rawHost = base.url.hostname.toLowerCase();
  const host = (rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost).replace(/\.+$/, '');
  if (isIP(host) !== 0) {
    return base;
  }

  const lookupFn: DnsLookupFn = opts?.dnsLookup ?? ((h: string) => dnsLookup(h, { all: true }));
  let records: Array<{ address: string; family?: number }>;
  try {
    records = await lookupFn(host);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Falha ao resolver DNS (anti-SSRF) para ${host}: ${msg}` };
  }

  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: `DNS não retornou endereços (anti-SSRF) para ${host}` };
  }

  for (const rec of records) {
    if (!rec?.address || isPrivateIp(rec.address)) {
      return {
        ok: false,
        reason: `DNS resolveu para IP privado/reservado bloqueado (anti-SSRF): ${host} -> ${rec?.address ?? '(vazio)'}`,
      };
    }
  }

  return base;
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

export interface SearchHit {
  title: string;
  snippet: string;
  url?: string;
}

export function parseSearxngJson(data: unknown, maxResults: number): SearchHit[] {
  if (!data || typeof data !== 'object') return [];
  const obj = data as {
    answers?: unknown[];
    results?: unknown[];
  };
  const hits: SearchHit[] = [];

  if (Array.isArray(obj.answers)) {
    for (const ans of obj.answers) {
      if (hits.length >= maxResults) break;
      if (typeof ans === 'string' && ans.trim()) {
        hits.push({
          title: 'Resposta direta',
          snippet: ans.trim(),
        });
      }
    }
  }

  if (Array.isArray(obj.results)) {
    for (const item of obj.results) {
      if (hits.length >= maxResults) break;
      if (!item || typeof item !== 'object') continue;
      const rec = item as {
        title?: unknown;
        url?: unknown;
        content?: unknown;
        snippet?: unknown;
      };
      const rawTitle = typeof rec.title === 'string' ? decodeHtmlEntities(rec.title).trim() : '';
      const rawUrl = typeof rec.url === 'string' ? rec.url.trim() : '';
      const rawContent =
        typeof rec.content === 'string'
          ? decodeHtmlEntities(rec.content).trim()
          : typeof rec.snippet === 'string'
            ? decodeHtmlEntities(rec.snippet).trim()
            : '';

      const title = rawTitle || rawUrl;
      if (!title) continue;

      let url: string | undefined;
      if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
        url = rawUrl;
      }

      hits.push({
        title,
        snippet: rawContent || title,
        url,
      });
    }
  }

  return hits.slice(0, maxResults);
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

export function decodeDdgRedirectUrl(rawHref: string): string | undefined {
  const clean = decodeHtmlEntities(rawHref).trim();
  if (!clean) return undefined;

  if (clean.startsWith('http://') || clean.startsWith('https://')) {
    try {
      const parsed = new URL(clean);
      if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
        const uddg = parsed.searchParams.get('uddg');
        if (uddg && (uddg.startsWith('http://') || uddg.startsWith('https://'))) {
          return uddg;
        }
      }
      return clean;
    } catch {
      return undefined;
    }
  }

  if (clean.startsWith('//') || clean.startsWith('/l/')) {
    try {
      const base = clean.startsWith('//') ? `https:${clean}` : `https://duckduckgo.com${clean}`;
      const parsed = new URL(base);
      const uddg = parsed.searchParams.get('uddg');
      if (uddg && (uddg.startsWith('http://') || uddg.startsWith('https://'))) {
        return uddg;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function findMatchingTagClose(html: string, tagName: string, contentStart: number): number {
  const lower = html.toLowerCase();
  const openToken = `<${tagName}`;
  const closeToken = `</${tagName}>`;
  let depth = 1;
  let pos = contentStart;

  while (pos < html.length) {
    const nextOpen = lower.indexOf(openToken, pos);
    const nextClose = lower.indexOf(closeToken, pos);
    if (nextClose === -1) return -1;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      const chAfter = lower[nextOpen + openToken.length];
      if (!chAfter || /[\s>/]/.test(chAfter)) {
        depth++;
      }
      pos = nextOpen + openToken.length;
    } else {
      depth--;
      if (depth === 0) return nextClose;
      pos = nextClose + closeToken.length;
    }
  }

  return -1;
}

export function parseDdgHtmlFallback(html: string, maxResults: number): SearchHit[] {
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
    const preAttr = blocks[i - 1];
    const postAttr = chunk.slice(0, gtIdx);
    const openAnchorPre = preAttr.slice(Math.max(0, preAttr.lastIndexOf('<a')));
    const attrZone = `${openAnchorPre} ${postAttr}`;
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrZone);
    if (hrefMatch) {
      url = decodeDdgRedirectUrl(hrefMatch[1] ?? hrefMatch[2] ?? '');
    }

    let snippet = '';
    const snipIdx = chunk.indexOf('result__snippet');
    if (snipIdx !== -1) {
      const snipGt = chunk.indexOf('>', snipIdx);
      if (snipGt !== -1) {
        const tagOpenIdx = chunk.lastIndexOf('<', snipIdx);
        let tagName = '';
        if (tagOpenIdx !== -1) {
          const m = /^<([a-z0-9]+)/i.exec(chunk.slice(tagOpenIdx, snipIdx));
          if (m) tagName = m[1].toLowerCase();
        }
        const snipClose = tagName
          ? findMatchingTagClose(chunk, tagName, snipGt + 1)
          : chunk.indexOf('</', snipGt + 1);
        if (snipClose !== -1) {
          snippet = stripHtmlToText(chunk.slice(snipGt + 1, snipClose));
        }
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

async function fetchSingleWithTimeout(
  fetcher: FetcherFn,
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
  signals: AbortSignal[],
): Promise<Response> {
  const ac = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort(new Error(`Timeout após ${timeoutMs} ms`));
  }, timeoutMs);
  timer.unref?.();

  const onAbort = () => {
    externallyAborted = true;
    ac.abort(new Error('Requisição cancelada'));
  };
  for (const s of signals) {
    if (s.aborted) {
      clearTimeout(timer);
      throw new SafeFetchError('ABORTED', 'Requisição cancelada (signal abortado)');
    }
    s.addEventListener('abort', onAbort, { once: true });
  }

  try {
    return await fetcher(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: ac.signal,
    });
  } catch (err: unknown) {
    if (timedOut) {
      throw new SafeFetchError('TIMEOUT', `Timeout após ${timeoutMs} ms ao consultar ${url}`);
    }
    if (externallyAborted || signals.some((s) => s.aborted)) {
      throw new SafeFetchError('ABORTED', 'Requisição cancelada');
    }
    if (err instanceof SafeFetchError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const isRedirect = msg.toLowerCase().includes('redirect');
    throw new SafeFetchError(isRedirect ? 'REDIRECT_BLOCKED' : 'FETCH_ERROR', msg, isRedirect);
  } finally {
    clearTimeout(timer);
    for (const s of signals) {
      s.removeEventListener('abort', onAbort);
    }
  }
}

export async function fetchWithSafeRedirects(opts: {
  fetcher: FetcherFn;
  url: string;
  timeoutMs: number;
  headers: Record<string, string>;
  signals: AbortSignal[];
  maxRedirects?: number;
  dnsLookup?: DnsLookupFn;
  skipDns?: boolean;
  allowInternalHost?: boolean;
  validateRedirectUrl?: (
    nextUrl: URL,
  ) => { ok: true } | { ok: false; code: 'SSRF_BLOCKED' | 'DOMAIN_NOT_ALLOWED' | 'REDIRECT_BLOCKED'; reason: string };
}): Promise<{ response: Response; finalUrl: string }> {
  const maxRedirects = Math.max(0, Math.floor(opts.maxRedirects ?? MAX_REDIRECTS));
  let currentUrl = opts.url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsedUrl: URL;
    if (opts.allowInternalHost) {
      try {
        parsedUrl = new URL(currentUrl);
      } catch {
        throw new SafeFetchError('SSRF_BLOCKED', `URL inválida: ${currentUrl}`, hop > 0);
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new SafeFetchError('SSRF_BLOCKED', `Protocolo não permitido: ${parsedUrl.protocol}`, hop > 0);
      }
    } else {
      const checked = await validateExternalUrlWithDns(currentUrl, {
        dnsLookup: opts.dnsLookup,
        skipDns: opts.skipDns,
      });
      if (!checked.ok) {
        throw new SafeFetchError('SSRF_BLOCKED', checked.reason, hop > 0);
      }
      parsedUrl = checked.url;
    }

    if (hop > 0 && opts.validateRedirectUrl) {
      const v = opts.validateRedirectUrl(parsedUrl);
      if (!v.ok) {
        throw new SafeFetchError(v.code, v.reason, true);
      }
    }

    const res = await fetchSingleWithTimeout(
      opts.fetcher,
      parsedUrl.toString(),
      opts.timeoutMs,
      opts.headers,
      opts.signals,
    );

    if (res.status >= 300 && res.status < 400) {
      res.body?.cancel?.().catch(() => {});
      const location = res.headers.get('location');
      if (!location || !location.trim()) {
        throw new SafeFetchError(
          'REDIRECT_BLOCKED',
          `HTTP ${res.status} sem header Location em ${parsedUrl.toString()}`,
          true,
        );
      }
      if (hop >= maxRedirects) {
        throw new SafeFetchError(
          'REDIRECT_BLOCKED',
          `Limite de ${maxRedirects} redirects excedido a partir de ${opts.url}`,
          true,
        );
      }
      try {
        currentUrl = new URL(location.trim(), parsedUrl).toString();
      } catch {
        throw new SafeFetchError('REDIRECT_BLOCKED', `Location inválida no redirect: ${location}`, true);
      }
      continue;
    }

    return { response: res, finalUrl: parsedUrl.toString() };
  }

  throw new SafeFetchError('REDIRECT_BLOCKED', `Limite de ${maxRedirects} redirects excedido`, true);
}

function buildSearxngSearchUrl(baseUrl: string, query: string): URL {
  const u = new URL(baseUrl);
  const path = u.pathname.replace(/\/+$/, '');
  if (!path.endsWith('/search')) {
    u.pathname = `${path}/search`;
  }
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'json');
  return u;
}

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Falador-WebSearch/0.2 (+https://github.com/otaviolemos/falador)',
  Accept: 'application/json, text/html, text/plain;q=0.9',
};

export const toolWebSearch: NodeTypeDef = {
  type: 'tool.web_search',
  paramNames: ['endpoint', 'timeoutMs', 'maxResults', 'maxChars', 'provider', 'searxngUrl'],
  bindingNames: ['__fetcher', '__dnsLookup'],
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
    if (p.provider !== undefined && p.provider !== 'searxng' && p.provider !== 'ddg' && p.provider !== 'auto') {
      errs.push({
        path: 'params.provider',
        code: 'INVALID_PARAM',
        message: "provider deve ser 'searxng', 'ddg' ou 'auto'",
      });
    }
    if (p.searxngUrl !== undefined) {
      if (typeof p.searxngUrl !== 'string' || p.searxngUrl.trim().length === 0) {
        errs.push({ path: 'params.searxngUrl', code: 'INVALID_PARAM', message: 'searxngUrl deve ser string não vazia' });
      } else {
        try {
          const u = new URL(p.searxngUrl.trim());
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            errs.push({
              path: 'params.searxngUrl',
              code: 'INVALID_PARAM',
              message: 'searxngUrl deve usar protocolo http:// ou https://',
            });
          }
        } catch {
          errs.push({ path: 'params.searxngUrl', code: 'INVALID_PARAM', message: 'searxngUrl deve ser uma URL válida' });
        }
      }
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const endpoint = ((ctx.params.endpoint as string | undefined) ?? DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
    const rawTimeout = (ctx.params.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(100, rawTimeout), MAX_TIMEOUT_MS);
    const maxResults = Math.max(1, Math.floor((ctx.params.maxResults as number | undefined) ?? DEFAULT_MAX_RESULTS));
    const maxChars = Math.max(100, Math.floor((ctx.params.maxChars as number | undefined) ?? DEFAULT_MAX_CHARS));
    const provider: WebSearchProvider = (ctx.params.provider as WebSearchProvider | undefined) ?? 'auto';
    const envSearxng = process.env.SEARXNG_URL?.trim();
    const searxngUrl =
      ((ctx.params.searxngUrl as string | undefined) ?? (envSearxng || DEFAULT_SEARXNG_URL)).trim() ||
      DEFAULT_SEARXNG_URL;

    const customFetcher = ctx.bindings?.__fetcher as FetcherFn | undefined;
    const fetcher: FetcherFn = typeof customFetcher === 'function' ? customFetcher : fetch;
    const customDnsLookup = ctx.bindings?.__dnsLookup as DnsLookupFn | undefined;
    const skipDns = Boolean(customFetcher) && typeof customDnsLookup !== 'function';

    const defs: ToolDef[] = [
      {
        name: 'web_search',
        description:
          'Pesquisa externa na web (SearXNG JSON + DuckDuckGo Instant Answer / HTML fallback) para consultar documentação e referências.',
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

    async function searchViaSearxng(
      query: string,
      signals: AbortSignal[],
    ): Promise<{ hits: SearchHit[]; status: number }> {
      const searchUrl = buildSearxngSearchUrl(searxngUrl, query);
      // Permite explicitamente o searxngUrl configurado (ex.: http://core.searxng.orb.local)
      const { response } = await fetchWithSafeRedirects({
        fetcher,
        url: searchUrl.toString(),
        timeoutMs,
        headers: DEFAULT_HEADERS,
        signals,
        maxRedirects: MAX_REDIRECTS,
        allowInternalHost: true,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(`SearXNG HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
      const parsed = JSON.parse(body) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('SearXNG retornou JSON inválido');
      }
      const rec = parsed as { results?: unknown; answers?: unknown; infoboxes?: unknown };
      if (!Array.isArray(rec.results) && !Array.isArray(rec.answers) && !Array.isArray(rec.infoboxes)) {
        throw new Error('Resposta JSON não parece ser do SearXNG');
      }
      return { hits: parseSearxngJson(parsed, maxResults), status: response.status };
    }

    async function searchViaDdg(
      query: string,
      signals: AbortSignal[],
    ): Promise<{ hits: SearchHit[]; errorStatus?: number; errorBody?: string }> {
      if (!customFetcher) {
        const epCheck = validateExternalUrl(endpoint);
        if (!epCheck.ok) {
          throw new SafeFetchError('SSRF_BLOCKED', `endpoint inválido — ${epCheck.reason}`);
        }
      }

      const searchUrl = new URL(endpoint);
      searchUrl.searchParams.set('q', query);
      searchUrl.searchParams.set('format', 'json');
      searchUrl.searchParams.set('no_html', '1');
      searchUrl.searchParams.set('skip_disambig', '1');

      const { response: res } = await fetchWithSafeRedirects({
        fetcher,
        url: searchUrl.toString(),
        timeoutMs,
        headers: DEFAULT_HEADERS,
        signals,
        maxRedirects: MAX_REDIRECTS,
        dnsLookup: customDnsLookup,
        skipDns,
        allowInternalHost: Boolean(customFetcher),
      });

      const body = await res.text();
      if (!res.ok) {
        return { hits: [], errorStatus: res.status, errorBody: body };
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
          const { response: fbRes } = await fetchWithSafeRedirects({
            fetcher,
            url: fbUrl.toString(),
            timeoutMs,
            headers: DEFAULT_HEADERS,
            signals,
            maxRedirects: MAX_REDIRECTS,
            dnsLookup: customDnsLookup,
            skipDns,
            allowInternalHost: false,
          });
          if (fbRes.ok) {
            const fbHtml = await fbRes.text();
            hits = parseDdgHtmlFallback(fbHtml, maxResults);
          }
        } catch {
          /* fallback best-effort */
        }
      }

      return { hits };
    }

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

          const signals = [opts.signal, ctx.signal];
          try {
            let hits: SearchHit[] = [];
            let usedProvider: 'searxng' | 'ddg' = provider === 'ddg' ? 'ddg' : 'searxng';

            if (provider === 'searxng') {
              const sx = await searchViaSearxng(query, signals);
              hits = sx.hits;
              usedProvider = 'searxng';
            } else if (provider === 'auto') {
              try {
                const sx = await searchViaSearxng(query, signals);
                hits = sx.hits;
                usedProvider = 'searxng';
              } catch (sxErr: unknown) {
                if (sxErr instanceof SafeFetchError && sxErr.code === 'ABORTED') {
                  throw sxErr;
                }
                const sxMsg = sxErr instanceof Error ? sxErr.message : String(sxErr);
                ctx.log('info', `tool.web_search fallback SearXNG → DDG (${sxMsg})`);
                hits = [];
              }

              if (hits.length === 0) {
                const ddg = await searchViaDdg(query, signals);
                if (ddg.errorStatus !== undefined) {
                  return {
                    ok: false,
                    output: `Erro HTTP ${ddg.errorStatus} na busca: ${(ddg.errorBody ?? '').slice(0, 300)}`,
                    durationMs: Date.now() - t0,
                    meta: { status: ddg.errorStatus, provider: 'ddg' },
                  };
                }
                hits = ddg.hits;
                usedProvider = 'ddg';
              }
            } else {
              const ddg = await searchViaDdg(query, signals);
              if (ddg.errorStatus !== undefined) {
                return {
                  ok: false,
                  output: `Erro HTTP ${ddg.errorStatus} na busca: ${(ddg.errorBody ?? '').slice(0, 300)}`,
                  durationMs: Date.now() - t0,
                  meta: { status: ddg.errorStatus, provider: 'ddg' },
                };
              }
              hits = ddg.hits;
              usedProvider = 'ddg';
            }

            const durationMs = Date.now() - t0;
            ctx.metrics.counter('tool.web_search.queries', 1);
            ctx.metrics.timer('tool.web_search.durationMs', durationMs);
            return {
              ok: true,
              output: formatHits(query, hits, maxChars),
              durationMs,
              meta: { query, hits: hits.length, provider: usedProvider },
            };
          } catch (err: unknown) {
            if (err instanceof SafeFetchError && err.code === 'SSRF_BLOCKED') {
              ctx.metrics.counter('tool.web_search.ssrf_blocked', 1);
              return {
                ok: false,
                output: `SSRF_BLOCKED: ${err.message}`,
                durationMs: Date.now() - t0,
                meta: { code: 'SSRF_BLOCKED' },
              };
            }
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
          try {
            const { response: res, finalUrl } = await fetchWithSafeRedirects({
              fetcher,
              url: typeof args.url === 'string' ? args.url : String(args.url ?? ''),
              timeoutMs,
              headers: DEFAULT_HEADERS,
              signals: [opts.signal, ctx.signal],
              maxRedirects: MAX_REDIRECTS,
              dnsLookup: customDnsLookup,
              skipDns,
              allowInternalHost: false,
            });
            const raw = await res.text();
            if (!res.ok) {
              return {
                ok: false,
                output: `Erro HTTP ${res.status} ao acessar ${finalUrl}: ${raw.slice(0, 300)}`,
                durationMs: Date.now() - t0,
                meta: { status: res.status, url: finalUrl },
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
              meta: { status: res.status, url: finalUrl },
            };
          } catch (err: unknown) {
            if (err instanceof SafeFetchError && err.code === 'SSRF_BLOCKED') {
              ctx.metrics.counter('tool.web_search.ssrf_blocked', 1);
              return {
                ok: false,
                output: `SSRF_BLOCKED: ${err.message}`,
                durationMs: Date.now() - t0,
                meta: { code: 'SSRF_BLOCKED' },
              };
            }
            if (err instanceof SafeFetchError && err.code === 'REDIRECT_BLOCKED') {
              return {
                ok: false,
                output: `REDIRECT_BLOCKED: ${err.message}`,
                durationMs: Date.now() - t0,
                meta: { code: 'REDIRECT_BLOCKED' },
              };
            }
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
