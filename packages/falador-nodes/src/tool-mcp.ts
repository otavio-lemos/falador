// falador-nodes — tool.mcp: cliente MCP (Model Context Protocol) JSON-RPC 2.0 zero-deps (ADR-008 Fase 3)
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  GraphError,
  type ControlMsg,
  type NodeCtx,
  type NodeRuntime,
  type NodeTypeDef,
  type ParamError,
  type ToolCallResult,
  type ToolDef,
  type ToolProvider,
} from '../../falador-graph/src/index.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_AUDIT_LOG_PATH = 'logs/exec-audit.jsonl';
const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'falador', version: '0.2.0' };

const FORBIDDEN_CMD_CHARS = /[;&|`$\n\r<>]/;
const HARD_DENY_BINARIES = new Set([
  'rm',
  'rmdir',
  'mkfs',
  'dd',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'passwd',
  'useradd',
  'userdel',
  'chown',
  'chmod',
  'kill',
  'killall',
  'pkill',
  'iptables',
  'nft',
]);

interface McpAuditEntry {
  ts: string;
  runId: string;
  nodeId: string;
  transport: 'mcp-stdio' | 'mcp-http';
  serverName?: string;
  target: string;
  tool: string;
  dryRun: boolean;
  decision: 'allowed' | 'dry_run' | 'denied';
  reason?: string;
  ok?: boolean;
  durationMs?: number;
}

interface McpRawTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
  };
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupSignal?: () => void;
}

export function validateMcpCommand(command: string): { ok: true; command: string } | { ok: false; reason: string } {
  const clean = (command ?? '').trim();
  if (!clean) {
    return { ok: false, reason: 'Parâmetro "command" obrigatório para transporte stdio' };
  }
  if (FORBIDDEN_CMD_CHARS.test(clean)) {
    return { ok: false, reason: `Caracteres de shell proibidos em command: ${clean}` };
  }
  const bin = basename(clean).toLowerCase();
  if (HARD_DENY_BINARIES.has(bin) || bin.startsWith('mkfs.')) {
    return { ok: false, reason: `Binário bloqueado pela denylist imutável: ${bin}` };
  }
  return { ok: true, command: clean };
}

export function validateMcpUrl(
  rawUrl: string,
  allowedUrls: string[],
): { ok: true; url: URL } | { ok: false; reason: string } {
  const clean = (rawUrl ?? '').trim();
  if (!clean) {
    return { ok: false, reason: 'Parâmetro "url" obrigatório para transporte http' };
  }
  let parsed: URL;
  try {
    parsed = new URL(clean);
  } catch {
    return { ok: false, reason: `URL MCP inválida: ${clean}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `Protocolo MCP não permitido: ${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase();
  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (isLocal) {
    return { ok: true, url: parsed };
  }
  const matched = allowedUrls.some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return false;
    if (clean === trimmed) return true;
    try {
      const allowed = new URL(trimmed);
      const allowedPrefix = allowed.pathname.endsWith('/') ? allowed.pathname : `${allowed.pathname}/`;
      return (
        allowed.origin === parsed.origin &&
        (parsed.pathname === allowed.pathname || parsed.pathname.startsWith(allowedPrefix))
      );
    } catch {
      return false;
    }
  });
  if (!matched) {
    return { ok: false, reason: `URL MCP fora de allowedUrls: ${clean}` };
  }
  return { ok: true, url: parsed };
}

export function buildFilteredEnv(
  envAllowlist: string[],
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  const allowedKeys = new Set<string>(['PATH', 'HOME']);
  for (const key of envAllowlist) {
    const k = key.trim();
    if (k) allowedKeys.add(k);
  }
  for (const key of allowedKeys) {
    const val = sourceEnv[key];
    if (typeof val === 'string') {
      filtered[key] = val;
    }
  }
  return filtered;
}

function writeMcpAudit(auditLogPath: string, entry: McpAuditEntry, ctx: NodeCtx): void {
  try {
    mkdirSync(dirname(auditLogPath), { recursive: true });
    appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err: unknown) {
    ctx.log('warn', `tool.mcp falha ao gravar audit log em ${auditLogPath}: ${(err as Error)?.message ?? String(err)}`);
  }
}

function extractMcpContent(result: unknown): { text: string; isError: boolean } {
  if (!result || typeof result !== 'object') {
    return { text: String(result ?? ''), isError: false };
  }
  const obj = result as { content?: unknown; isError?: unknown };
  const isError = Boolean(obj.isError);
  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const item of obj.content) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (rec.type === 'text' && typeof rec.text === 'string') {
          parts.push(rec.text);
        } else if (typeof rec.text === 'string') {
          parts.push(rec.text);
        } else {
          parts.push(JSON.stringify(rec));
        }
      } else if (typeof item === 'string') {
        parts.push(item);
      }
    }
    return { text: parts.join('\n'), isError };
  }
  return { text: JSON.stringify(result), isError };
}

function parseSseJsonRpc(body: string, expectedId: number): { result?: unknown; error?: { code?: number; message?: string } } | null {
  const events = body.split(/\r?\n\r?\n/);
  let fallback: { result?: unknown; error?: { code?: number; message?: string } } | null = null;
  for (const block of events) {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n').trim();
    if (!raw || raw === '[DONE]') continue;
    try {
      const parsed = JSON.parse(raw) as { id?: number; result?: unknown; error?: { code?: number; message?: string } };
      if (parsed.id === expectedId) return parsed;
      if ('result' in parsed || 'error' in parsed) fallback = parsed;
    } catch {
      /* ignora eventos SSE não-JSON */
    }
  }
  return fallback;
}

function killChildAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(hardWaitTimer);
      resolve();
    };

    child.once('exit', done);
    child.once('close', done);

    try {
      child.stdin?.end();
    } catch {
      /* stdin já fechado */
    }

    try {
      child.kill('SIGTERM');
    } catch {
      done();
      return;
    }

    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* já encerrado */
        }
      }
    }, 1000);
    killTimer.unref?.();

    const hardWaitTimer = setTimeout(done, 1500);
    hardWaitTimer.unref?.();
  });
}

export const toolMcp: NodeTypeDef = {
  type: 'tool.mcp',
  paramNames: [
    'serverName',
    'transport',
    'command',
    'args',
    'envAllowlist',
    'url',
    'allowedUrls',
    'allowedTools',
    'dryRun',
    'timeoutMs',
    'auditLogPath',
  ],
  inputs: [],
  outputs: [{ name: 'tool', type: 'tool', required: false }],
  validateParams: (p): ParamError[] => {
    const errs: ParamError[] = [];
    if (p.serverName !== undefined && typeof p.serverName !== 'string') {
      errs.push({ path: 'params.serverName', code: 'INVALID_PARAM', message: 'serverName deve ser string' });
    }
    if (p.transport !== undefined && p.transport !== 'stdio' && p.transport !== 'http') {
      errs.push({ path: 'params.transport', code: 'INVALID_PARAM', message: "transport deve ser 'stdio' ou 'http'" });
    }
    if (p.command !== undefined && typeof p.command !== 'string') {
      errs.push({ path: 'params.command', code: 'INVALID_PARAM', message: 'command deve ser string' });
    }
    if (p.args !== undefined && (!Array.isArray(p.args) || p.args.some((x) => typeof x !== 'string'))) {
      errs.push({ path: 'params.args', code: 'INVALID_PARAM', message: 'args deve ser string[]' });
    }
    if (p.envAllowlist !== undefined && (!Array.isArray(p.envAllowlist) || p.envAllowlist.some((x) => typeof x !== 'string'))) {
      errs.push({ path: 'params.envAllowlist', code: 'INVALID_PARAM', message: 'envAllowlist deve ser string[]' });
    }
    if (p.url !== undefined && typeof p.url !== 'string') {
      errs.push({ path: 'params.url', code: 'INVALID_PARAM', message: 'url deve ser string' });
    }
    if (p.allowedUrls !== undefined && (!Array.isArray(p.allowedUrls) || p.allowedUrls.some((x) => typeof x !== 'string'))) {
      errs.push({ path: 'params.allowedUrls', code: 'INVALID_PARAM', message: 'allowedUrls deve ser string[]' });
    }
    if (p.allowedTools !== undefined && (!Array.isArray(p.allowedTools) || p.allowedTools.some((x) => typeof x !== 'string'))) {
      errs.push({ path: 'params.allowedTools', code: 'INVALID_PARAM', message: 'allowedTools deve ser string[]' });
    }
    if (p.dryRun !== undefined && typeof p.dryRun !== 'boolean') {
      errs.push({ path: 'params.dryRun', code: 'INVALID_PARAM', message: 'dryRun deve ser boolean' });
    }
    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || Number.isNaN(p.timeoutMs) || p.timeoutMs <= 0)) {
      errs.push({ path: 'params.timeoutMs', code: 'INVALID_PARAM', message: 'timeoutMs deve ser número positivo' });
    }
    if (p.auditLogPath !== undefined && typeof p.auditLogPath !== 'string') {
      errs.push({ path: 'params.auditLogPath', code: 'INVALID_PARAM', message: 'auditLogPath deve ser string' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const serverName = ((ctx.params.serverName as string | undefined) ?? '').trim();
    const transport = (ctx.params.transport as 'stdio' | 'http' | undefined) ?? 'stdio';
    const command = (ctx.params.command as string | undefined) ?? '';
    const args = (ctx.params.args as string[] | undefined) ?? [];
    const envAllowlist = (ctx.params.envAllowlist as string[] | undefined) ?? [];
    const rawUrl = (ctx.params.url as string | undefined) ?? '';
    const allowedUrls = (ctx.params.allowedUrls as string[] | undefined) ?? [];
    const allowedToolsList = (ctx.params.allowedTools as string[] | undefined) ?? [];
    const allowedToolsSet = new Set(allowedToolsList.map((t) => t.trim()).filter(Boolean));
    const dryRun = (ctx.params.dryRun as boolean | undefined) ?? true;
    const rawTimeout = (ctx.params.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(50, rawTimeout), MAX_TIMEOUT_MS);
    const auditLogPath = (ctx.params.auditLogPath as string | undefined) ?? DEFAULT_AUDIT_LOG_PATH;
    const defaultRunId = typeof ctx.bindings?.runId === 'string' ? ctx.bindings.runId : 'unknown';

    let nextRpcId = 1;
    let initialized = false;
    let initPromise: Promise<void> | null = null;

    // Estado stdio
    let child: ChildProcess | null = null;
    let stdoutRemainder = '';
    const pendingStdio = new Map<number, PendingRpc>();

    // Estado http
    let sessionId: string | null = null;
    const activeHttpControllers = new Set<AbortController>();

    function rejectAllPending(reason: string): void {
      for (const [id, entry] of pendingStdio.entries()) {
        clearTimeout(entry.timer);
        entry.cleanupSignal?.();
        entry.reject(new Error(reason));
        pendingStdio.delete(id);
      }
      for (const ac of activeHttpControllers) {
        ac.abort(new Error(reason));
      }
      activeHttpControllers.clear();
    }

    async function shutdownTransport(reason: string): Promise<void> {
      rejectAllPending(reason);
      initialized = false;
      initPromise = null;
      sessionId = null;
      stdoutRemainder = '';
      if (child) {
        const proc = child;
        child = null;
        await killChildAndWait(proc);
      }
    }

    function spawnStdioChild(): ChildProcess {
      const check = validateMcpCommand(command);
      if (!check.ok) {
        throw new GraphError('MCP_COMMAND_DENIED', ctx.id, check.reason);
      }
      const filteredEnv = buildFilteredEnv(envAllowlist);
      const proc = spawn(check.command, args, {
        shell: false,
        env: filteredEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      stdoutRemainder = '';
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk: string) => {
        stdoutRemainder += chunk;
        let idx = stdoutRemainder.indexOf('\n');
        while (idx !== -1) {
          const line = stdoutRemainder.slice(0, idx).trim();
          stdoutRemainder = stdoutRemainder.slice(idx + 1);
          if (line) {
            handleStdioLine(line);
          }
          idx = stdoutRemainder.indexOf('\n');
        }
      });

      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk: string) => {
        const msg = chunk.trim();
        if (msg) ctx.log('debug', `tool.mcp[${serverName || ctx.id}] stderr: ${msg}`);
      });

      proc.once('error', (err) => {
        ctx.log('warn', `tool.mcp erro no processo filho: ${err.message}`);
        rejectAllPending(`MCP stdio erro: ${err.message}`);
        if (child === proc) {
          child = null;
          initialized = false;
          initPromise = null;
        }
      });

      proc.once('exit', (code, sig) => {
        rejectAllPending(`MCP stdio encerrado inesperadamente (code=${code ?? 'null'}, signal=${sig ?? 'null'})`);
        if (child === proc) {
          child = null;
          initialized = false;
          initPromise = null;
        }
      });

      child = proc;
      return proc;
    }

    function handleStdioLine(line: string): void {
      let msg: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
      try {
        msg = JSON.parse(line) as { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
      } catch {
        ctx.log('debug', `tool.mcp linha stdout não-JSON ignorada: ${line.slice(0, 120)}`);
        return;
      }
      if (typeof msg.id !== 'number') return;
      const entry = pendingStdio.get(msg.id);
      if (!entry) return;
      pendingStdio.delete(msg.id);
      clearTimeout(entry.timer);
      entry.cleanupSignal?.();
      if (msg.error) {
        entry.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      } else {
        entry.resolve(msg.result);
      }
    }

    function sendStdioNotification(method: string, params: Record<string, unknown>): void {
      if (!child || !child.stdin || child.stdin.destroyed) return;
      const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
      child.stdin.write(`${payload}\n`);
    }

    function sendStdioRequest(
      method: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> {
      if (!child || !child.stdin || child.stdin.destroyed) {
        return Promise.reject(new Error('Processo MCP stdio não está em execução'));
      }
      if (signal?.aborted || ctx.signal.aborted) {
        return Promise.reject(new Error('Requisição MCP cancelada (signal abortado)'));
      }

      const id = nextRpcId++;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

      return new Promise<unknown>((resolve, reject) => {
        const onAbort = () => {
          const entry = pendingStdio.get(id);
          if (!entry) return;
          pendingStdio.delete(id);
          clearTimeout(entry.timer);
          entry.cleanupSignal?.();
          reject(new Error(`MCP stdio abortado em ${method}`));
        };

        const cleanupSignal = () => {
          signal?.removeEventListener('abort', onAbort);
          ctx.signal.removeEventListener('abort', onAbort);
        };

        const timer = setTimeout(() => {
          const entry = pendingStdio.get(id);
          if (!entry) return;
          pendingStdio.delete(id);
          cleanupSignal();
          reject(new Error(`MCP timeout após ${timeoutMs} ms em ${method}`));
        }, timeoutMs);
        timer.unref?.();

        signal?.addEventListener('abort', onAbort, { once: true });
        ctx.signal.addEventListener('abort', onAbort, { once: true });

        pendingStdio.set(id, { resolve, reject, timer, cleanupSignal });

        try {
          child!.stdin!.write(`${payload}\n`, (err) => {
            if (err) {
              const entry = pendingStdio.get(id);
              if (entry) {
                pendingStdio.delete(id);
                clearTimeout(entry.timer);
                entry.cleanupSignal?.();
                reject(err);
              }
            }
          });
        } catch (err: unknown) {
          const entry = pendingStdio.get(id);
          if (entry) {
            pendingStdio.delete(id);
            clearTimeout(entry.timer);
            entry.cleanupSignal?.();
          }
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }

    async function sendHttpRpc(
      method: string,
      params: Record<string, unknown>,
      isNotification: boolean,
      signal?: AbortSignal,
    ): Promise<unknown> {
      const check = validateMcpUrl(rawUrl, allowedUrls);
      if (!check.ok) {
        throw new GraphError('MCP_URL_DENIED', ctx.id, check.reason);
      }
      if (signal?.aborted || ctx.signal.aborted) {
        throw new Error('Requisição MCP cancelada (signal abortado)');
      }

      const id = isNotification ? undefined : nextRpcId++;
      const body = isNotification
        ? JSON.stringify({ jsonrpc: '2.0', method, params })
        : JSON.stringify({ jsonrpc: '2.0', id, method, params });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (sessionId) {
        headers['Mcp-Session-Id'] = sessionId;
      }

      const ac = new AbortController();
      activeHttpControllers.add(ac);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort(new Error(`MCP timeout após ${timeoutMs} ms em ${method}`));
      }, timeoutMs);
      timer.unref?.();

      const onExternalAbort = () => ac.abort(new Error(`MCP http abortado em ${method}`));
      signal?.addEventListener('abort', onExternalAbort, { once: true });
      ctx.signal.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const res = await fetch(check.url.toString(), {
          method: 'POST',
          headers,
          body,
          signal: ac.signal,
          redirect: 'error',
        });

        const returnedSession = res.headers.get('mcp-session-id');
        if (returnedSession) {
          sessionId = returnedSession;
        }

        if (isNotification && (res.status === 202 || res.status === 204 || res.status === 200)) {
          // Consumir corpo para liberar conexão
          await res.text().catch(() => '');
          return undefined;
        }

        const text = await res.text();
        if (!res.ok) {
          throw new Error(`MCP HTTP ${res.status} em ${method}: ${text.slice(0, 300)}`);
        }
        if (isNotification || !text.trim()) {
          return undefined;
        }

        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        let parsed: { result?: unknown; error?: { code?: number; message?: string } } | null = null;
        if (contentType.includes('text/event-stream')) {
          parsed = parseSseJsonRpc(text, id!);
        } else {
          parsed = JSON.parse(text) as { result?: unknown; error?: { code?: number; message?: string } };
        }

        if (!parsed) {
          throw new Error(`Resposta MCP vazia ou inválida em ${method}`);
        }
        if (parsed.error) {
          throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
        }
        return parsed.result;
      } catch (err: unknown) {
        if (timedOut) {
          throw new Error(`MCP timeout após ${timeoutMs} ms em ${method}`);
        }
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
        ctx.signal.removeEventListener('abort', onExternalAbort);
        activeHttpControllers.delete(ac);
      }
    }

    async function rpcRequest(
      method: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<unknown> {
      if (transport === 'stdio') {
        return sendStdioRequest(method, params, signal);
      }
      return sendHttpRpc(method, params, false, signal);
    }

    async function rpcNotify(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
      if (transport === 'stdio') {
        sendStdioNotification(method, params);
        return;
      }
      await sendHttpRpc(method, params, true, signal);
    }

    async function ensureInitialized(signal?: AbortSignal): Promise<void> {
      if (initialized) return;
      if (initPromise) return initPromise;

      initPromise = (async () => {
        if (transport === 'stdio') {
          if (!child) {
            spawnStdioChild();
          }
        } else {
          const check = validateMcpUrl(rawUrl, allowedUrls);
          if (!check.ok) {
            throw new GraphError('MCP_URL_DENIED', ctx.id, check.reason);
          }
        }

        await rpcRequest(
          'initialize',
          {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
          signal,
        );
        await rpcNotify('notifications/initialized', {}, signal);
        initialized = true;
      })();

      try {
        await initPromise;
      } catch (err) {
        initPromise = null;
        throw err;
      }
    }

    function resolveRawToolName(exposedName: string): string {
      if (serverName && exposedName.startsWith(`${serverName}_`)) {
        return exposedName.slice(serverName.length + 1);
      }
      return exposedName;
    }

    function formatExposedToolName(rawName: string): string {
      return serverName ? `${serverName}_${rawName}` : rawName;
    }

    const onAbort = () => {
      void shutdownTransport('ctx.signal abortado');
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    const auditTransport: 'mcp-stdio' | 'mcp-http' = transport === 'stdio' ? 'mcp-stdio' : 'mcp-http';
    const auditTarget = transport === 'stdio' ? command : rawUrl;

    const toolProvider: ToolProvider = {
      async listTools(): Promise<ToolDef[]> {
        await ensureInitialized();
        const result = (await rpcRequest('tools/list', {})) as { tools?: McpRawTool[] } | undefined;
        const rawTools = Array.isArray(result?.tools) ? result.tools : [];
        const defs: ToolDef[] = [];

        for (const t of rawTools) {
          if (!t || typeof t.name !== 'string') continue;
          if (!allowedToolsSet.has(t.name)) continue;
          defs.push({
            name: formatExposedToolName(t.name),
            description: t.description ?? `MCP tool ${t.name}`,
            parameters:
              t.inputSchema && typeof t.inputSchema === 'object'
                ? t.inputSchema
                : { type: 'object', properties: {} },
            readonly: Boolean(t.annotations?.readOnlyHint),
            sourceNodeId: ctx.id,
          });
        }
        return defs;
      },

      async invoke(
        name: string,
        argsObj: Record<string, unknown>,
        opts: { signal: AbortSignal; runId: string; callerNodeId: string },
      ): Promise<ToolCallResult> {
        const t0 = Date.now();
        const rawName = resolveRawToolName(name);
        const runId = opts.runId || defaultRunId;

        // Valida transporte antes mesmo do dryRun para bloquear URL/comando não autorizado
        if (transport === 'http') {
          const check = validateMcpUrl(rawUrl, allowedUrls);
          if (!check.ok) {
            ctx.metrics.counter('tool.mcp.denied', 1);
            writeMcpAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                transport: auditTransport,
                serverName: serverName || undefined,
                target: auditTarget,
                tool: rawName,
                dryRun,
                decision: 'denied',
                reason: check.reason,
              },
              ctx,
            );
            return {
              ok: false,
              output: `MCP_URL_DENIED: ${check.reason}`,
              durationMs: Date.now() - t0,
              meta: { code: 'MCP_URL_DENIED', tool: rawName, transport },
            };
          }
        } else {
          const check = validateMcpCommand(command);
          if (!check.ok) {
            ctx.metrics.counter('tool.mcp.denied', 1);
            writeMcpAudit(
              auditLogPath,
              {
                ts: new Date().toISOString(),
                runId,
                nodeId: ctx.id,
                transport: auditTransport,
                serverName: serverName || undefined,
                target: auditTarget,
                tool: rawName,
                dryRun,
                decision: 'denied',
                reason: check.reason,
              },
              ctx,
            );
            return {
              ok: false,
              output: `MCP_COMMAND_DENIED: ${check.reason}`,
              durationMs: Date.now() - t0,
              meta: { code: 'MCP_COMMAND_DENIED', tool: rawName, transport },
            };
          }
        }

        if (!allowedToolsSet.has(rawName)) {
          const reason = `Tool "${rawName}" fora de allowedTools`;
          ctx.metrics.counter('tool.mcp.denied', 1);
          ctx.log('warn', `tool.mcp bloqueado: ${reason}`);
          writeMcpAudit(
            auditLogPath,
            {
              ts: new Date().toISOString(),
              runId,
              nodeId: ctx.id,
              transport: auditTransport,
              serverName: serverName || undefined,
              target: auditTarget,
              tool: rawName,
              dryRun,
              decision: 'denied',
              reason,
            },
            ctx,
          );
          return {
            ok: false,
            output: `MCP_TOOL_DENIED: ${reason}`,
            durationMs: Date.now() - t0,
            meta: { code: 'MCP_TOOL_DENIED', tool: rawName, serverName: serverName || undefined, transport },
          };
        }

        if (dryRun) {
          const durationMs = Date.now() - t0;
          ctx.metrics.counter('tool.mcp.dry_run', 1);
          writeMcpAudit(
            auditLogPath,
            {
              ts: new Date().toISOString(),
              runId,
              nodeId: ctx.id,
              transport: auditTransport,
              serverName: serverName || undefined,
              target: auditTarget,
              tool: rawName,
              dryRun: true,
              decision: 'dry_run',
              ok: true,
              durationMs,
            },
            ctx,
          );
          return {
            ok: true,
            output: `[DRY-RUN MCP ${serverName || transport}] tools/call ${rawName} args=${JSON.stringify(argsObj ?? {})}`,
            dryRun: true,
            durationMs,
            meta: { tool: rawName, serverName: serverName || undefined, transport, dryRun: true },
          };
        }

        try {
          await ensureInitialized(opts.signal);
          const result = await rpcRequest(
            'tools/call',
            {
              name: rawName,
              arguments: argsObj ?? {},
            },
            opts.signal,
          );
          const durationMs = Date.now() - t0;
          const { text, isError } = extractMcpContent(result);
          const ok = !isError;

          ctx.metrics.counter('tool.mcp.calls', 1);
          ctx.metrics.timer('tool.mcp.durationMs', durationMs);

          writeMcpAudit(
            auditLogPath,
            {
              ts: new Date().toISOString(),
              runId,
              nodeId: ctx.id,
              transport: auditTransport,
              serverName: serverName || undefined,
              target: auditTarget,
              tool: rawName,
              dryRun: false,
              decision: 'allowed',
              ok,
              durationMs,
            },
            ctx,
          );

          return {
            ok,
            output: text,
            dryRun: false,
            durationMs,
            meta: {
              tool: rawName,
              serverName: serverName || undefined,
              transport,
              isError,
              sessionId: sessionId ?? undefined,
            },
          };
        } catch (err: unknown) {
          const durationMs = Date.now() - t0;
          const msg = err instanceof Error ? err.message : String(err);
          ctx.metrics.counter('tool.mcp.errors', 1);
          ctx.log('warn', `tool.mcp falha em tools/call(${rawName}): ${msg}`);
          writeMcpAudit(
            auditLogPath,
            {
              ts: new Date().toISOString(),
              runId,
              nodeId: ctx.id,
              transport: auditTransport,
              serverName: serverName || undefined,
              target: auditTarget,
              tool: rawName,
              dryRun: false,
              decision: 'allowed',
              reason: msg,
              ok: false,
              durationMs,
            },
            ctx,
          );
          return {
            ok: false,
            output: `MCP_CALL_ERROR: ${msg}`,
            dryRun: false,
            durationMs,
            meta: { tool: rawName, serverName: serverName || undefined, transport, error: msg },
          };
        }
      },
    };

    return {
      toolProvider,

      async start() {
        await ensureInitialized();
      },

      async onInput() {},

      onControl(c: ControlMsg) {
        if (c.kind === 'interrupt') {
          ctx.log('info', `tool.mcp interrompido por controle (${c.reason ?? 'interrupt'})`);
          void shutdownTransport(`interrupt: ${c.reason ?? 'control'}`);
        }
      },

      async stop(reason: string) {
        ctx.signal.removeEventListener('abort', onAbort);
        await shutdownTransport(`stop: ${reason}`);
      },
    };
  },
};
