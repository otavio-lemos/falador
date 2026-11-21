// falador-nodes — rag.search: expõe context-store.ts (BM25) como ToolProvider sob demanda (ADR-008 Fase 2, ZERO deps)
import { existsSync, readFileSync } from 'node:fs';
import {
  type NodeCtx,
  type NodeRuntime,
  type NodeTypeDef,
  type ParamError,
  type ToolCallResult,
  type ToolDef,
  type ToolProvider,
} from '../../falador-graph/src/index.ts';
import { formatContextBlock, searchChunks, type ContextDocument } from './context-store.ts';

const DEFAULT_TOOL_NAME = 'search_docs';
const DEFAULT_TOP_K = 3;
const DEFAULT_MAX_CHARS = 2400;
const DEFAULT_DOCS_PATH = 'context/docs.json';

type DocsGetter = () => ContextDocument[] | Promise<ContextDocument[]>;

async function loadDocuments(ctx: NodeCtx, docsPath: string): Promise<ContextDocument[]> {
  const getter = ctx.bindings?.__getDocs as DocsGetter | undefined;
  if (typeof getter === 'function') {
    const res = await getter();
    return Array.isArray(res) ? res : [];
  }

  if (!existsSync(docsPath)) {
    return [];
  }

  const raw = readFileSync(docsPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as ContextDocument[];
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { docs?: unknown }).docs)) {
    return (parsed as { docs: ContextDocument[] }).docs;
  }
  return [];
}

export const ragSearch: NodeTypeDef = {
  type: 'rag.search',
  paramNames: ['toolName', 'topK', 'tags', 'maxChars', 'docsPath'],
  bindingNames: ['__getDocs'],
  inputs: [],
  outputs: [{ name: 'tool', type: 'tool', required: false }],
  validateParams: (p): ParamError[] => {
    const errs: ParamError[] = [];
    if (p.toolName !== undefined && (typeof p.toolName !== 'string' || p.toolName.trim().length === 0)) {
      errs.push({ path: 'params.toolName', code: 'INVALID_PARAM', message: 'toolName deve ser string não vazia' });
    }
    if (p.topK !== undefined && (typeof p.topK !== 'number' || Number.isNaN(p.topK) || p.topK <= 0)) {
      errs.push({ path: 'params.topK', code: 'INVALID_PARAM', message: 'topK deve ser número positivo' });
    }
    if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== 'string'))) {
      errs.push({ path: 'params.tags', code: 'INVALID_PARAM', message: 'tags deve ser string[]' });
    }
    if (p.maxChars !== undefined && (typeof p.maxChars !== 'number' || Number.isNaN(p.maxChars) || p.maxChars <= 0)) {
      errs.push({ path: 'params.maxChars', code: 'INVALID_PARAM', message: 'maxChars deve ser número positivo' });
    }
    if (p.docsPath !== undefined && typeof p.docsPath !== 'string') {
      errs.push({ path: 'params.docsPath', code: 'INVALID_PARAM', message: 'docsPath deve ser string' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const toolName = ((ctx.params.toolName as string | undefined) ?? DEFAULT_TOOL_NAME).trim() || DEFAULT_TOOL_NAME;
    const topK = (ctx.params.topK as number | undefined) ?? DEFAULT_TOP_K;
    const defaultTags = ctx.params.tags as string[] | undefined;
    const maxChars = (ctx.params.maxChars as number | undefined) ?? DEFAULT_MAX_CHARS;
    const docsPath = (ctx.params.docsPath as string | undefined) ?? DEFAULT_DOCS_PATH;

    const toolDef: ToolDef = {
      name: toolName,
      description: `Busca BM25 em runbooks e documentação local (${
        defaultTags && defaultTags.length > 0 ? `tags padrão: ${defaultTags.join(', ')}` : 'todas as tags'
      }, topK=${topK}).`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Termos ou pergunta técnica para buscar na base local.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filtro opcional de tags (case-insensitive).',
          },
        },
        required: ['query'],
      },
      readonly: true,
      sourceNodeId: ctx.id,
    };

    const toolProvider: ToolProvider = {
      listTools(): ToolDef[] {
        return [toolDef];
      },
      async invoke(
        name: string,
        args: Record<string, unknown>,
        opts: { signal: AbortSignal; runId: string; callerNodeId: string },
      ): Promise<ToolCallResult> {
        const t0 = Date.now();
        if (name !== toolName) {
          return {
            ok: false,
            output: `Tool desconhecida para ${ctx.id}: ${name} (esperado: ${toolName})`,
            durationMs: 0,
          };
        }
        if (opts.signal.aborted || ctx.signal.aborted) {
          return {
            ok: false,
            output: 'Busca cancelada (signal abortado).',
            durationMs: Date.now() - t0,
            meta: { interrupted: true },
          };
        }

        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) {
          return {
            ok: false,
            output: 'Parâmetro "query" é obrigatório e não pode ser vazio.',
            durationMs: Date.now() - t0,
          };
        }

        const argTags =
          Array.isArray(args.tags) && args.tags.every((t) => typeof t === 'string')
            ? (args.tags as string[])
            : undefined;
        const effectiveTags = argTags && argTags.length > 0 ? argTags : defaultTags;

        let docs: ContextDocument[];
        try {
          docs = await loadDocuments(ctx, docsPath);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.log('warn', `rag.search falha ao carregar documentos (${docsPath}): ${msg}`);
          return {
            ok: false,
            output: `Erro ao carregar base de documentos: ${msg}`,
            durationMs: Date.now() - t0,
          };
        }

        const chunks = searchChunks(docs, query, {
          topK,
          tags: effectiveTags,
          maxChars,
        });

        const durationMs = Date.now() - t0;
        ctx.metrics.counter('rag.search.queries', 1);
        ctx.metrics.timer('rag.search.durationMs', durationMs);

        if (chunks.length === 0) {
          return {
            ok: true,
            output: 'Nenhum trecho relevante encontrado na documentação local.',
            durationMs,
            meta: { hits: 0, query, tags: effectiveTags },
          };
        }

        const formatted = formatContextBlock(chunks, maxChars);
        return {
          ok: true,
          output: formatted,
          durationMs,
          meta: {
            hits: chunks.length,
            query,
            tags: effectiveTags,
            chunkIds: chunks.map((c) => c.id),
          },
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
