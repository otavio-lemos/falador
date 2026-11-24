// falador-nodes — tool.crawler: scraping / crawler BFS zero-deps com proteção anti-SSRF
import {
  GraphError,
  type ControlMsg,
  type Envelope,
  type NodeCtx,
  type NodeRuntime,
  type NodeTypeDef,
  type ParamError,
  type ToolCallResult,
  type ToolDef,
  type ToolProvider,
} from '../../falador-graph/src/index.ts';
import { payloadText } from './sse.ts';
import {
  MAX_REDIRECTS,
  SafeFetchError,
  fetchWithSafeRedirects,
  validateExternalUrl,
  type DnsLookupFn,
  type FetcherFn,
} from './tool-web-search.ts';
import { inheritTrace } from './trace.ts';

const DEFAULT_MAX_PAGES = 5;
const MIN_MAX_PAGES = 1;
const MAX_MAX_PAGES = 20;

const DEFAULT_MAX_DEPTH = 1;
const MIN_MAX_DEPTH = 0;
const MAX_MAX_DEPTH = 3;

const DEFAULT_TIMEOUT_MS = 8000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_CHARS_PER_PAGE = 4000;
const DEFAULT_MAX_TOTAL_CHARS = 16_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'FaladorCrawler/1.0 (local-on-device)';

export interface ExtractedPageData {
  title: string;
  url: string;
  text: string;
  links: string[];
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = '\n[...truncado]';
  const keep = Math.max(0, maxChars - suffix.length);
  return `${text.slice(0, keep)}${suffix}`;
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

function removeTagBlocks(html: string, tags: readonly string[]): string {
  let s = html;
  for (const tag of tags) {
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
      // Garante fronteira do nome da tag (evita casar <scriptx>)
      const nextCh = lower[start + lowerTagOpen.length];
      if (nextCh && /[a-z0-9_-]/.test(nextCh)) {
        out += s.slice(idx, start + lowerTagOpen.length);
        idx = start + lowerTagOpen.length;
        continue;
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
  return s;
}

function stripTagsPreservingNewlines(html: string): string {
  let out = '';
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === '<') {
      inTag = true;
    } else if (ch === '>') {
      inTag = false;
    } else if (!inTag) {
      out += ch;
    }
  }
  return decodeHtmlEntities(out);
}

function extractLanguageHint(attrZone: string): string {
  const m = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrZone);
  const cls = m?.[1] ?? m?.[2] ?? '';
  const langMatch = /(?:language-|lang-)([a-z0-9_+-]+)/i.exec(cls);
  return langMatch ? langMatch[1].toLowerCase() : '';
}

function formatCodeFence(rawInnerHtml: string, attrZone: string): string {
  let lang = extractLanguageHint(attrZone);
  if (!lang) {
    const innerCodeMatch = /<code([^>]*)>/i.exec(rawInnerHtml);
    if (innerCodeMatch) {
      lang = extractLanguageHint(innerCodeMatch[1]);
    }
  }
  const decoded = stripTagsPreservingNewlines(rawInnerHtml).replace(/\r\n?/g, '\n');
  const lines = decoded.split('\n');
  while (lines.length > 0 && lines[0].trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const code = lines.join('\n');
  return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
}

export function stripTagsToText(html: string): string {
  const withoutNoise = removeTagBlocks(html, [
    'script',
    'style',
    'noscript',
    'svg',
    'nav',
    'header',
    'footer',
  ]);

  const codeBlocks: string[] = [];
  let withPlaceholders = '';
  const lower = withoutNoise.toLowerCase();
  let idx = 0;

  while (idx < withoutNoise.length) {
    const preIdx = lower.indexOf('<pre', idx);
    const codeIdx = lower.indexOf('<code', idx);

    let nextIdx = -1;
    let tag: 'pre' | 'code' = 'pre';
    if (preIdx !== -1 && (codeIdx === -1 || preIdx <= codeIdx)) {
      nextIdx = preIdx;
      tag = 'pre';
    } else if (codeIdx !== -1) {
      nextIdx = codeIdx;
      tag = 'code';
    }

    if (nextIdx === -1) {
      withPlaceholders += withoutNoise.slice(idx);
      break;
    }

    const openTagLen = tag === 'pre' ? 4 : 5;
    const afterName = lower[nextIdx + openTagLen];
    if (afterName && !/[\s>]/.test(afterName)) {
      withPlaceholders += withoutNoise.slice(idx, nextIdx + openTagLen);
      idx = nextIdx + openTagLen;
      continue;
    }

    const gtIdx = withoutNoise.indexOf('>', nextIdx + openTagLen);
    if (gtIdx === -1) {
      withPlaceholders += withoutNoise.slice(idx);
      break;
    }

    const closeTag = `</${tag}>`;
    const closeIdx = lower.indexOf(closeTag, gtIdx + 1);
    if (closeIdx === -1) {
      withPlaceholders += withoutNoise.slice(idx, gtIdx + 1);
      idx = gtIdx + 1;
      continue;
    }

    withPlaceholders += withoutNoise.slice(idx, nextIdx);
    const attrZone = withoutNoise.slice(nextIdx + openTagLen, gtIdx);
    const innerHtml = withoutNoise.slice(gtIdx + 1, closeIdx);

    if (tag === 'pre' || innerHtml.includes('\n')) {
      const token = `__FALADOR_CODE_BLOCK_${codeBlocks.length}__`;
      codeBlocks.push(formatCodeFence(innerHtml, attrZone));
      withPlaceholders += ` ${token} `;
    } else {
      const inlineCode = stripTagsPreservingNewlines(innerHtml).replace(/\s+/g, ' ').trim();
      withPlaceholders += inlineCode ? ` \`${inlineCode}\` ` : ' ';
    }

    idx = closeIdx + closeTag.length;
  }

  let stripped = '';
  let inTag = false;
  for (let i = 0; i < withPlaceholders.length; i++) {
    const ch = withPlaceholders[i];
    if (ch === '<') {
      inTag = true;
      stripped += ' ';
    } else if (ch === '>') {
      inTag = false;
    } else if (!inTag) {
      stripped += ch;
    }
  }

  let text = decodeHtmlEntities(stripped).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < codeBlocks.length; i++) {
    const token = `__FALADOR_CODE_BLOCK_${i}__`;
    text = text.replace(new RegExp(`\\s*${token}\\s*`, 'g'), codeBlocks[i]);
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle(html: string): string {
  const lower = html.toLowerCase();
  const openIdx = lower.indexOf('<title');
  if (openIdx === -1) return '';
  const gtIdx = html.indexOf('>', openIdx);
  if (gtIdx === -1) return '';
  const closeIdx = lower.indexOf('</title>', gtIdx + 1);
  if (closeIdx === -1) return '';
  return decodeHtmlEntities(html.slice(gtIdx + 1, closeIdx)).replace(/\s+/g, ' ').trim();
}

function extractLinks(html: string, baseUrl: string): string[] {
  const withoutScripts = removeTagBlocks(html, ['script', 'style', 'noscript', 'svg']);
  const seen = new Set<string>();
  const links: string[] = [];

  const lower = withoutScripts.toLowerCase();
  let idx = 0;
  while (idx < withoutScripts.length) {
    const aStart = lower.indexOf('<a', idx);
    if (aStart === -1) break;
    const afterA = lower[aStart + 2];
    if (afterA && !/\s|>/.test(afterA)) {
      idx = aStart + 2;
      continue;
    }
    const tagEnd = withoutScripts.indexOf('>', aStart + 2);
    if (tagEnd === -1) break;

    const tagContent = withoutScripts.slice(aStart + 2, tagEnd);
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tagContent);
    if (hrefMatch) {
      const rawHref = decodeHtmlEntities((hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '').trim());
      if (rawHref && !rawHref.startsWith('#')) {
        try {
          const resolved = new URL(rawHref, baseUrl);
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            resolved.hash = '';
            const normalized = resolved.toString();
            if (!seen.has(normalized)) {
              seen.add(normalized);
              links.push(normalized);
            }
          }
        } catch {
          /* href inválido ignorado */
        }
      }
    }
    idx = tagEnd + 1;
  }

  return links;
}

/**
 * Extrai título, texto limpo (sem nav/header/footer/script/style/noscript/svg, preservando blocos de código)
 * e links http/https resolvidos e deduplicados de uma página HTML.
 */
export function extractPageData(
  html: string,
  baseUrl: string,
  maxCharsPerPage: number = DEFAULT_MAX_CHARS_PER_PAGE,
): ExtractedPageData {
  const title = extractTitle(html);
  const links = extractLinks(html, baseUrl);
  const cleanText = stripTagsToText(html);
  const text = truncateText(cleanText, Math.max(1, Math.floor(maxCharsPerPage)));
  return {
    title,
    url: baseUrl,
    text,
    links,
  };
}

/**
 * Verifica se o hostname da URL pertence à allowlist de domínios (igual ou subdomínio).
 * Quando `allowedDomains` está vazio, permite qualquer domínio (restrições anti-SSRF continuam valendo).
 */
export function isDomainAllowed(url: string | URL, allowedDomains: readonly string[]): boolean {
  const normalizedList = allowedDomains
    .map((d) => d.trim().toLowerCase().replace(/^\*\./, '').replace(/^\./, ''))
    .filter((d) => d.length > 0);
  if (normalizedList.length === 0) return true;

  let parsed: URL;
  if (url instanceof URL) {
    parsed = url;
  } else {
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
  }

  const rawHost = parsed.hostname.toLowerCase();
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  if (!host) return false;

  return normalizedList.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function normalizeUrlKey(u: URL): string {
  const copy = new URL(u.toString());
  copy.hash = '';
  return copy.toString();
}

async function readResponseTextWithLimit(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const ab = await res.arrayBuffer();
    const view = new Uint8Array(ab, 0, Math.min(ab.byteLength, maxBytes));
    return new TextDecoder('utf-8', { fatal: false }).decode(view);
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let streamDone = false;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        streamDone = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;

      const remaining = maxBytes - total;
      if (value.byteLength <= remaining) {
        chunks.push(value);
        total += value.byteLength;
      } else {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        break;
      }
    }
    if (!streamDone) {
      await reader.cancel().catch(() => {});
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

function isAbortError(err: unknown, signals: AbortSignal[]): boolean {
  if (signals.some((s) => s.aborted)) return true;
  if (err instanceof SafeFetchError && err.code === 'ABORTED') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes('cancelada') || msg.toLowerCase().includes('aborted');
}

function formatScrapeOutput(page: ExtractedPageData, maxTotalChars: number): string {
  const lines: string[] = [];
  if (page.title) lines.push(`Título: ${page.title}`);
  lines.push(`URL: ${page.url}`);
  lines.push('');
  lines.push(page.text || '(sem conteúdo textual)');
  if (page.links.length > 0) {
    lines.push('');
    lines.push(`Links (${page.links.length}):`);
    for (const link of page.links.slice(0, 50)) {
      lines.push(`- ${link}`);
    }
  }
  return truncateText(lines.join('\n'), maxTotalChars);
}

function formatCrawlReport(pages: ExtractedPageData[], startUrl: string, maxTotalChars: number): string {
  if (pages.length === 0) {
    return `Nenhuma página raspada a partir de ${startUrl}.`;
  }
  const sections = pages.map((p, idx) => {
    const header = p.title ? `## [${idx + 1}] ${p.title}\nURL: ${p.url}` : `## [${idx + 1}] ${p.url}`;
    return `${header}\n\n${p.text || '(sem conteúdo textual)'}`;
  });
  const header = `Crawl de ${startUrl} (${pages.length} página${pages.length === 1 ? '' : 's'}):`;
  return truncateText(`${header}\n\n${sections.join('\n\n---\n\n')}`, maxTotalChars);
}

function parseLinearInput(payload: unknown): { url: string; maxPages?: number; maxDepth?: number } | null {
  if (payload && typeof payload === 'object' && typeof (payload as Record<string, unknown>).url === 'string') {
    const obj = payload as { url: string; maxPages?: unknown; maxDepth?: unknown };
    return {
      url: obj.url.trim(),
      maxPages: typeof obj.maxPages === 'number' ? obj.maxPages : undefined,
      maxDepth: typeof obj.maxDepth === 'number' ? obj.maxDepth : undefined,
    };
  }
  const pl = payloadText(payload);
  const raw = pl ? pl.text : typeof payload === 'string' ? payload : '';
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).url === 'string') {
        const obj = parsed as { url: string; maxPages?: unknown; maxDepth?: unknown };
        return {
          url: obj.url.trim(),
          maxPages: typeof obj.maxPages === 'number' ? obj.maxPages : undefined,
          maxDepth: typeof obj.maxDepth === 'number' ? obj.maxDepth : undefined,
        };
      }
    } catch {
      /* segue como URL direta */
    }
  }

  return { url: trimmed };
}

export const toolCrawler: NodeTypeDef = {
  type: 'tool.crawler',
  paramNames: [
    'maxPages',
    'maxDepth',
    'sameOriginOnly',
    'allowedDomains',
    'timeoutMs',
    'maxCharsPerPage',
    'maxTotalChars',
    'maxBytes',
    'userAgent',
  ],
  bindingNames: ['__fetcher', '__dnsLookup'],
  inputs: [
    { name: 'in', type: 'phrase' },
    { name: 'parcs', type: 'tokens_parcial' },
  ],
  outputs: [
    { name: 'out', type: 'phrase', required: false },
    { name: 'tool', type: 'tool', required: false },
  ],
  validateParams: (p): ParamError[] => {
    const errs: ParamError[] = [];
    if (p.maxPages !== undefined && (typeof p.maxPages !== 'number' || Number.isNaN(p.maxPages) || p.maxPages < 1)) {
      errs.push({ path: 'params.maxPages', code: 'INVALID_PARAM', message: 'maxPages deve ser número >= 1' });
    }
    if (p.maxDepth !== undefined && (typeof p.maxDepth !== 'number' || Number.isNaN(p.maxDepth) || p.maxDepth < 0)) {
      errs.push({ path: 'params.maxDepth', code: 'INVALID_PARAM', message: 'maxDepth deve ser número >= 0' });
    }
    if (p.sameOriginOnly !== undefined && typeof p.sameOriginOnly !== 'boolean') {
      errs.push({ path: 'params.sameOriginOnly', code: 'INVALID_PARAM', message: 'sameOriginOnly deve ser boolean' });
    }
    if (p.allowedDomains !== undefined) {
      if (!Array.isArray(p.allowedDomains) || p.allowedDomains.some((x) => typeof x !== 'string')) {
        errs.push({ path: 'params.allowedDomains', code: 'INVALID_PARAM', message: 'allowedDomains deve ser string[]' });
      }
    }
    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || Number.isNaN(p.timeoutMs) || p.timeoutMs <= 0)) {
      errs.push({ path: 'params.timeoutMs', code: 'INVALID_PARAM', message: 'timeoutMs deve ser número positivo' });
    }
    if (
      p.maxCharsPerPage !== undefined &&
      (typeof p.maxCharsPerPage !== 'number' || Number.isNaN(p.maxCharsPerPage) || p.maxCharsPerPage <= 0)
    ) {
      errs.push({ path: 'params.maxCharsPerPage', code: 'INVALID_PARAM', message: 'maxCharsPerPage deve ser número positivo' });
    }
    if (
      p.maxTotalChars !== undefined &&
      (typeof p.maxTotalChars !== 'number' || Number.isNaN(p.maxTotalChars) || p.maxTotalChars <= 0)
    ) {
      errs.push({ path: 'params.maxTotalChars', code: 'INVALID_PARAM', message: 'maxTotalChars deve ser número positivo' });
    }
    if (p.maxBytes !== undefined && (typeof p.maxBytes !== 'number' || Number.isNaN(p.maxBytes) || p.maxBytes <= 0)) {
      errs.push({ path: 'params.maxBytes', code: 'INVALID_PARAM', message: 'maxBytes deve ser número positivo' });
    }
    if (p.userAgent !== undefined && (typeof p.userAgent !== 'string' || p.userAgent.trim().length === 0)) {
      errs.push({ path: 'params.userAgent', code: 'INVALID_PARAM', message: 'userAgent deve ser string não vazia' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const nodeMaxPages = clampInt((ctx.params.maxPages as number | undefined) ?? DEFAULT_MAX_PAGES, MIN_MAX_PAGES, MAX_MAX_PAGES);
    const nodeMaxDepth = clampInt((ctx.params.maxDepth as number | undefined) ?? DEFAULT_MAX_DEPTH, MIN_MAX_DEPTH, MAX_MAX_DEPTH);
    const sameOriginOnly = (ctx.params.sameOriginOnly as boolean | undefined) ?? true;
    const allowedDomains = ((ctx.params.allowedDomains as string[] | undefined) ?? [])
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    const timeoutMs = clampInt((ctx.params.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxCharsPerPage = Math.max(
      100,
      Math.floor((ctx.params.maxCharsPerPage as number | undefined) ?? DEFAULT_MAX_CHARS_PER_PAGE),
    );
    const maxTotalChars = Math.max(
      200,
      Math.floor((ctx.params.maxTotalChars as number | undefined) ?? DEFAULT_MAX_TOTAL_CHARS),
    );
    const maxBytes = Math.max(
      1024,
      Math.floor((ctx.params.maxBytes as number | undefined) ?? DEFAULT_MAX_RESPONSE_BYTES),
    );
    const userAgent = ((ctx.params.userAgent as string | undefined) ?? DEFAULT_USER_AGENT).trim() || DEFAULT_USER_AGENT;

    const customFetcher = ctx.bindings?.__fetcher as FetcherFn | undefined;
    const fetcher: FetcherFn = typeof customFetcher === 'function' ? customFetcher : fetch;
    const customDnsLookup = ctx.bindings?.__dnsLookup as DnsLookupFn | undefined;
    const skipDns = Boolean(customFetcher) && typeof customDnsLookup !== 'function';

    let linearInterruptAc: AbortController | null = null;

    type CrawlOutcome =
      | { ok: true; pages: ExtractedPageData[]; startUrl: string; durationMs: number }
      | { ok: false; code: string; reason: string; interrupted?: boolean; durationMs: number };

    async function runCrawl(opts: {
      rawUrl: unknown;
      maxPages: number;
      maxDepth: number;
      signals: AbortSignal[];
    }): Promise<CrawlOutcome> {
      const t0 = Date.now();
      if (opts.signals.some((s) => s.aborted)) {
        return {
          ok: false,
          code: 'INTERRUPTED',
          reason: 'Crawl cancelado (signal abortado).',
          interrupted: true,
          durationMs: Date.now() - t0,
        };
      }

      const checked = validateExternalUrl(opts.rawUrl);
      if (!checked.ok) {
        ctx.metrics.counter('tool.crawler.ssrf_blocked', 1);
        return {
          ok: false,
          code: 'SSRF_BLOCKED',
          reason: checked.reason,
          durationMs: Date.now() - t0,
        };
      }

      if (!isDomainAllowed(checked.url, allowedDomains)) {
        ctx.metrics.counter('tool.crawler.domain_blocked', 1);
        return {
          ok: false,
          code: 'DOMAIN_NOT_ALLOWED',
          reason: `Domínio não permitido por allowedDomains: ${checked.url.hostname}`,
          durationMs: Date.now() - t0,
        };
      }

      const startUrl = checked.url;
      const startKey = normalizeUrlKey(startUrl);
      const effectiveMaxPages = clampInt(opts.maxPages, MIN_MAX_PAGES, nodeMaxPages);
      const effectiveMaxDepth = clampInt(opts.maxDepth, MIN_MAX_DEPTH, nodeMaxDepth);

      const visited = new Set<string>([startKey]);
      const queue: Array<{ url: URL; depth: number }> = [{ url: startUrl, depth: 0 }];
      const pages: ExtractedPageData[] = [];

      while (queue.length > 0 && pages.length < effectiveMaxPages) {
        if (opts.signals.some((s) => s.aborted)) {
          return {
            ok: false,
            code: 'INTERRUPTED',
            reason: 'Crawl interrompido.',
            interrupted: true,
            durationMs: Date.now() - t0,
          };
        }

        const item = queue.shift()!;
        const currentUrlStr = item.url.toString();

        let res: Response;
        let finalUrl = currentUrlStr;
        try {
          const fetched = await fetchWithSafeRedirects({
            fetcher,
            url: currentUrlStr,
            timeoutMs,
            headers: {
              'User-Agent': userAgent,
              Accept: 'text/html, application/xhtml+xml, text/plain;q=0.9, */*;q=0.1',
            },
            signals: opts.signals,
            maxRedirects: MAX_REDIRECTS,
            dnsLookup: customDnsLookup,
            skipDns,
            allowInternalHost: false,
            validateRedirectUrl: (nextUrl) => {
              if (!isDomainAllowed(nextUrl, allowedDomains)) {
                return {
                  ok: false,
                  code: 'DOMAIN_NOT_ALLOWED',
                  reason: `Redirect para domínio não permitido por allowedDomains: ${nextUrl.hostname}`,
                };
              }
              return { ok: true };
            },
          });
          res = fetched.response;
          finalUrl = fetched.finalUrl;
          if (finalUrl !== currentUrlStr) {
            try {
              visited.add(normalizeUrlKey(new URL(finalUrl)));
            } catch {
              /* ignore */
            }
          }
        } catch (err: unknown) {
          if (isAbortError(err, opts.signals)) {
            return {
              ok: false,
              code: 'INTERRUPTED',
              reason: 'Crawl cancelado.',
              interrupted: true,
              durationMs: Date.now() - t0,
            };
          }
          if (err instanceof SafeFetchError) {
            if (err.isRedirect) {
              ctx.metrics.counter('tool.crawler.redirect_blocked', 1);
            }
            if (err.code === 'SSRF_BLOCKED') {
              ctx.metrics.counter('tool.crawler.ssrf_blocked', 1);
            } else if (err.code === 'DOMAIN_NOT_ALLOWED') {
              ctx.metrics.counter('tool.crawler.domain_blocked', 1);
            }
            if (item.depth === 0) {
              return {
                ok: false,
                code: err.isRedirect ? 'REDIRECT_BLOCKED' : err.code,
                reason: err.message,
                durationMs: Date.now() - t0,
              };
            }
            ctx.log('warn', `tool.crawler erro ao seguir link ${currentUrlStr}: ${err.message}`);
            continue;
          }
          const msg = err instanceof Error ? err.message : String(err);
          if (item.depth === 0) {
            return {
              ok: false,
              code: 'FETCH_ERROR',
              reason: `Erro ao acessar ${currentUrlStr}: ${msg}`,
              durationMs: Date.now() - t0,
            };
          }
          ctx.log('warn', `tool.crawler erro ao seguir link ${currentUrlStr}: ${msg}`);
          continue;
        }

        if (!res.ok) {
          res.body?.cancel?.().catch(() => {});
          if (item.depth === 0) {
            return {
              ok: false,
              code: 'HTTP_ERROR',
              reason: `Erro HTTP ${res.status} ao acessar ${finalUrl}`,
              durationMs: Date.now() - t0,
            };
          }
          continue;
        }

        let body: string;
        try {
          body = await readResponseTextWithLimit(res, maxBytes);
        } catch (err: unknown) {
          if (isAbortError(err, opts.signals)) {
            return {
              ok: false,
              code: 'INTERRUPTED',
              reason: 'Crawl cancelado.',
              interrupted: true,
              durationMs: Date.now() - t0,
            };
          }
          if (item.depth === 0) {
            return {
              ok: false,
              code: 'FETCH_ERROR',
              reason: `Erro ao ler resposta de ${finalUrl}: ${err instanceof Error ? err.message : String(err)}`,
              durationMs: Date.now() - t0,
            };
          }
          continue;
        }

        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        const looksHtml =
          contentType.includes('text/html') ||
          contentType.includes('application/xhtml') ||
          /<html|<body|<title|<a\s/i.test(body);

        const extracted: ExtractedPageData = looksHtml
          ? extractPageData(body, finalUrl, maxCharsPerPage)
          : {
              title: '',
              url: finalUrl,
              text: truncateText(body.trim(), maxCharsPerPage),
              links: [],
            };

        pages.push(extracted);
        ctx.metrics.counter('tool.crawler.pages', 1);

        if (item.depth < effectiveMaxDepth && pages.length < effectiveMaxPages) {
          for (const linkStr of extracted.links) {
            const linkCheck = validateExternalUrl(linkStr);
            if (!linkCheck.ok) continue;
            if (sameOriginOnly && linkCheck.url.origin !== startUrl.origin) continue;
            if (!isDomainAllowed(linkCheck.url, allowedDomains)) continue;
            const linkKey = normalizeUrlKey(linkCheck.url);
            if (visited.has(linkKey)) continue;
            visited.add(linkKey);
            queue.push({ url: linkCheck.url, depth: item.depth + 1 });
          }
        }
      }

      const durationMs = Date.now() - t0;
      ctx.metrics.timer('tool.crawler.durationMs', durationMs);
      return { ok: true, pages, startUrl: startKey, durationMs };
    }

    const defs: ToolDef[] = [
      {
        name: 'web_scrape',
        description:
          'Raspa uma única página pública (http/https) com proteção anti-SSRF, retornando título, URL, texto limpo e lista de links.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL pública http:// ou https:// a raspar.' },
          },
          required: ['url'],
        },
        readonly: true,
        sourceNodeId: ctx.id,
      },
      {
        name: 'web_crawl',
        description: `Faz crawl BFS a partir de uma URL pública com proteção anti-SSRF (limites do nó: maxPages=${nodeMaxPages}, maxDepth=${nodeMaxDepth}, sameOriginOnly=${sameOriginOnly}).`,
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL inicial http:// ou https:// para o crawl.' },
            maxPages: {
              type: 'number',
              description: `Máximo de páginas a visitar (teto configurado: ${nodeMaxPages}).`,
            },
            maxDepth: {
              type: 'number',
              description: `Profundidade máxima de links seguidos (teto configurado: ${nodeMaxDepth}).`,
            },
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
        if (toolName === 'web_scrape') {
          const outcome = await runCrawl({
            rawUrl: args.url,
            maxPages: 1,
            maxDepth: 0,
            signals: [opts.signal, ctx.signal],
          });
          if (!outcome.ok) {
            return {
              ok: false,
              output: `${outcome.code}: ${outcome.reason}`,
              durationMs: outcome.durationMs,
              meta: { code: outcome.code, interrupted: outcome.interrupted ?? false },
            };
          }
          const page = outcome.pages[0];
          return {
            ok: true,
            output: formatScrapeOutput(page, maxTotalChars),
            durationMs: outcome.durationMs,
            meta: {
              url: page.url,
              title: page.title,
              linksCount: page.links.length,
              pagesCount: 1,
            },
          };
        }

        if (toolName === 'web_crawl') {
          const reqPages = typeof args.maxPages === 'number' && !Number.isNaN(args.maxPages) ? args.maxPages : nodeMaxPages;
          const reqDepth = typeof args.maxDepth === 'number' && !Number.isNaN(args.maxDepth) ? args.maxDepth : nodeMaxDepth;
          const outcome = await runCrawl({
            rawUrl: args.url,
            maxPages: reqPages,
            maxDepth: reqDepth,
            signals: [opts.signal, ctx.signal],
          });
          if (!outcome.ok) {
            return {
              ok: false,
              output: `${outcome.code}: ${outcome.reason}`,
              durationMs: outcome.durationMs,
              meta: { code: outcome.code, interrupted: outcome.interrupted ?? false },
            };
          }
          return {
            ok: true,
            output: formatCrawlReport(outcome.pages, outcome.startUrl, maxTotalChars),
            durationMs: outcome.durationMs,
            meta: {
              url: outcome.startUrl,
              pagesCount: outcome.pages.length,
              urls: outcome.pages.map((p) => p.url),
            },
          };
        }

        return {
          ok: false,
          output: `Tool desconhecida em ${ctx.id}: ${toolName}`,
          durationMs: 0,
        };
      },
    };

    return {
      toolProvider,

      async start() {},

      onControl(c: ControlMsg) {
        if (c.kind === 'interrupt' && linearInterruptAc) {
          ctx.log('info', `tool.crawler interrompido por controle (${c.reason ?? 'interrupt'})`);
          linearInterruptAc.abort(new Error(`Interrompido: ${c.reason ?? 'interrupt'}`));
        }
      },

      async onInput(port: string, msg: Envelope) {
        if (msg.control) return;

        if (port === 'parcs') {
          const pl = payloadText(msg.payload);
          if (!pl || !pl.final) return;
        }

        const parsed = parseLinearInput(msg.payload);
        if (!parsed || !parsed.url) {
          throw new GraphError('INVALID_INPUT', ctx.id, 'Entrada deve conter uma URL ou JSON { url, maxPages?, maxDepth? }');
        }

        const tExecStartMs = Date.now();
        const ac = new AbortController();
        linearInterruptAc = ac;
        try {
          const outcome = await runCrawl({
            rawUrl: parsed.url,
            maxPages: parsed.maxPages ?? nodeMaxPages,
            maxDepth: parsed.maxDepth ?? nodeMaxDepth,
            signals: [ac.signal, ctx.signal],
          });

          if (!outcome.ok) {
            if (outcome.interrupted) {
              return;
            }
            throw new GraphError(outcome.code, ctx.id, outcome.reason);
          }

          const tExecEndMs = Date.now();
          const report = formatCrawlReport(outcome.pages, outcome.startUrl, maxTotalChars);
          await ctx.emit('out', report, {
            meta: {
              ...msg.meta,
              crawler: {
                url: outcome.startUrl,
                pagesCount: outcome.pages.length,
                urls: outcome.pages.map((p) => p.url),
                durationMs: outcome.durationMs,
              },
              ...inheritTrace(msg, { tExecStartMs, tExecEndMs }),
            },
          });
        } finally {
          if (linearInterruptAc === ac) {
            linearInterruptAc = null;
          }
        }
      },

      async stop() {
        if (linearInterruptAc) {
          linearInterruptAc.abort(new Error('Nó parado'));
          linearInterruptAc = null;
        }
      },
    };
  },
};
