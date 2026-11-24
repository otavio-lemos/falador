// falador-nodes — RAG local genérico por chunks + BM25 (ADR-007 Fase A, ZERO dependências)

export interface ContextChunk {
  id: string;
  docName: string;
  heading?: string;
  text: string;
  tags: string[];
}

export interface ContextDocument {
  id: string;
  name: string;
  tags: string[];
  addedAt: string;
  points: string[];
  chunks: ContextChunk[];
  text?: string;
}

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
  tags?: string[];
}

export interface SearchOptions {
  topK?: number;
  tags?: string[];
  maxChars?: number;
}

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_OVERLAP = 120;
const DEFAULT_TOP_K = 3;
const DEFAULT_MAX_CHARS = 2400;

const STOPWORDS = new Set([
  // PT
  'a', 'o', 'de', 'do', 'da', 'em', 'para', 'com', 'que', 'e',
  // EN
  'the', 'is', 'in', 'to', 'of', 'and', 'for', 'on', 'with', 'an',
]);

/**
 * Tokeniza texto: lowercase, NFD sem acentos, preserva tokens técnicos compostos
 * (flags CLI `--dry-run`, IPs `10.0.0.1`, paths `/etc/nginx`, versões `0.8.0`, termos com hífen)
 * junto com as palavras alfanuméricas normalizadas, ignorando stopwords PT/EN.
 */
export function tokenize(input: string): string[] {
  const normalized = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!normalized) return [];

  const rawChunks = normalized.split(/[\s,;()[\]{}"'<>`]+/);
  const out: string[] = [];

  for (const raw of rawChunks) {
    if (!raw) continue;

    // Preserva token técnico composto (ex.: --dry-run, 10.0.0.1, /etc/nginx, 0.8.0, anti-ssrf)
    const candidate = raw.replace(/^[^a-z0-9/-]+/, '').replace(/[^a-z0-9]+$/, '');
    const hasTechSep = candidate.length > 0 && /[-./_]/.test(candidate) && /[a-z0-9]/.test(candidate);
    if (hasTechSep && /^[a-z0-9/_.-]+$/.test(candidate) && !STOPWORDS.has(candidate)) {
      out.push(candidate);
    }

    const subWords = raw.split(/[^a-z0-9]+/);
    for (const w of subWords) {
      if (!w || STOPWORDS.has(w)) continue;
      out.push(w);
    }
  }

  return out;
}

/** Quebra uma string longa em fatias de no máximo `limit` chars com `overlap`. */
function sliceWithOverlap(text: string, limit: number, overlap: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const effOverlap = Math.max(0, Math.min(overlap, Math.floor(limit / 2)));
  const step = Math.max(1, limit - effOverlap);
  const slices: string[] = [];
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(clean.length, start + limit);
    if (end < clean.length) {
      // Tenta recuar para uma fronteira de espaço/nova linha próxima para não cortar palavras ao meio
      const searchStart = start + Math.floor(limit * 0.6);
      const lastBreak = Math.max(
        clean.lastIndexOf('\n', end),
        clean.lastIndexOf(' ', end),
      );
      if (lastBreak >= searchStart) {
        end = lastBreak;
      }
    }
    const piece = clean.slice(start, end).trim();
    if (piece) slices.push(piece);
    if (end >= clean.length) break;
    const nextStart = Math.max(start + 1, end - effOverlap);
    start = nextStart > start + step ? start + step : nextStart;
  }

  return slices;
}

/** Subdivide um corpo de texto por parágrafos com tamanho máximo `bodyLimit` e `overlap`. */
function splitParagraphsWithOverlap(body: string, bodyLimit: number, overlap: number): string[] {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return [];

  const effOverlap = Math.max(0, Math.min(overlap, Math.floor(bodyLimit / 2)));
  const blocks: string[] = [];
  let current = '';

  const flushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) blocks.push(trimmed);
  };

  for (const para of paragraphs) {
    if (!current) {
      if (para.length <= bodyLimit) {
        current = para;
      } else {
        for (const piece of sliceWithOverlap(para, bodyLimit, effOverlap)) {
          blocks.push(piece);
        }
      }
      continue;
    }

    const candidate = `${current}\n\n${para}`;
    if (candidate.length <= bodyLimit) {
      current = candidate;
      continue;
    }

    // Fecha bloco atual e inicia próximo carregando tail de overlap
    flushCurrent();
    const tail = effOverlap > 0 ? current.slice(-effOverlap).trim() : '';

    if (para.length > bodyLimit) {
      const combined = tail ? `${tail}\n\n${para}` : para;
      const slices = sliceWithOverlap(combined, bodyLimit, effOverlap);
      for (let i = 0; i < slices.length - 1; i++) {
        blocks.push(slices[i]);
      }
      current = slices[slices.length - 1] ?? '';
    } else if (tail && tail.length + 2 + para.length <= bodyLimit) {
      current = `${tail}\n\n${para}`;
    } else {
      current = para;
    }
  }

  flushCurrent();
  return blocks;
}

interface MarkdownSection {
  headingPath: string;
  body: string;
}

/** Divide texto Markdown preservando a hierarquia de headings (#, ##, ###) e ignorando code fences. */
function splitMarkdownSections(text: string): MarkdownSection[] {
  const lines = text.split('\n');
  const headingStack: string[] = []; // índice 0 = #, 1 = ##, 2 = ###
  const sections: MarkdownSection[] = [];
  let buf: string[] = [];
  let inCodeFence = false;

  const currentHeadingPath = () => headingStack.filter(Boolean).join(' > ');

  const pushSection = () => {
    const body = buf.join('\n').trim();
    if (body) {
      sections.push({ headingPath: currentHeadingPath(), body });
    }
    buf = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      buf.push(line);
      continue;
    }

    if (!inCodeFence) {
      const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
      if (m) {
        pushSection();
        const level = m[1].length; // 1..6
        const title = m[2].trim();
        headingStack.length = level - 1;
        headingStack[level - 1] = title;
        continue;
      }
    }

    buf.push(line);
  }

  pushSection();
  return sections;
}

/**
 * Quebra um documento em chunks indexáveis.
 * - `.md`: preserva hierarquia de headings (`#`, `##`, `###`) com prefixo `[name > headingPath] `.
 * - `.txt`, `.pdf`, `.yaml`, `.yml`, `.json` e outros: quebra por parágrafo com overlap.
 */
export function chunkDocument(name: string, text: string, opts?: ChunkOptions): ContextChunk[] {
  const normalized = (text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  const chunkSize = Math.max(80, opts?.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, opts?.overlap ?? DEFAULT_OVERLAP);
  const tags = Array.isArray(opts?.tags) ? [...opts.tags] : [];
  const isMarkdown = name.toLowerCase().endsWith('.md');

  const chunks: ContextChunk[] = [];
  let idx = 0;

  if (isMarkdown) {
    const sections = splitMarkdownSections(normalized);
    if (sections.length === 0) return [];

    for (const sec of sections) {
      const prefix = sec.headingPath ? `[${name} > ${sec.headingPath}] ` : `[${name}] `;
      if (prefix.length + sec.body.length <= chunkSize) {
        chunks.push({
          id: `${name}#${idx++}`,
          docName: name,
          heading: sec.headingPath || undefined,
          text: `${prefix}${sec.body}`,
          tags: [...tags],
        });
      } else {
        const bodyLimit = Math.max(80, chunkSize - prefix.length);
        const subBlocks = splitParagraphsWithOverlap(sec.body, bodyLimit, overlap);
        for (const sub of subBlocks) {
          chunks.push({
            id: `${name}#${idx++}`,
            docName: name,
            heading: sec.headingPath || undefined,
            text: `${prefix}${sub}`,
            tags: [...tags],
          });
        }
      }
    }
    return chunks;
  }

  const blocks = splitParagraphsWithOverlap(normalized, chunkSize, overlap);
  for (const block of blocks) {
    chunks.push({
      id: `${name}#${idx++}`,
      docName: name,
      text: block,
      tags: [...tags],
    });
  }
  return chunks;
}

/**
 * Busca os chunks mais relevantes via BM25 puro em JS (`k1 = 1.5`, `b = 0.75`).
 * Filtra opcionalmente por `tags` (case-insensitive) e respeita `topK` e `maxChars`.
 */
export function searchChunks(docs: ContextDocument[], query: string, opts?: SearchOptions): ContextChunk[] {
  const topK = Math.max(0, opts?.topK ?? DEFAULT_TOP_K);
  const maxChars = Math.max(0, opts?.maxChars ?? DEFAULT_MAX_CHARS);
  if (topK === 0 || maxChars === 0) return [];

  const queryTerms = Array.from(new Set(tokenize(query ?? '')));
  if (queryTerms.length === 0) return [];

  const filterTags =
    opts?.tags && opts.tags.length > 0
      ? new Set(opts.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))
      : null;

  const pool: ContextChunk[] = [];
  for (const doc of docs ?? []) {
    const docTags = Array.isArray(doc.tags) ? doc.tags : [];
    const docChunks =
      Array.isArray(doc.chunks) && doc.chunks.length > 0
        ? doc.chunks
        : doc.text
          ? chunkDocument(doc.name, doc.text, { tags: docTags })
          : [];

    for (const chunk of docChunks) {
      if (filterTags && filterTags.size > 0) {
        const combinedTags = [...docTags, ...(Array.isArray(chunk.tags) ? chunk.tags : [])];
        const hasMatch = combinedTags.some((t) => filterTags.has(t.trim().toLowerCase()));
        if (!hasMatch) continue;
      }
      pool.push(chunk);
    }
  }

  const N = pool.length;
  if (N === 0) return [];

  // Tokenização dos chunks e cálculo de document frequency (df)
  const k1 = 1.5;
  const b = 0.75;
  const querySet = new Set(queryTerms);
  const docLens: number[] = new Array(N);
  const termFreqs: Map<string, number>[] = new Array(N);
  const df = new Map<string, number>();
  let totalLen = 0;

  for (let i = 0; i < N; i++) {
    const tokens = tokenize(pool[i].text);
    docLens[i] = tokens.length;
    totalLen += tokens.length;

    const tf = new Map<string, number>();
    for (const tok of tokens) {
      if (!querySet.has(tok)) continue;
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
    termFreqs[i] = tf;

    for (const term of tf.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const avgdl = totalLen / N;
  if (avgdl <= 0) return [];

  // Score BM25 (IDF suavizado de Lucene garante valor positivo mesmo em corpus pequeno)
  const scored: Array<{ chunk: ContextChunk; score: number }> = [];
  for (let i = 0; i < N; i++) {
    const tfMap = termFreqs[i];
    if (tfMap.size === 0) continue;

    const dl = docLens[i];
    let score = 0;
    for (const [term, tf] of tfMap.entries()) {
      const nqi = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - nqi + 0.5) / (nqi + 0.5));
      const denom = tf + k1 * (1 - b + b * (dl / avgdl));
      score += idf * ((tf * (k1 + 1)) / denom);
    }
    if (score > 0) {
      scored.push({ chunk: pool[i], score });
    }
  }

  scored.sort((a, bItem) => bItem.score - a.score);

  const selected: ContextChunk[] = [];
  let accChars = 0;
  for (const item of scored) {
    if (selected.length >= topK) break;
    const len = item.chunk.text.length;
    if (accChars + len <= maxChars) {
      selected.push(item.chunk);
      accChars += len;
    } else if (selected.length === 0 && maxChars > 0) {
      // Garante retorno truncado caso o único/primeiro chunk relevante já exceda maxChars
      selected.push({ ...item.chunk, text: item.chunk.text.slice(0, maxChars) });
      accChars = maxChars;
      break;
    }
  }

  return selected;
}

/** Formata os chunks selecionados no bloco padrão de injeção de contexto. */
export function formatContextBlock(chunks: ContextChunk[], maxChars?: number): string {
  if (!chunks || chunks.length === 0) return '';
  const header = '[DOCUMENTAÇÃO OFICIAL RELEVANTE]\n';
  const body = chunks.map((c) => c.text).join('\n\n---\n\n');
  const full = `${header}${body}`;
  if (maxChars !== undefined && maxChars > 0 && full.length > maxChars) {
    return full.slice(0, maxChars);
  }
  return full;
}
