// falador-nodes — exec.command: conector de execução local/SSH com 4 camadas de segurança (ADR-007 Fase B, ZERO deps)
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import {
  GraphError,
  type ControlMsg,
  type Envelope,
  type NodeCtx,
  type NodeRuntime,
  type NodeTypeDef,
  type ParamError,
} from '../../falador-graph/src/index.ts';
import { payloadText } from './sse.ts';

export const DEFAULT_READONLY_PREFIXES: readonly string[] = [
  'uname',
  'uptime',
  'df',
  'free',
  'ps',
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'systemctl status',
  'journalctl',
  'docker ps',
  'docker logs',
  'kubectl get',
  'kubectl describe',
  'kubectl logs',
  'ss',
  'netstat',
  'curl -I',
  'dig',
  'nslookup',
];

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

const FORBIDDEN_METACHARS: readonly string[] = [
  '\n',
  '\r',
  '&&',
  '||',
  '>>',
  '$(',
  ';',
  '&',
  '`',
  '>',
  '<',
  '|',
];

const HOST_REGEX = /^[a-zA-Z0-9._-]+$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32_768;
const DEFAULT_AUDIT_LOG_PATH = 'logs/exec-audit.jsonl';

export interface ExecPolicy {
  transport: 'local' | 'ssh';
  mode: 'readonly' | 'allowlist';
  allowedPrefixes: string[];
  allowedHosts: string[];
  defaultHost?: string;
  sshUser?: string;
}

export type ExtractResult =
  | { ok: true; command: string; host?: string; reason?: string }
  | { ok: false; code: 'EXEC_POLICY_DENIED'; reason: string };

export type ValidateResult =
  | { ok: true; command: string; argv: string[]; host: string; reason?: string }
  | { ok: false; code: 'EXEC_POLICY_DENIED'; reason: string; command?: string; host?: string };

export interface AuditEntry {
  ts: string;
  runId: string;
  nodeId: string;
  transport: 'local' | 'ssh';
  host: string;
  command: string;
  dryRun: boolean;
  decision: 'allowed' | 'dry_run' | 'denied';
  reason?: string;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
}

/**
 * Faz parse seguro de linha de comando em argv respeitando aspas simples e duplas.
 * Lança erro se houver aspas não fechadas.
 */
export function parseArgv(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < command.length) {
        const next = command[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      current += command[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) {
        argv.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }

  if (inSingle || inDouble) {
    throw new Error('Aspas não fechadas no comando');
  }
  if (hasToken) {
    argv.push(current);
  }
  return argv;
}

function tryParseJsonCommand(raw: string): { command: string; host?: string; reason?: string } | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).command === 'string') {
      const obj = parsed as { command: string; host?: unknown; reason?: unknown };
      return {
        command: obj.command,
        host: typeof obj.host === 'string' ? obj.host : undefined,
        reason: typeof obj.reason === 'string' ? obj.reason : undefined,
      };
    }
  } catch {
    /* não é JSON */
  }
  return null;
}

/**
 * Extrai um único comando de:
 * - objeto `{ command, host?, reason? }`
 * - string JSON `{ "command": ... }` (direta ou em bloco ```json)
 * - bloco markdown ```sh / ```bash / ```
 * - texto plano de 1 linha
 * Rejeita comandos vazios ou com múltiplas linhas.
 */
export function extractCommand(input: unknown): ExtractResult {
  let command = '';
  let host: string | undefined;
  let reason: string | undefined;

  if (input && typeof input === 'object' && typeof (input as Record<string, unknown>).command === 'string') {
    const obj = input as { command: string; host?: unknown; reason?: unknown };
    command = obj.command;
    host = typeof obj.host === 'string' ? obj.host : undefined;
    reason = typeof obj.reason === 'string' ? obj.reason : undefined;
  } else {
    const pl = payloadText(input);
    const raw = pl ? pl.text : typeof input === 'string' ? input : '';
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, code: 'EXEC_POLICY_DENIED', reason: 'Comando vazio' };
    }

    const directJson = tryParseJsonCommand(trimmed);
    if (directJson) {
      command = directJson.command;
      host = directJson.host;
      reason = directJson.reason;
    } else {
      // Verifica bloco ```json ... ```
      const jsonFence = /```json\s*\n([\s\S]*?)```/i.exec(trimmed);
      const fencedJson = jsonFence ? tryParseJsonCommand(jsonFence[1].trim()) : null;
      if (fencedJson) {
        command = fencedJson.command;
        host = fencedJson.host;
        reason = fencedJson.reason;
      } else {
        // Verifica bloco ```sh / ```bash / ```
        const shFence = /```(?:sh|bash|shell)?\s*\n([\s\S]*?)```/i.exec(trimmed);
        if (shFence) {
          command = shFence[1].trim();
        } else {
          command = trimmed;
        }
      }
    }
  }

  const clean = command.trim();
  if (!clean) {
    return { ok: false, code: 'EXEC_POLICY_DENIED', reason: 'Comando vazio após extração' };
  }
  if (clean.includes('\n') || clean.includes('\r')) {
    return { ok: false, code: 'EXEC_POLICY_DENIED', reason: 'Múltiplas linhas de comando não são permitidas' };
  }

  return { ok: true, command: clean, host, reason };
}

/** Escapa um argumento em POSIX single-quotes (`'` → `'\''`) para envio seguro ao shell remoto via SSH. */
export function quotePosix(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Monta comando remoto POSIX seguro escapando cada token de `argv` individualmente. */
export function buildSshRemoteCommand(argv: string[]): string {
  return argv.map(quotePosix).join(' ');
}

/**
 * Validador determinístico (Camada 3 ADR-007):
 * 1. Extração de comando único
 * 2. Denylist dura de metacaracteres de shell
 * 3. Parse de argv + denylist dura de binários destrutivos
 * 4. Allowlist de prefixo com fronteira de palavra
 * 5. Allowlist e sanitização de host (para SSH)
 */
export function validateCommand(input: unknown, policy: ExecPolicy): ValidateResult {
  const extracted = extractCommand(input);
  if (!extracted.ok) {
    return { ok: false, code: 'EXEC_POLICY_DENIED', reason: extracted.reason };
  }

  const { command, reason } = extracted;

  // 2. Denylist dura de metacaracteres
  for (const meta of FORBIDDEN_METACHARS) {
    if (command.includes(meta)) {
      return {
        ok: false,
        code: 'EXEC_POLICY_DENIED',
        reason: `Metacaractere de shell proibido detectado: ${JSON.stringify(meta)}`,
        command,
      };
    }
  }

  // 3. Parse de argv
  let argv: string[];
  try {
    argv = parseArgv(command);
  } catch (err: unknown) {
    return {
      ok: false,
      code: 'EXEC_POLICY_DENIED',
      reason: err instanceof Error ? err.message : 'Falha ao analisar argumentos do comando',
      command,
    };
  }
  if (argv.length === 0) {
    return { ok: false, code: 'EXEC_POLICY_DENIED', reason: 'Comando sem executável', command };
  }

  // Denylist dura de binários destrutivos (mesmo que estejam em allowedPrefixes)
  const bin = basename(argv[0]).toLowerCase();
  if (HARD_DENY_BINARIES.has(bin) || bin.startsWith('mkfs.')) {
    return {
      ok: false,
      code: 'EXEC_POLICY_DENIED',
      reason: `Binário destrutivo bloqueado pela denylist imutável: ${bin}`,
      command,
    };
  }

  // 4. Allowlist de prefixo com fronteira de palavra
  const normalized = command.replace(/\s+/g, ' ').trim();
  const prefixes = Array.isArray(policy.allowedPrefixes) ? policy.allowedPrefixes : [];
  const prefixMatched = prefixes.some((rawPrefix) => {
    if (typeof rawPrefix !== 'string') return false;
    const p = rawPrefix.trim().replace(/\s+/g, ' ');
    if (!p) return false;
    return normalized === p || normalized.startsWith(`${p} `);
  });
  if (!prefixMatched) {
    return {
      ok: false,
      code: 'EXEC_POLICY_DENIED',
      reason: `Comando fora da allowlist de prefixos permitidos: ${argv[0]}`,
      command,
    };
  }

  // 5. Allowlist de host e validação de sshUser (SSH)
  let host = 'local';
  if (policy.transport === 'ssh') {
    if (policy.sshUser !== undefined && policy.sshUser !== '') {
      if (policy.sshUser.startsWith('-')) {
        return {
          ok: false,
          code: 'EXEC_POLICY_DENIED',
          reason: `sshUser inválido (inicia com hífen): ${policy.sshUser}`,
          command,
        };
      }
      if (!HOST_REGEX.test(policy.sshUser)) {
        return {
          ok: false,
          code: 'EXEC_POLICY_DENIED',
          reason: `sshUser contém caracteres proibidos: ${policy.sshUser}`,
          command,
        };
      }
    }
    const targetHost = (extracted.host ?? policy.defaultHost ?? '').trim();
    if (!targetHost) {
      return {
        ok: false,
        code: 'EXEC_POLICY_DENIED',
        reason: 'Host SSH não informado (nem no payload nem em defaultHost)',
        command,
      };
    }
    if (targetHost.startsWith('-')) {
      return {
        ok: false,
        code: 'EXEC_POLICY_DENIED',
        reason: `Host SSH inválido (inicia com hífen): ${targetHost}`,
        command,
        host: targetHost,
      };
    }
    if (!HOST_REGEX.test(targetHost)) {
      return {
        ok: false,
        code: 'EXEC_POLICY_DENIED',
        reason: `Host SSH contém caracteres proibidos: ${targetHost}`,
        command,
        host: targetHost,
      };
    }
    const allowedHosts = Array.isArray(policy.allowedHosts) ? policy.allowedHosts : [];
    if (allowedHosts.length === 0) {
      return {
        ok: false,
        code: 'EXEC_POLICY_DENIED',
        reason: 'allowedHosts vazio: execução SSH recusada por segurança',
        command,
        host: targetHost,
      };
    }
    if (!allowedHosts.includes(targetHost)) {
      return {
        ok: false,
        code: 'EXEC_POLICY_DENIED',
        reason: `Host SSH fora de allowedHosts: ${targetHost}`,
        command,
        host: targetHost,
      };
    }
    host = targetHost;
  }

  return { ok: true, command, argv, host, reason };
}

/** Acumulador de saída que preserva os últimos `maxBytes` bytes (tail) sem crescer sem limite. */
class TailBuffer {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxBytes: number;
  truncated = false;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(1, maxBytes);
  }

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (chunk.length >= this.maxBytes) {
      this.buf = Buffer.from(chunk.subarray(chunk.length - this.maxBytes));
      this.truncated = true;
      return;
    }
    const total = this.buf.length + chunk.length;
    if (total <= this.maxBytes) {
      this.buf = Buffer.concat([this.buf, chunk], total);
    } else {
      const keepFromOld = this.maxBytes - chunk.length;
      const oldSlice = this.buf.subarray(this.buf.length - keepFromOld);
      this.buf = Buffer.concat([oldSlice, chunk], this.maxBytes);
      this.truncated = true;
    }
  }

  toString(): string {
    const text = this.buf.toString('utf8');
    return this.truncated ? `[truncado]\n${text}` : text;
  }
}

function writeAuditEntry(auditLogPath: string, entry: AuditEntry, ctx: NodeCtx): void {
  try {
    mkdirSync(dirname(auditLogPath), { recursive: true });
    appendFileSync(auditLogPath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err: unknown) {
    ctx.log('warn', `exec.command falha ao gravar audit log em ${auditLogPath}: ${(err as Error)?.message ?? String(err)}`);
  }
}

function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    /* processo já encerrado */
  }
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* processo já encerrado */
      }
    }
  }, 1000);
  killTimer.unref?.();
  child.once('exit', () => clearTimeout(killTimer));
  child.once('close', () => clearTimeout(killTimer));
}

function formatReport(opts: {
  command: string;
  host: string;
  transport: 'local' | 'ssh';
  dryRun: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  reason?: string;
}): string {
  const lines: string[] = [];
  if (opts.dryRun) {
    lines.push(`[DRY-RUN] Comando validado (${opts.transport} @ ${opts.host}): ${opts.command}`);
    if (opts.reason) lines.push(`Motivo: ${opts.reason}`);
    lines.push('Nenhuma execução real foi disparada (dryRun=true).');
    return lines.join('\n');
  }

  const status = opts.timedOut ? 'TIMEOUT' : `exit=${opts.exitCode ?? 'null'}`;
  lines.push(`[EXEC ${opts.transport} @ ${opts.host}] ${opts.command} (${status}, ${opts.durationMs} ms)`);
  if (opts.stdout.trim()) {
    lines.push('--- stdout ---');
    lines.push(opts.stdout.trimEnd());
  }
  if (opts.stderr.trim()) {
    lines.push('--- stderr ---');
    lines.push(opts.stderr.trimEnd());
  }
  return lines.join('\n');
}

export const execCommand: NodeTypeDef = {
  type: 'exec.command',
  paramNames: [
    'transport',
    'mode',
    'dryRun',
    'allowedPrefixes',
    'allowedHosts',
    'defaultHost',
    'sshUser',
    'sshPort',
    'cwd',
    'timeoutMs',
    'maxOutputBytes',
    'auditLogPath',
  ],
  inputs: [
    { name: 'in', type: 'phrase' },
    { name: 'parcs', type: 'tokens_parcial' },
  ],
  outputs: [{ name: 'out', type: 'phrase', required: true }],
  validateParams: (p): ParamError[] => {
    const errs: ParamError[] = [];
    if (p.transport !== undefined && p.transport !== 'local' && p.transport !== 'ssh') {
      errs.push({ path: 'params.transport', code: 'INVALID_PARAM', message: "transport deve ser 'local' ou 'ssh'" });
    }
    if (p.mode !== undefined && p.mode !== 'readonly' && p.mode !== 'allowlist') {
      errs.push({ path: 'params.mode', code: 'INVALID_PARAM', message: "mode deve ser 'readonly' ou 'allowlist'" });
    }
    if (p.dryRun !== undefined && typeof p.dryRun !== 'boolean') {
      errs.push({ path: 'params.dryRun', code: 'INVALID_PARAM', message: 'dryRun deve ser boolean' });
    }
    if (p.allowedPrefixes !== undefined) {
      if (!Array.isArray(p.allowedPrefixes) || p.allowedPrefixes.some((x) => typeof x !== 'string')) {
        errs.push({ path: 'params.allowedPrefixes', code: 'INVALID_PARAM', message: 'allowedPrefixes deve ser string[]' });
      }
    }
    if (p.allowedHosts !== undefined) {
      if (!Array.isArray(p.allowedHosts) || p.allowedHosts.some((x) => typeof x !== 'string')) {
        errs.push({ path: 'params.allowedHosts', code: 'INVALID_PARAM', message: 'allowedHosts deve ser string[]' });
      }
    }
    if (p.sshPort !== undefined) {
      if (typeof p.sshPort !== 'number' || !Number.isInteger(p.sshPort) || p.sshPort < 1 || p.sshPort > 65535) {
        errs.push({ path: 'params.sshPort', code: 'INVALID_PARAM', message: 'sshPort deve ser inteiro entre 1 e 65535' });
      }
    }
    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || p.timeoutMs <= 0)) {
      errs.push({ path: 'params.timeoutMs', code: 'INVALID_PARAM', message: 'timeoutMs deve ser número positivo' });
    }
    if (p.maxOutputBytes !== undefined && (typeof p.maxOutputBytes !== 'number' || p.maxOutputBytes <= 0)) {
      errs.push({ path: 'params.maxOutputBytes', code: 'INVALID_PARAM', message: 'maxOutputBytes deve ser número positivo' });
    }
    return errs;
  },
  create: (ctx: NodeCtx): NodeRuntime => {
    const transport = (ctx.params.transport as 'local' | 'ssh' | undefined) ?? 'local';
    const mode = (ctx.params.mode as 'readonly' | 'allowlist' | undefined) ?? 'readonly';
    const dryRun = (ctx.params.dryRun as boolean | undefined) ?? true;
    const allowedPrefixes =
      (ctx.params.allowedPrefixes as string[] | undefined) ??
      (mode === 'readonly' ? [...DEFAULT_READONLY_PREFIXES] : []);
    const allowedHosts = (ctx.params.allowedHosts as string[] | undefined) ?? [];
    const defaultHost = ctx.params.defaultHost as string | undefined;
    const sshUser = ctx.params.sshUser as string | undefined;
    const sshPort = (ctx.params.sshPort as number | undefined) ?? 22;
    const cwd = ctx.params.cwd as string | undefined;
    const rawTimeout = (ctx.params.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(50, rawTimeout), MAX_TIMEOUT_MS);
    const maxOutputBytes = Math.max(64, (ctx.params.maxOutputBytes as number | undefined) ?? DEFAULT_MAX_OUTPUT_BYTES);
    const auditLogPath = (ctx.params.auditLogPath as string | undefined) ?? DEFAULT_AUDIT_LOG_PATH;

    const policy: ExecPolicy = {
      transport,
      mode,
      allowedPrefixes,
      allowedHosts,
      defaultHost,
      sshUser,
    };

    const runId = typeof ctx.bindings?.runId === 'string' ? ctx.bindings.runId : 'unknown';

    let activeChild: ChildProcess | null = null;
    let activeInterrupted = false;

    const onAbort = () => {
      if (activeChild) {
        activeInterrupted = true;
        killProcessTree(activeChild);
      }
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    return {
      async start() {},

      onControl(c: ControlMsg) {
        if (c.kind === 'interrupt') {
          activeInterrupted = true;
          if (activeChild) {
            ctx.metrics.counter('exec.command.killed', 1);
            ctx.log('info', `exec.command interrompido por controle (${c.reason ?? 'interrupt'})`);
            killProcessTree(activeChild);
          }
        }
      },

      async onInput(port: string, msg: Envelope) {
        if (msg.control) return;

        // Na porta parcs (tokens_parcial), age apenas em final: true
        if (port === 'parcs') {
          const pl = payloadText(msg.payload);
          if (!pl || !pl.final) return;
        }

        const validation = validateCommand(msg.payload, policy);
        if (!validation.ok) {
          ctx.metrics.counter('exec.command.denied', 1);
          ctx.log('warn', `exec.command bloqueado (${validation.code}): ${validation.reason}`);
          writeAuditEntry(
            auditLogPath,
            {
              ts: new Date().toISOString(),
              runId,
              nodeId: ctx.id,
              transport,
              host: validation.host ?? (transport === 'ssh' ? (defaultHost ?? 'unknown') : 'local'),
              command: validation.command ?? String(payloadText(msg.payload)?.text ?? ''),
              dryRun,
              decision: 'denied',
              reason: validation.reason,
            },
            ctx,
          );
          throw new GraphError('EXEC_POLICY_DENIED', ctx.id, validation.reason);
        }

        const { command, argv, host, reason } = validation;
        const prevTrace =
          msg.meta && typeof msg.meta.trace === 'object' && msg.meta.trace !== null
            ? (msg.meta.trace as Record<string, unknown>)
            : {};

        const tExecStartMs = Date.now();

        if (dryRun) {
          const tExecEndMs = Date.now();
          const durationMs = tExecEndMs - tExecStartMs;
          ctx.metrics.counter('exec.command.dry_run', 1);
          writeAuditEntry(
            auditLogPath,
            {
              ts: new Date().toISOString(),
              runId,
              nodeId: ctx.id,
              transport,
              host,
              command,
              dryRun: true,
              decision: 'dry_run',
              reason,
              exitCode: 0,
              durationMs,
              timedOut: false,
            },
            ctx,
          );
          const report = formatReport({
            command,
            host,
            transport,
            dryRun: true,
            exitCode: 0,
            durationMs,
            timedOut: false,
            stdout: '',
            stderr: '',
            reason,
          });
          await ctx.emit('out', report, {
            meta: {
              ...msg.meta,
              exec: {
                command,
                host,
                exitCode: 0,
                durationMs,
                dryRun: true,
                truncated: false,
                timedOut: false,
              },
              trace: {
                ...prevTrace,
                tExecStartMs,
                tExecEndMs,
                exitCode: 0,
              },
            },
          });
          return;
        }

        // Execução real controlada (shell: false sempre)
        activeInterrupted = false;
        const stdoutBuf = new TailBuffer(maxOutputBytes);
        const stderrBuf = new TailBuffer(maxOutputBytes);
        let timedOut = false;

        const execResult = await new Promise<{ exitCode: number | null; errorMsg?: string }>((resolve) => {
          let settled = false;
          const finish = (res: { exitCode: number | null; errorMsg?: string }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            activeChild = null;
            resolve(res);
          };

          let child: ChildProcess;
          try {
            if (transport === 'local') {
              child = spawn(argv[0], argv.slice(1), {
                shell: false,
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            } else {
              const target = sshUser ? `${sshUser}@${host}` : host;
              const remoteCommand = buildSshRemoteCommand(argv);
              child = spawn(
                'ssh',
                [
                  '-o', 'BatchMode=yes',
                  '-o', 'ConnectTimeout=5',
                  '-o', 'StrictHostKeyChecking=yes',
                  '-o', 'IdentitiesOnly=yes',
                  '-p', String(sshPort),
                  '--',
                  target,
                  remoteCommand,
                ],
                {
                  shell: false,
                  stdio: ['ignore', 'pipe', 'pipe'],
                },
              );
            }
          } catch (err: unknown) {
            finish({ exitCode: null, errorMsg: (err as Error)?.message ?? String(err) });
            return;
          }

          activeChild = child;

          const timer = setTimeout(() => {
            timedOut = true;
            ctx.metrics.counter('exec.command.killed', 1);
            ctx.log('warn', `exec.command timeout após ${timeoutMs} ms: ${command}`);
            killProcessTree(child);
          }, timeoutMs);

          child.stdout?.on('data', (chunk: Buffer) => stdoutBuf.append(chunk));
          child.stderr?.on('data', (chunk: Buffer) => stderrBuf.append(chunk));

          child.once('error', (err) => {
            finish({ exitCode: null, errorMsg: err.message });
          });

          child.once('close', (code) => {
            finish({ exitCode: code });
          });
        });

        const tExecEndMs = Date.now();
        const durationMs = tExecEndMs - tExecStartMs;
        const truncated = stdoutBuf.truncated || stderrBuf.truncated;
        const stderrText = execResult.errorMsg
          ? `${stderrBuf.toString()}\n${execResult.errorMsg}`.trim()
          : stderrBuf.toString();

        ctx.metrics.counter('exec.command.executed', 1);
        ctx.metrics.timer('exec.command.durationMs', durationMs);

        writeAuditEntry(
          auditLogPath,
          {
            ts: new Date().toISOString(),
            runId,
            nodeId: ctx.id,
            transport,
            host,
            command,
            dryRun: false,
            decision: 'allowed',
            reason: activeInterrupted ? 'interrupted' : reason,
            exitCode: execResult.exitCode,
            durationMs,
            timedOut,
          },
          ctx,
        );

        if (activeInterrupted) {
          return;
        }

        const report = formatReport({
          command,
          host,
          transport,
          dryRun: false,
          exitCode: execResult.exitCode,
          durationMs,
          timedOut,
          stdout: stdoutBuf.toString(),
          stderr: stderrText,
          reason,
        });

        await ctx.emit('out', report, {
          meta: {
            ...msg.meta,
            exec: {
              command,
              host,
              exitCode: execResult.exitCode,
              durationMs,
              dryRun: false,
              truncated,
              timedOut,
            },
            trace: {
              ...prevTrace,
              tExecStartMs,
              tExecEndMs,
              exitCode: execResult.exitCode,
            },
          },
        });
      },

      async stop() {
        ctx.signal.removeEventListener('abort', onAbort);
        if (activeChild) {
          activeInterrupted = true;
          killProcessTree(activeChild);
        }
      },
    };
  },
};
