// falador-nodes — tool.workflow: provedor de tools restrito a workflows em flowsDir/*.json e AGENTS.md (zero deps)
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import {
  createRegistry,
  pipeDelay,
  pipeParcs,
  sinkCollect,
  sourceTone,
  validateFlow,
  type FlowSpec,
  type NodeCtx,
  type NodeRuntime,
  type NodeTypeDef,
  type ParamError,
  type ToolCallResult,
  type ToolDef,
  type ToolProvider,
} from '../../falador-graph/src/index.ts';
import { registerFaladorNodes } from './index.ts';

const DEFAULT_FLOWS_DIR = 'apps/tui/flows';
const DEFAULT_AGENTS_MD_PATH = 'AGENTS.md';
const DEFAULT_AUDIT_LOG_PATH = 'logs/exec-audit.jsonl';
const DEFAULT_KNOWLEDGE_MAX_CHARS = 8000;
const PROTECTED_WORKFLOW_NAME = 'agente-workflows';
const KNOWLEDGE_SECTION_HEADER = '## Conhecimento de Workflows (auto-atualizado)';

const FLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export interface WorkflowAuditEntry {
  ts: string;
  runId: string;
  nodeId: string;
  tool: string;
  target: string;
  dryRun: boolean;
  decision: 'allowed' | 'dry_run' | 'denied';
  reason?: string;
}

export function sanitizeFlowName(
  name: unknown,
): { ok: true; name: string } | { ok: false; reason: string } {
  if (typeof name !== 'string') {
    return { ok: false, reason: 'Nome do workflow deve ser string.' };
  }
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, reason: 'Nome do workflow não pode ser vazio.' };
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..') || trimmed.startsWith('.')) {
    return { ok: false, reason: `Nome de workflow proibido (path traversal / oculto): "${name}"` };
  }
  if (!FLOW_NAME_RE.test(trimmed)) {
    return {
      ok: false,
      reason: `Nome de workflow inválido: "${name}". Use apenas [a-z0-9][a-z0-9_-]{0,63}.`,
    };
  }
  return { ok: true, name: trimmed };
}

export function resolveSafeFlowPath(
  flowsDir: string,
  name: unknown,
): { ok: true; path: string; name: string } | { ok: false; reason: string } {
  const sanitized = sanitizeFlowName(name);
  if (!sanitized.ok) return sanitized;

  const baseDir = resolve(flowsDir);
  const targetPath = resolve(baseDir, `${sanitized.name}.json`);
  const basePrefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;

  if (!targetPath.startsWith(basePrefix)) {
    return {
      ok: false,
      reason: `Caminho resolvido fora de flowsDir: ${targetPath}`,
    };
  }
  return { ok: true, path: targetPath, name: sanitized.name };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function writeWorkflowAudit(auditLogPath: string, entry: WorkflowAuditEntry, ctx: NodeCtx): void {
  try {
    mkdirSync(dirname(auditLogPath), { recursive: true });
    appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err: unknown) {
    ctx.log(
      'warn',
      `tool.workflow falha ao gravar audit log em ${auditLogPath}: ${(err as Error)?.message ?? String(err)}`,
    );
  }
}

function buildFullRegistry(): Map<string, NodeTypeDef> {
  const reg = registerFaladorNodes(createRegistry())
    .register(sourceTone)
    .register(pipeDelay)
    .register(pipeParcs)
    .register(sinkCollect);
  return reg.asMap();
}

function prepareFlowForValidation(flow: FlowSpec, regMap: Map<string, NodeTypeDef>): FlowSpec {
  const bindings: Record<string, Record<string, unknown>> = {};
  if (flow.bindings && typeof flow.bindings === 'object') {
    for (const [nodeId, b] of Object.entries(flow.bindings)) {
      bindings[nodeId] = { ...b };
    }
  }

  if (Array.isArray(flow.nodes)) {
    for (const n of flow.nodes) {
      if (!n || typeof n.id !== 'string' || typeof n.type !== 'string') continue;
      const def = regMap.get(n.type);
      if (!def) continue;
      const declared = new Set(def.bindingNames ?? []);
      const nodeBindings = { ...(bindings[n.id] ?? {}) };

      if (declared.has('__gate') && !('__gate' in nodeBindings)) {
        nodeBindings.__gate = { request: async () => null };
      }
      if (declared.has('__onCaption') && !('__onCaption' in nodeBindings)) {
        nodeBindings.__onCaption = () => {};
      }
      if (declared.has('__registerChatInput') && !('__registerChatInput' in nodeBindings)) {
        nodeBindings.__registerChatInput = () => {};
      }
      if (declared.has('__collect') && !('__collect' in nodeBindings)) {
        nodeBindings.__collect = { received: [] };
      }
      if (def.requiredBindings) {
        for (const reqKey of def.requiredBindings) {
          if (!(reqKey in nodeBindings)) {
            nodeBindings[reqKey] = {};
          }
        }
      }
      if (Object.keys(nodeBindings).length > 0) {
        bindings[n.id] = nodeBindings;
      }
    }
  }

  return {
    ...flow,
    bindings,
  };
}

function appendKnowledgeEntry(
  agentsMdPath: string,
  entry: string,
  dryRun: boolean,
): { line: string; preview: string; written: boolean } {
  const ts = new Date().toISOString();
  const cleanEntry = entry.trim().replace(/\r?\n/g, ' ');
  const bullet = `- [${ts}] ${cleanEntry}`;

  const existing = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8') : '';
  let nextContent: string;

  const headerIdx = existing.indexOf(KNOWLEDGE_SECTION_HEADER);
  if (headerIdx === -1) {
    const sepNewlines = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    nextContent = `${existing}${sepNewlines}${KNOWLEDGE_SECTION_HEADER}\n\n${bullet}\n`;
  } else {
    const afterHeader = headerIdx + KNOWLEDGE_SECTION_HEADER.length;
    const rest = existing.slice(afterHeader);
    // Procura próxima seção de nível 2 (`\n## `) para inserir antes dela, ou no fim do arquivo
    const nextSectionMatch = /\r?\n## /.exec(rest);
    if (nextSectionMatch) {
      const insertPos = afterHeader + nextSectionMatch.index;
      const before = existing.slice(0, insertPos).replace(/\s*$/, '');
      const after = existing.slice(insertPos);
      nextContent = `${before}\n${bullet}\n${after}`;
    } else {
      const trimmedEnd = existing.replace(/\s*$/, '');
      nextContent = `${trimmedEnd}\n${bullet}\n`;
    }
  }

  if (!dryRun) {
    mkdirSync(dirname(resolve(agentsMdPath)), { recursive: true });
    writeFileSync(agentsMdPath, nextContent, 'utf8');
  }

  return {
    line: bullet,
    preview: nextContent.slice(Math.max(0, nextContent.length - 500)),
    written: !dryRun,
  };
}

export const toolWorkflow: NodeTypeDef = {
  type: 'tool.workflow',
  paramNames: ['flowsDir', 'agentsMdPath', 'dryRun', 'allowDelete', 'auditLogPath'],
  inputs: [],
  outputs: [{ name: 'tool', type: 'tool', required: false }],
  validateParams: (p): ParamError[] => {
    const errs: ParamError[] = [];
    if (p.flowsDir !== undefined && (typeof p.flowsDir !== 'string' || p.flowsDir.trim().length === 0)) {
      errs.push({ path: 'params.flowsDir', code: 'INVALID_PARAM', message: 'flowsDir deve ser string não vazia' });
    }
    if (p.agentsMdPath !== undefined && (typeof p.agentsMdPath !== 'string' || p.agentsMdPath.trim().length === 0)) {
      errs.push({ path: 'params.agentsMdPath', code: 'INVALID_PARAM', message: 'agentsMdPath deve ser string não vazia' });
    }
    if (p.dryRun !== undefined && typeof p.dryRun !== 'boolean') {
      errs.push({ path: 'params.dryRun', code: 'INVALID_PARAM', message: 'dryRun deve ser boolean' });
    }
    if (p.allowDelete !== undefined && typeof p.allowDelete !== 'boolean') {
      errs.push({ path: 'params.allowDelete', code: 'INVALID_PARAM', message: 'allowDelete deve ser boolean' });
    }
    if (p.auditLogPath !== undefined && (typeof p.auditLogPath !== 'string' || p.auditLogPath.trim().length === 0)) {
      errs.push({ path: 'params.auditLogPath', code: 'INVALID_PARAM', message: 'auditLogPath deve ser string não vazia' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const flowsDir = (ctx.params.flowsDir as string | undefined) ?? DEFAULT_FLOWS_DIR;
    const agentsMdPath = (ctx.params.agentsMdPath as string | undefined) ?? DEFAULT_AGENTS_MD_PATH;
    const dryRun = (ctx.params.dryRun as boolean | undefined) ?? false;
    const allowDelete = (ctx.params.allowDelete as boolean | undefined) ?? false;
    const auditLogPath = (ctx.params.auditLogPath as string | undefined) ?? DEFAULT_AUDIT_LOG_PATH;

    const defs: ToolDef[] = [
      {
        name: 'workflow_list',
        description: `Lista todos os workflows (.json) disponíveis em ${flowsDir}.`,
        parameters: { type: 'object', properties: {} },
        readonly: true,
        sourceNodeId: ctx.id,
      },
      {
        name: 'workflow_get',
        description: 'Lê o JSON completo de um workflow pelo nome (sem extensão .json).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nome do workflow (ex.: chat-agente-suporte).' },
          },
          required: ['name'],
        },
        readonly: true,
        sourceNodeId: ctx.id,
      },
      {
        name: 'workflow_catalog',
        description: 'Lista todos os tipos de nós disponíveis no catálogo do Falador (entradas, saídas e parâmetros).',
        parameters: { type: 'object', properties: {} },
        readonly: true,
        sourceNodeId: ctx.id,
      },
      {
        name: 'workflow_save',
        description:
          'Valida (via validateFlow) e grava um workflow em flowsDir/<name>.json, atualizando automaticamente o AGENTS.md.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nome do workflow (apenas letras, números, _ e -).' },
            flow: { type: 'object', description: 'Objeto FlowSpec completo (version: 1, nodes, edges).' },
            changeSummary: {
              type: 'string',
              description: 'Resumo opcional da criação/alteração para registrar no AGENTS.md.',
            },
          },
          required: ['name', 'flow'],
        },
        readonly: false,
        sourceNodeId: ctx.id,
      },
      {
        name: 'workflow_delete',
        description: 'Remove um workflow em flowsDir/<name>.json (requer allowDelete=true; nunca deleta agente-workflows).',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Nome do workflow a remover.' },
          },
          required: ['name'],
        },
        readonly: false,
        sourceNodeId: ctx.id,
      },
      {
        name: 'knowledge_read',
        description: 'Lê o arquivo de conhecimento do projeto (AGENTS.md) para obter contexto atualizado.',
        parameters: {
          type: 'object',
          properties: {
            maxChars: { type: 'number', description: 'Limite máximo de caracteres (default 8000).' },
          },
        },
        readonly: true,
        sourceNodeId: ctx.id,
      },
      {
        name: 'knowledge_update',
        description: 'Adiciona uma entrada com data/hora na seção de conhecimento de workflows do AGENTS.md.',
        parameters: {
          type: 'object',
          properties: {
            entry: { type: 'string', description: 'Texto conciso da atualização de conhecimento.' },
          },
          required: ['entry'],
        },
        readonly: false,
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
        const runId = opts.runId || 'unknown';

        if (opts.signal.aborted || ctx.signal.aborted) {
          return {
            ok: false,
            output: 'Operação cancelada (signal abortado).',
            durationMs: Date.now() - t0,
            meta: { interrupted: true },
          };
        }

        if (toolName === 'workflow_list') {
          const baseDir = resolve(flowsDir);
          if (!existsSync(baseDir)) {
            return { ok: true, output: '[]', durationMs: Date.now() - t0, meta: { count: 0 } };
          }
          const files = readdirSync(baseDir)
            .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
            .sort();
          const items: Array<{ name: string; description: string; nodesCount: number; edgesCount: number }> = [];
          for (const file of files) {
            const name = file.slice(0, -5);
            const checked = resolveSafeFlowPath(flowsDir, name);
            if (!checked.ok) continue;
            try {
              const parsed = JSON.parse(readFileSync(checked.path, 'utf8')) as {
                description?: unknown;
                nodes?: unknown[];
                edges?: unknown[];
              };
              items.push({
                name,
                description: typeof parsed.description === 'string' ? parsed.description : '',
                nodesCount: Array.isArray(parsed.nodes) ? parsed.nodes.length : 0,
                edgesCount: Array.isArray(parsed.edges) ? parsed.edges.length : 0,
              });
            } catch {
              items.push({ name, description: '(JSON inválido)', nodesCount: 0, edgesCount: 0 });
            }
          }
          ctx.metrics.counter('tool.workflow.list', 1);
          return {
            ok: true,
            output: JSON.stringify(items, null, 2),
            durationMs: Date.now() - t0,
            meta: { count: items.length },
          };
        }

        if (toolName === 'workflow_get') {
          const checked = resolveSafeFlowPath(flowsDir, args.name);
          if (!checked.ok) {
            ctx.metrics.counter('tool.workflow.denied', 1);
            return {
              ok: false,
              output: `INVALID_FLOW_NAME: ${checked.reason}`,
              durationMs: Date.now() - t0,
              meta: { code: 'INVALID_FLOW_NAME' },
            };
          }
          if (!existsSync(checked.path)) {
            return {
              ok: false,
              output: `Workflow "${checked.name}" não encontrado.`,
              durationMs: Date.now() - t0,
              meta: { code: 'NOT_FOUND', name: checked.name },
            };
          }
          if (isSymlink(checked.path)) {
            ctx.metrics.counter('tool.workflow.denied', 1);
            return {
              ok: false,
              output: `SYMLINK_BLOCKED: "${checked.name}.json" é um symlink; leitura recusada por segurança.`,
              durationMs: Date.now() - t0,
              meta: { code: 'SYMLINK_BLOCKED', name: checked.name },
            };
          }
          const content = readFileSync(checked.path, 'utf8');
          ctx.metrics.counter('tool.workflow.get', 1);
          return {
            ok: true,
            output: content,
            durationMs: Date.now() - t0,
            meta: { name: checked.name },
          };
        }

        if (toolName === 'workflow_catalog') {
          const regMap = buildFullRegistry();
          const catalog = [...regMap.values()].map((def) => ({
            type: def.type,
            sourceOnly: def.sourceOnly === true,
            sink: def.sink === true,
            paramNames: def.paramNames ?? [],
            inputs: (def.inputs ?? []).map((p) => ({ name: p.name, type: p.type })),
            outputs: (def.outputs ?? []).map((p) => ({ name: p.name, type: p.type, required: p.required !== false })),
            dynamicOutputs: typeof def.outputsFor === 'function',
          }));
          ctx.metrics.counter('tool.workflow.catalog', 1);
          return {
            ok: true,
            output: JSON.stringify(catalog, null, 2),
            durationMs: Date.now() - t0,
            meta: { count: catalog.length },
          };
        }

        if (toolName === 'workflow_save') {
          const checked = resolveSafeFlowPath(flowsDir, args.name);
          if (!checked.ok) {
            ctx.metrics.counter('tool.workflow.denied', 1);
            writeWorkflowAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                tool: toolName,
                target: String(args.name ?? ''),
                dryRun,
                decision: 'denied',
                reason: checked.reason,
              },
              ctx,
            );
            return {
              ok: false,
              output: `INVALID_FLOW_NAME: ${checked.reason}`,
              durationMs: Date.now() - t0,
              meta: { code: 'INVALID_FLOW_NAME' },
            };
          }

          let rawFlow: unknown = args.flow;
          if (typeof rawFlow === 'string') {
            try {
              rawFlow = JSON.parse(rawFlow);
            } catch (err: unknown) {
              return {
                ok: false,
                output: `VALIDATION_ERROR: JSON inválido em flow: ${(err as Error)?.message ?? String(err)}`,
                durationMs: Date.now() - t0,
                meta: { code: 'VALIDATION_ERROR' },
              };
            }
          }
          if (!rawFlow || typeof rawFlow !== 'object' || Array.isArray(rawFlow)) {
            return {
              ok: false,
              output: 'VALIDATION_ERROR: parâmetro "flow" deve ser um objeto FlowSpec.',
              durationMs: Date.now() - t0,
              meta: { code: 'VALIDATION_ERROR' },
            };
          }

          const flowObj = rawFlow as FlowSpec & { description?: string };
          const regMap = buildFullRegistry();
          try {
            const prepared = prepareFlowForValidation(flowObj, regMap);
            validateFlow(prepared, regMap);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.metrics.counter('tool.workflow.validation_error', 1);
            writeWorkflowAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                tool: toolName,
                target: checked.path,
                dryRun,
                decision: 'denied',
                reason: `VALIDATION_ERROR: ${msg}`,
              },
              ctx,
            );
            return {
              ok: false,
              output: `VALIDATION_ERROR: ${msg}`,
              durationMs: Date.now() - t0,
              meta: { code: 'VALIDATION_ERROR', name: checked.name },
            };
          }

          const serialized = `${JSON.stringify(flowObj, null, 2)}\n`;
          const summaryRaw = typeof args.changeSummary === 'string' ? args.changeSummary.trim() : '';
          const desc = typeof flowObj.description === 'string' ? flowObj.description.trim() : '';
          const nodesCount = Array.isArray(flowObj.nodes) ? flowObj.nodes.length : 0;
          const edgesCount = Array.isArray(flowObj.edges) ? flowObj.edges.length : 0;
          const knowledgeEntry = summaryRaw
            ? `Workflow "${checked.name}" salvo (${nodesCount} nós, ${edgesCount} edges): ${summaryRaw}`
            : `Workflow "${checked.name}" salvo (${nodesCount} nós, ${edgesCount} edges)${desc ? ` — ${desc}` : ''}`;

          if (dryRun) {
            writeWorkflowAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                tool: toolName,
                target: checked.path,
                dryRun: true,
                decision: 'dry_run',
              },
              ctx,
            );
            ctx.metrics.counter('tool.workflow.dry_run', 1);
            return {
              ok: true,
              output: `[dryRun] Workflow "${checked.name}" validado com sucesso (${nodesCount} nós, ${edgesCount} edges). Nenhum arquivo gravado.\nPreview AGENTS.md: ${knowledgeEntry}`,
              durationMs: Date.now() - t0,
              meta: { dryRun: true, name: checked.name, nodesCount, edgesCount },
            };
          }

          if (isSymlink(checked.path)) {
            const reason = `SYMLINK_BLOCKED: "${checked.name}.json" é um symlink; gravação recusada por segurança.`;
            ctx.metrics.counter('tool.workflow.denied', 1);
            writeWorkflowAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                tool: toolName,
                target: checked.path,
                dryRun,
                decision: 'denied',
                reason,
              },
              ctx,
            );
            return {
              ok: false,
              output: reason,
              durationMs: Date.now() - t0,
              meta: { code: 'SYMLINK_BLOCKED', name: checked.name },
            };
          }

          mkdirSync(dirname(checked.path), { recursive: true });
          writeFileSync(checked.path, serialized, 'utf8');
          const kb = appendKnowledgeEntry(agentsMdPath, knowledgeEntry, false);
          writeWorkflowAudit(
            auditLogPath,
            {
              ts: new Date().toISOString(),
              runId,
              nodeId: ctx.id,
              tool: toolName,
              target: checked.path,
              dryRun: false,
              decision: 'allowed',
            },
            ctx,
          );
          ctx.metrics.counter('tool.workflow.save', 1);
          return {
            ok: true,
            output: `Workflow "${checked.name}" validado e salvo em ${checked.name}.json (${nodesCount} nós, ${edgesCount} edges). AGENTS.md atualizado: ${kb.line}`,
            durationMs: Date.now() - t0,
            meta: { dryRun: false, name: checked.name, path: checked.path, nodesCount, edgesCount },
          };
        }

        if (toolName === 'workflow_delete') {
          const checked = resolveSafeFlowPath(flowsDir, args.name);
          if (!checked.ok) {
            ctx.metrics.counter('tool.workflow.denied', 1);
            writeWorkflowAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                tool: toolName,
                target: String(args.name ?? ''),
                dryRun,
                decision: 'denied',
                reason: checked.reason,
              },
              ctx,
            );
            return {
              ok: false,
              output: `INVALID_FLOW_NAME: ${checked.reason}`,
              durationMs: Date.now() - t0,
              meta: { code: 'INVALID_FLOW_NAME' },
            };
          }

          if (!allowDelete) {
            const reason = 'Remoção desabilitada (allowDelete=false).';
            ctx.metrics.counter('tool.workflow.denied', 1);
            writeWorkflowAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                tool: toolName,
                target: checked.path,
                dryRun,
                decision: 'denied',
                reason,
              },
              ctx,
            );
            return {
              ok: false,
              output: `DELETE_DENIED: ${reason}`,
              durationMs: Date.now() - t0,
              meta: { code: 'DELETE_DENIED', name: checked.name },
            };
          }

          if (checked.name.toLowerCase() === PROTECTED_WORKFLOW_NAME) {
            const reason = `Workflow "${PROTECTED_WORKFLOW_NAME}" é protegido e nunca pode ser deletado.`;
            ctx.metrics.counter('tool.workflow.denied', 1);
            writeWorkflowAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                tool: toolName,
                target: checked.path,
                dryRun,
                decision: 'denied',
                reason,
              },
              ctx,
            );
            return {
              ok: false,
              output: `DELETE_PROTECTED: ${reason}`,
              durationMs: Date.now() - t0,
              meta: { code: 'DELETE_PROTECTED', name: checked.name },
            };
          }

          if (!existsSync(checked.path)) {
            return {
              ok: false,
              output: `Workflow "${checked.name}" não encontrado.`,
              durationMs: Date.now() - t0,
              meta: { code: 'NOT_FOUND', name: checked.name },
            };
          }
          if (isSymlink(checked.path)) {
            ctx.metrics.counter('tool.workflow.denied', 1);
            return {
              ok: false,
              output: `SYMLINK_BLOCKED: "${checked.name}.json" é um symlink; remoção recusada por segurança.`,
              durationMs: Date.now() - t0,
              meta: { code: 'SYMLINK_BLOCKED', name: checked.name },
            };
          }

          if (dryRun) {
            writeWorkflowAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                tool: toolName,
                target: checked.path,
                dryRun: true,
                decision: 'dry_run',
              },
              ctx,
            );
            return {
              ok: true,
              output: `[dryRun] Workflow "${checked.name}" seria removido (nenhum arquivo alterado).`,
              durationMs: Date.now() - t0,
              meta: { dryRun: true, name: checked.name },
            };
          }

          unlinkSync(checked.path);
          writeWorkflowAudit(
            auditLogPath,
            {
              ts: new Date().toISOString(),
              runId,
              nodeId: ctx.id,
              tool: toolName,
              target: checked.path,
              dryRun: false,
              decision: 'allowed',
            },
            ctx,
          );
          ctx.metrics.counter('tool.workflow.delete', 1);
          return {
            ok: true,
            output: `Workflow "${checked.name}" removido com sucesso.`,
            durationMs: Date.now() - t0,
            meta: { dryRun: false, name: checked.name },
          };
        }

        if (toolName === 'knowledge_read') {
          const rawMax = args.maxChars;
          const maxChars =
            typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
              ? Math.floor(rawMax)
              : DEFAULT_KNOWLEDGE_MAX_CHARS;

          if (!existsSync(agentsMdPath)) {
            return {
              ok: true,
              output: '(arquivo AGENTS.md não encontrado)',
              durationMs: Date.now() - t0,
              meta: { exists: false },
            };
          }
          const raw = readFileSync(agentsMdPath, 'utf8');
          const truncated = raw.length > maxChars;
          const out = truncated ? `${raw.slice(0, maxChars)}\n[...truncado em ${maxChars} chars]` : raw;
          ctx.metrics.counter('tool.workflow.knowledge_read', 1);
          return {
            ok: true,
            output: out,
            durationMs: Date.now() - t0,
            meta: { exists: true, totalChars: raw.length, truncated },
          };
        }

        if (toolName === 'knowledge_update') {
          const entry = typeof args.entry === 'string' ? args.entry.trim() : '';
          if (!entry) {
            return {
              ok: false,
              output: 'Parâmetro "entry" é obrigatório e não pode ser vazio.',
              durationMs: Date.now() - t0,
            };
          }
          const res = appendKnowledgeEntry(agentsMdPath, entry, dryRun);
          writeWorkflowAudit(
            auditLogPath,
            {
              ts: new Date().toISOString(),
              runId,
              nodeId: ctx.id,
              tool: toolName,
              target: resolve(agentsMdPath),
              dryRun,
              decision: dryRun ? 'dry_run' : 'allowed',
            },
            ctx,
          );
          ctx.metrics.counter('tool.workflow.knowledge_update', 1);
          return {
            ok: true,
            output: dryRun
              ? `[dryRun] Entrada preparada para AGENTS.md: ${res.line}`
              : `AGENTS.md atualizado: ${res.line}`,
            durationMs: Date.now() - t0,
            meta: { dryRun, written: res.written },
          };
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
