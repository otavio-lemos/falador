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
  type ToolCallResult,
  type ToolDef,
  type ToolProvider,
} from '../../falador-graph/src/index.ts';
import { payloadText } from './sse.ts';
import { createLineRedactor, redactSecrets } from './redact.ts';

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

export const INTERACTIVE_DENY_BINARIES = new Set([
  'vim',
  'vi',
  'nvim',
  'nano',
  'emacs',
  'pico',
  'ed',
  'top',
  'htop',
  'btop',
  'atop',
  'iotop',
  'iftop',
  'less',
  'more',
  'most',
  'man',
  'watch',
  'tmux',
  'screen',
  'ssh',
  'sftp',
  'ftp',
  'telnet',
  'psql',
  'mysql',
  'sqlite3',
  'redis-cli',
  'mongosh',
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
const JUMP_HOST_REGEX = /^([a-zA-Z0-9._-]+@)?[a-zA-Z0-9._-]+(:[0-9]{1,5})?$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32_768;
const DEFAULT_AUDIT_LOG_PATH = 'logs/exec-audit.jsonl';
const STREAM_THROTTLE_MS = 80;
const STREAM_THROTTLE_BYTES = 4096;

export interface HostPolicy {
  env?: 'dev' | 'staging' | 'prod';
  dryRun?: boolean;
  mode?: 'readonly' | 'allowlist';
  jumpHosts?: string[];
  requireTypedConfirm?: boolean;
}

export type ExecChunkEvent =
  | {
      type: 'exec_start';
      id: string;
      nodeId: string;
      host: string;
      bastion?: string;
      command: string;
      dryRun: boolean;
      transport: 'local' | 'ssh';
      ts: number;
    }
  | {
      type: 'exec_chunk';
      id: string;
      stream: 'stdout' | 'stderr';
      text: string;
      ts: number;
    }
  | {
      type: 'exec_end';
      id: string;
      exitCode: number | null;
      durationMs: number;
      ok: boolean;
      truncated: boolean;
      ts: number;
    };

export interface SshArgvOptions {
  host: string;
  sshUser?: string;
  sshPort?: number;
  remoteCommand: string;
  jumpHosts?: string[];
  allowedJumpHosts?: string[];
  sshConfigPath?: string;
  identityFile?: string;
  useSshAgent?: boolean;
  strictHostKeyChecking?: 'yes' | 'accept-new';
  connectTimeoutSec?: number;
}

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
  bastion?: string;
  command: string;
  dryRun: boolean;
  decision: 'allowed' | 'dry_run' | 'denied';
  reason?: string;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
  sshTransportError?: boolean;
}

export function validateJumpHost(hop: string): { ok: true } | { ok: false; reason: string } {
  if (typeof hop !== 'string' || !hop.trim() || hop !== hop.trim()) {
    return { ok: false, reason: `jumpHost inválido: ${String(hop)}` };
  }
  if (hop.startsWith('-')) {
    return { ok: false, reason: `jumpHost inválido (inicia com hífen): ${hop}` };
  }
  if (/proxycommand/i.test(hop)) {
    return { ok: false, reason: `ProxyCommand é proibido em jumpHost: ${hop}` };
  }
  if (!JUMP_HOST_REGEX.test(hop)) {
    return { ok: false, reason: `jumpHost fora do padrão [user@]host[:port]: ${hop}` };
  }
  const colonIdx = hop.lastIndexOf(':');
  if (colonIdx !== -1) {
    const port = Number(hop.slice(colonIdx + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, reason: `Porta inválida em jumpHost: ${hop}` };
    }
  }
  return { ok: true };
}

export function validateSshPath(p: string): { ok: true } | { ok: false; reason: string } {
  if (typeof p !== 'string' || !p.trim()) {
    return { ok: false, reason: 'Caminho SSH vazio' };
  }
  if (/[\0\r\n]/.test(p)) {
    return { ok: false, reason: 'Caminho SSH contém caracteres de controle' };
  }
  if (p.startsWith('-')) {
    return { ok: false, reason: `Caminho SSH inválido (inicia com hífen): ${p}` };
  }
  if (p.includes('..')) {
    return { ok: false, reason: `Caminho SSH não pode conter '..': ${p}` };
  }
  return { ok: true };
}

export function resolveHostPolicy(
  host: string,
  base: { dryRun: boolean; mode: 'readonly' | 'allowlist'; jumpHosts?: string[] },
  hostPolicies?: Record<string, HostPolicy>,
): {
  env?: 'dev' | 'staging' | 'prod';
  dryRun: boolean;
  mode: 'readonly' | 'allowlist';
  jumpHosts?: string[];
  requireTypedConfirm: boolean;
} {
  if (!hostPolicies) {
    return {
      dryRun: base.dryRun,
      mode: base.mode,
      jumpHosts: base.jumpHosts,
      requireTypedConfirm: false,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(hostPolicies, host)) {
    // Fail-closed: host não listado mantém dryRun=true e requireTypedConfirm=true
    return {
      dryRun: true,
      mode: 'readonly',
      jumpHosts: base.jumpHosts,
      requireTypedConfirm: true,
    };
  }
  const hp = hostPolicies[host] ?? {};
  if (hp.env === 'prod') {
    // Fail-closed: ambiente prod sempre força dryRun=true e requireTypedConfirm=true
    return {
      env: 'prod',
      dryRun: true,
      mode: hp.mode ?? base.mode,
      jumpHosts: hp.jumpHosts ?? base.jumpHosts,
      requireTypedConfirm: true,
    };
  }
  return {
    env: hp.env,
    dryRun: hp.dryRun ?? base.dryRun,
    mode: hp.mode ?? base.mode,
    jumpHosts: hp.jumpHosts ?? base.jumpHosts,
    requireTypedConfirm: hp.requireTypedConfirm ?? false,
  };
}

export function buildSshArgv(opts: SshArgvOptions): string[] {
  const strict = opts.strictHostKeyChecking ?? 'yes';
  if (strict !== 'yes' && strict !== 'accept-new') {
    throw new Error(`strictHostKeyChecking inválido: ${String(strict)} (aceito: 'yes' | 'accept-new')`);
  }
  const timeout = opts.connectTimeoutSec ?? 5;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 1 || timeout > 30) {
    throw new Error(`connectTimeoutSec inválido: ${String(timeout)} (aceito: 1..30)`);
  }
  if (opts.sshConfigPath !== undefined) {
    const chk = validateSshPath(opts.sshConfigPath);
    if (!chk.ok) throw new Error(chk.reason);
  }
  if (opts.identityFile !== undefined) {
    const chk = validateSshPath(opts.identityFile);
    if (!chk.ok) throw new Error(chk.reason);
  }
  const jumpHosts = opts.jumpHosts ?? [];
  const allowedJumpHosts = opts.allowedJumpHosts ?? [];
  for (const hop of jumpHosts) {
    const chk = validateJumpHost(hop);
    if (!chk.ok) throw new Error(chk.reason);
    if (allowedJumpHosts.length > 0 && !allowedJumpHosts.includes(hop)) {
      throw new Error(`jumpHost fora de allowedJumpHosts: ${hop}`);
    }
  }

  const args: string[] = [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'RequestTTY=no',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', `StrictHostKeyChecking=${strict}`,
    '-o', `ConnectTimeout=${Math.round(timeout)}`,
  ];

  if (opts.identityFile) {
    args.push('-o', 'IdentitiesOnly=yes', '-i', opts.identityFile);
  } else if (opts.useSshAgent === false) {
    args.push('-o', 'IdentitiesOnly=yes');
  }

  if (opts.sshConfigPath) {
    args.push('-F', opts.sshConfigPath);
  }

  if (jumpHosts.length > 0) {
    args.push('-J', jumpHosts.join(','));
  }

  const target = opts.sshUser ? `${opts.sshUser}@${opts.host}` : opts.host;
  const port = opts.sshPort ?? 22;
  args.push('-p', String(port), '--', target, opts.remoteCommand);
  return args;
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

  // Denylist determinística de binários interativos (sem TTY)
  if (INTERACTIVE_DENY_BINARIES.has(bin)) {
    return {
      ok: false,
      code: 'EXEC_POLICY_DENIED',
      reason: `Binário interativo bloqueado (sem TTY): ${bin}`,
      command,
    };
  }

  // Flags interativas/infinitas em argv (para antes de '--')
  if ((bin === 'docker' || bin === 'kubectl') && argv[1]?.toLowerCase() === 'exec') {
    for (const arg of argv.slice(2)) {
      if (arg === '--') break;
      if (
        arg === '-i' ||
        arg === '-t' ||
        arg === '-it' ||
        arg === '-ti' ||
        arg === '--interactive' ||
        arg === '--tty' ||
        arg.startsWith('--interactive=') ||
        arg.startsWith('--tty=') ||
        /^-[a-zA-Z]*[it][a-zA-Z]*$/.test(arg)
      ) {
        return {
          ok: false,
          code: 'EXEC_POLICY_DENIED',
          reason: `Flag interativa bloqueada em ${bin} exec: ${arg}`,
          command,
        };
      }
    }
  }

  if (bin === 'tail' || bin === 'journalctl') {
    for (const arg of argv.slice(1)) {
      if (arg === '--') break;
      if (
        arg === '-f' ||
        arg === '-F' ||
        arg === '--follow' ||
        arg.startsWith('--follow=') ||
        /^-[a-zA-Z]*[fF][a-zA-Z]*$/.test(arg)
      ) {
        return {
          ok: false,
          code: 'EXEC_POLICY_DENIED',
          reason: `Flag de streaming infinito bloqueada em ${bin}: ${arg}`,
          command,
        };
      }
    }
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
    const safeEntry: AuditEntry = {
      ...entry,
      command: redactSecrets(entry.command).text,
      ...(typeof entry.reason === 'string' ? { reason: redactSecrets(entry.reason).text } : {}),
    };
    appendFileSync(auditLogPath, `${JSON.stringify(safeEntry)}\n`, 'utf8');
  } catch (err: unknown) {
    ctx.log('warn', `exec.command falha ao gravar audit log em ${auditLogPath}: ${(err as Error)?.message ?? String(err)}`);
  }
}

export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const sendSig = (sig: NodeJS.Signals) => {
    if (typeof pid === 'number' && pid > 0) {
      try {
        process.kill(-pid, sig);
        return;
      } catch {
        /* fallback para processo individual se não for líder de process group */
      }
    }
    try {
      child.kill(sig);
    } catch {
      /* processo já encerrado */
    }
  };
  sendSig('SIGTERM');
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      sendSig('SIGKILL');
    }
  }, 1000);
  killTimer.unref?.();
  child.once('exit', () => clearTimeout(killTimer));
  child.once('close', () => clearTimeout(killTimer));
}

function formatReport(opts: {
  command: string;
  host: string;
  bastion?: string;
  transport: 'local' | 'ssh';
  dryRun: boolean;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  sshTransportError?: boolean;
  stdout: string;
  stderr: string;
  reason?: string;
}): string {
  const safeCommand = redactSecrets(opts.command).text;
  const safeStdout = redactSecrets(opts.stdout).text;
  const safeStderr = redactSecrets(opts.stderr).text;
  const safeReason = opts.reason !== undefined ? redactSecrets(opts.reason).text : undefined;
  const hostLabel = opts.bastion ? `${opts.host} via ${opts.bastion}` : opts.host;

  const lines: string[] = [];
  if (opts.dryRun) {
    lines.push(`[DRY-RUN] Comando validado (${opts.transport} @ ${hostLabel}): ${safeCommand}`);
    if (safeReason) lines.push(`Motivo: ${safeReason}`);
    lines.push('Nenhuma execução real foi disparada (dryRun=true).');
    return lines.join('\n');
  }

  const status = opts.timedOut
    ? 'TIMEOUT'
    : opts.sshTransportError
      ? 'SSH_TRANSPORT_ERROR (exit=255)'
      : `exit=${opts.exitCode ?? 'null'}`;
  lines.push(`[EXEC ${opts.transport} @ ${hostLabel}] ${safeCommand} (${status}, ${opts.durationMs} ms)`);
  if (opts.sshTransportError) {
    lines.push('Falha de transporte SSH (exitCode=255): verifique conectividade, host key, bastion ou credenciais.');
  }
  if (safeStdout.trim()) {
    lines.push('--- stdout ---');
    lines.push(safeStdout.trimEnd());
  }
  if (safeStderr.trim()) {
    lines.push('--- stderr ---');
    lines.push(safeStderr.trimEnd());
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
    'jumpHosts',
    'allowedJumpHosts',
    'sshConfigPath',
    'identityFile',
    'useSshAgent',
    'strictHostKeyChecking',
    'connectTimeoutSec',
    'hostPolicies',
    'cwd',
    'timeoutMs',
    'maxOutputBytes',
    'auditLogPath',
    'toolName',
  ],
  inputs: [
    { name: 'in', type: 'phrase' },
    { name: 'parcs', type: 'tokens_parcial' },
  ],
  outputs: [
    { name: 'out', type: 'phrase', required: false },
    { name: 'tool', type: 'tool', required: false },
  ],
  bindingNames: ['__onExecution', '__onExecChunk'],
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
    const allowedJump = Array.isArray(p.allowedJumpHosts)
      ? p.allowedJumpHosts.filter((x): x is string => typeof x === 'string')
      : [];
    if (p.allowedJumpHosts !== undefined) {
      if (!Array.isArray(p.allowedJumpHosts) || p.allowedJumpHosts.some((x) => typeof x !== 'string')) {
        errs.push({ path: 'params.allowedJumpHosts', code: 'INVALID_PARAM', message: 'allowedJumpHosts deve ser string[]' });
      } else {
        for (const hop of p.allowedJumpHosts) {
          const chk = validateJumpHost(hop as string);
          if (!chk.ok) {
            errs.push({ path: 'params.allowedJumpHosts', code: 'INVALID_PARAM', message: chk.reason });
          }
        }
      }
    }
    if (p.jumpHosts !== undefined) {
      if (!Array.isArray(p.jumpHosts) || p.jumpHosts.some((x) => typeof x !== 'string')) {
        errs.push({ path: 'params.jumpHosts', code: 'INVALID_PARAM', message: 'jumpHosts deve ser string[]' });
      } else {
        for (const hop of p.jumpHosts) {
          const chk = validateJumpHost(hop as string);
          if (!chk.ok) {
            errs.push({ path: 'params.jumpHosts', code: 'INVALID_PARAM', message: chk.reason });
          } else if (allowedJump.length > 0 && !allowedJump.includes(hop as string)) {
            errs.push({ path: 'params.jumpHosts', code: 'INVALID_PARAM', message: `jumpHost fora de allowedJumpHosts: ${hop}` });
          }
        }
      }
    }
    if (p.sshConfigPath !== undefined) {
      if (typeof p.sshConfigPath !== 'string') {
        errs.push({ path: 'params.sshConfigPath', code: 'INVALID_PARAM', message: 'sshConfigPath deve ser string' });
      } else {
        const chk = validateSshPath(p.sshConfigPath);
        if (!chk.ok) errs.push({ path: 'params.sshConfigPath', code: 'INVALID_PARAM', message: chk.reason });
      }
    }
    if (p.identityFile !== undefined) {
      if (typeof p.identityFile !== 'string') {
        errs.push({ path: 'params.identityFile', code: 'INVALID_PARAM', message: 'identityFile deve ser string' });
      } else {
        const chk = validateSshPath(p.identityFile);
        if (!chk.ok) errs.push({ path: 'params.identityFile', code: 'INVALID_PARAM', message: chk.reason });
      }
    }
    if (p.useSshAgent !== undefined && typeof p.useSshAgent !== 'boolean') {
      errs.push({ path: 'params.useSshAgent', code: 'INVALID_PARAM', message: 'useSshAgent deve ser boolean' });
    }
    if (p.strictHostKeyChecking !== undefined) {
      if (p.strictHostKeyChecking !== 'yes' && p.strictHostKeyChecking !== 'accept-new') {
        errs.push({
          path: 'params.strictHostKeyChecking',
          code: 'INVALID_PARAM',
          message: "strictHostKeyChecking deve ser 'yes' ou 'accept-new' ('no' é proibido)",
        });
      }
    }
    if (p.connectTimeoutSec !== undefined) {
      if (
        typeof p.connectTimeoutSec !== 'number' ||
        !Number.isFinite(p.connectTimeoutSec) ||
        p.connectTimeoutSec < 1 ||
        p.connectTimeoutSec > 30
      ) {
        errs.push({
          path: 'params.connectTimeoutSec',
          code: 'INVALID_PARAM',
          message: 'connectTimeoutSec deve ser número entre 1 e 30',
        });
      }
    }
    if (p.hostPolicies !== undefined) {
      if (!p.hostPolicies || typeof p.hostPolicies !== 'object' || Array.isArray(p.hostPolicies)) {
        errs.push({ path: 'params.hostPolicies', code: 'INVALID_PARAM', message: 'hostPolicies deve ser objeto Record<string, HostPolicy>' });
      } else {
        for (const [hostKey, rawHp] of Object.entries(p.hostPolicies as Record<string, unknown>)) {
          if (!rawHp || typeof rawHp !== 'object' || Array.isArray(rawHp)) {
            errs.push({ path: `params.hostPolicies.${hostKey}`, code: 'INVALID_PARAM', message: 'política de host deve ser objeto' });
            continue;
          }
          const hp = rawHp as Record<string, unknown>;
          if (hp.env !== undefined && hp.env !== 'dev' && hp.env !== 'staging' && hp.env !== 'prod') {
            errs.push({ path: `params.hostPolicies.${hostKey}.env`, code: 'INVALID_PARAM', message: "env deve ser 'dev' | 'staging' | 'prod'" });
          }
          if (hp.dryRun !== undefined && typeof hp.dryRun !== 'boolean') {
            errs.push({ path: `params.hostPolicies.${hostKey}.dryRun`, code: 'INVALID_PARAM', message: 'dryRun deve ser boolean' });
          }
          if (hp.mode !== undefined && hp.mode !== 'readonly' && hp.mode !== 'allowlist') {
            errs.push({ path: `params.hostPolicies.${hostKey}.mode`, code: 'INVALID_PARAM', message: "mode deve ser 'readonly' | 'allowlist'" });
          }
          if (hp.requireTypedConfirm !== undefined && typeof hp.requireTypedConfirm !== 'boolean') {
            errs.push({ path: `params.hostPolicies.${hostKey}.requireTypedConfirm`, code: 'INVALID_PARAM', message: 'requireTypedConfirm deve ser boolean' });
          }
          if (hp.jumpHosts !== undefined) {
            if (!Array.isArray(hp.jumpHosts) || hp.jumpHosts.some((x) => typeof x !== 'string')) {
              errs.push({ path: `params.hostPolicies.${hostKey}.jumpHosts`, code: 'INVALID_PARAM', message: 'jumpHosts deve ser string[]' });
            } else {
              for (const hop of hp.jumpHosts) {
                const chk = validateJumpHost(hop as string);
                if (!chk.ok) {
                  errs.push({ path: `params.hostPolicies.${hostKey}.jumpHosts`, code: 'INVALID_PARAM', message: chk.reason });
                } else if (allowedJump.length > 0 && !allowedJump.includes(hop as string)) {
                  errs.push({ path: `params.hostPolicies.${hostKey}.jumpHosts`, code: 'INVALID_PARAM', message: `jumpHost fora de allowedJumpHosts: ${hop}` });
                }
              }
            }
          }
        }
      }
    }
    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== 'number' || p.timeoutMs <= 0)) {
      errs.push({ path: 'params.timeoutMs', code: 'INVALID_PARAM', message: 'timeoutMs deve ser número positivo' });
    }
    if (p.maxOutputBytes !== undefined && (typeof p.maxOutputBytes !== 'number' || p.maxOutputBytes <= 0)) {
      errs.push({ path: 'params.maxOutputBytes', code: 'INVALID_PARAM', message: 'maxOutputBytes deve ser número positivo' });
    }
    if (p.toolName !== undefined && (typeof p.toolName !== 'string' || p.toolName.trim().length === 0)) {
      errs.push({ path: 'params.toolName', code: 'INVALID_PARAM', message: 'toolName deve ser string não vazia' });
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
    const jumpHosts = (ctx.params.jumpHosts as string[] | undefined) ?? [];
    const allowedJumpHosts = (ctx.params.allowedJumpHosts as string[] | undefined) ?? [];
    const sshConfigPath = ctx.params.sshConfigPath as string | undefined;
    const identityFile = ctx.params.identityFile as string | undefined;
    const useSshAgent = (ctx.params.useSshAgent as boolean | undefined) ?? true;
    const strictHostKeyChecking = (ctx.params.strictHostKeyChecking as 'yes' | 'accept-new' | undefined) ?? 'yes';
    const connectTimeoutSec = (ctx.params.connectTimeoutSec as number | undefined) ?? 5;
    const hostPolicies = ctx.params.hostPolicies as Record<string, HostPolicy> | undefined;
    const cwd = ctx.params.cwd as string | undefined;
    const rawTimeout = (ctx.params.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(Math.max(50, rawTimeout), MAX_TIMEOUT_MS);
    const maxOutputBytes = Math.max(64, (ctx.params.maxOutputBytes as number | undefined) ?? DEFAULT_MAX_OUTPUT_BYTES);
    const auditLogPath = (ctx.params.auditLogPath as string | undefined) ?? DEFAULT_AUDIT_LOG_PATH;
    const customToolName = (ctx.params.toolName as string | undefined)?.trim();
    const resolvedToolName = customToolName || (transport === 'ssh' ? 'exec_ssh' : 'exec_local');

    const basePolicy: ExecPolicy = {
      transport,
      mode,
      allowedPrefixes,
      allowedHosts,
      defaultHost,
      sshUser,
    };

    const defaultRunId = typeof ctx.bindings?.runId === 'string' ? ctx.bindings.runId : 'unknown';
    const onExecution = ctx.bindings?.__onExecution as ((ev: Record<string, unknown>) => void) | undefined;
    const onExecChunk = ctx.bindings?.__onExecChunk as ((ev: ExecChunkEvent) => void) | undefined;
    const emitChunkEvent = (ev: ExecChunkEvent) => {
      try {
        onExecChunk?.(ev);
      } catch {
        /* callback do host não derruba o nó */
      }
    };

    let execSeq = 0;
    const activeRuns = new Set<{ markInterrupted: () => void }>();

    const interruptAllActive = () => {
      for (const run of [...activeRuns]) {
        run.markInterrupted();
      }
    };

    const onAbort = () => {
      interruptAllActive();
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    type ExecRunOutcome =
      | {
          kind: 'denied';
          reason: string;
          command: string;
          host: string;
        }
      | {
          kind: 'ok';
          id: string;
          command: string;
          host: string;
          bastion?: string;
          dryRun: boolean;
          exitCode: number | null;
          durationMs: number;
          tExecStartMs: number;
          tExecEndMs: number;
          timedOut: boolean;
          truncated: boolean;
          interrupted: boolean;
          sshTransportError: boolean;
          requireTypedConfirm: boolean;
          report: string;
          errorMsg?: string;
        };

    async function executePayload(
      input: unknown,
      execOpts: { runId: string; signal?: AbortSignal },
    ): Promise<ExecRunOutcome> {
      const preExtracted = extractCommand(input);
      const preliminaryHost =
        transport === 'ssh'
          ? ((preExtracted.ok ? preExtracted.host : undefined) ?? defaultHost ?? '').trim()
          : 'local';
      const resolvedPolicy = resolveHostPolicy(
        preliminaryHost || 'local',
        { dryRun, mode, jumpHosts },
        hostPolicies,
      );
      const effectiveDryRun = resolvedPolicy.dryRun;
      const effectiveMode = resolvedPolicy.mode;
      const effectiveJumpHosts = resolvedPolicy.jumpHosts ?? [];
      const bastionLabel = effectiveJumpHosts.length > 0 ? effectiveJumpHosts.join(',') : undefined;
      const effectivePrefixes =
        effectiveMode === 'readonly' && mode !== 'readonly'
          ? [...DEFAULT_READONLY_PREFIXES]
          : allowedPrefixes;

      const callPolicy: ExecPolicy = {
        ...basePolicy,
        mode: effectiveMode,
        allowedPrefixes: effectivePrefixes,
      };

      const validation = validateCommand(input, callPolicy);
      if (!validation.ok) {
        const deniedHost = validation.host ?? (transport === 'ssh' ? (defaultHost ?? 'unknown') : 'local');
        const deniedCommand = validation.command ?? String(payloadText(input)?.text ?? '');
        ctx.metrics.counter('exec.command.denied', 1);
        ctx.log('warn', `exec.command bloqueado (${validation.code}): ${validation.reason}`);
        writeAuditEntry(
          auditLogPath,
          {
            ts: new Date().toISOString(),
            runId: execOpts.runId,
            nodeId: ctx.id,
            transport,
            host: deniedHost,
            ...(bastionLabel ? { bastion: bastionLabel } : {}),
            command: deniedCommand,
            dryRun: effectiveDryRun,
            decision: 'denied',
            reason: validation.reason,
          },
          ctx,
        );
        try {
          onExecution?.({
            nodeId: ctx.id,
            command: redactSecrets(deniedCommand).text,
            output: redactSecrets(`EXEC_POLICY_DENIED: ${validation.reason}`).text,
            host: deniedHost,
            ...(bastionLabel ? { bastion: bastionLabel } : {}),
            ok: false,
            dryRun: effectiveDryRun,
            ts: Date.now(),
          });
        } catch { /* callback do host não derruba o nó */ }
        return {
          kind: 'denied',
          reason: validation.reason,
          command: deniedCommand,
          host: deniedHost,
        };
      }

      const { command, argv, host, reason } = validation;

      if (transport === 'ssh') {
        for (const hop of effectiveJumpHosts) {
          const hopChk = validateJumpHost(hop);
          if (!hopChk.ok) {
            return { kind: 'denied', reason: hopChk.reason, command, host };
          }
          if (allowedJumpHosts.length > 0 && !allowedJumpHosts.includes(hop)) {
            return { kind: 'denied', reason: `jumpHost fora de allowedJumpHosts: ${hop}`, command, host };
          }
        }
      }

      const tExecStartMs = Date.now();
      const execId = `${ctx.id}:${tExecStartMs}:${++execSeq}`;
      const safeCommand = redactSecrets(command).text;

      if (effectiveDryRun) {
        const tExecEndMs = Date.now();
        const durationMs = tExecEndMs - tExecStartMs;
        ctx.metrics.counter('exec.command.dry_run', 1);
        writeAuditEntry(
          auditLogPath,
          {
            ts: new Date().toISOString(),
            runId: execOpts.runId,
            nodeId: ctx.id,
            transport,
            host,
            ...(bastionLabel ? { bastion: bastionLabel } : {}),
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
          bastion: bastionLabel,
          transport,
          dryRun: true,
          exitCode: 0,
          durationMs,
          timedOut: false,
          stdout: '',
          stderr: '',
          reason,
        });
        emitChunkEvent({
          type: 'exec_start',
          id: execId,
          nodeId: ctx.id,
          host,
          ...(bastionLabel ? { bastion: bastionLabel } : {}),
          command: safeCommand,
          dryRun: true,
          transport,
          ts: tExecStartMs,
        });
        emitChunkEvent({
          type: 'exec_chunk',
          id: execId,
          stream: 'stdout',
          text: report,
          ts: tExecEndMs,
        });
        emitChunkEvent({
          type: 'exec_end',
          id: execId,
          exitCode: 0,
          durationMs,
          ok: true,
          truncated: false,
          ts: tExecEndMs,
        });
        try {
          onExecution?.({
            id: execId,
            nodeId: ctx.id,
            command: safeCommand,
            output: report,
            host,
            ...(bastionLabel ? { bastion: bastionLabel } : {}),
            ok: true,
            exitCode: 0,
            durationMs,
            dryRun: true,
            ts: Date.now(),
          });
        } catch { /* callback do host */ }
        return {
          kind: 'ok',
          id: execId,
          command,
          host,
          ...(bastionLabel ? { bastion: bastionLabel } : {}),
          dryRun: true,
          exitCode: 0,
          durationMs,
          tExecStartMs,
          tExecEndMs,
          timedOut: false,
          truncated: false,
          interrupted: false,
          sshTransportError: false,
          requireTypedConfirm: resolvedPolicy.requireTypedConfirm,
          report,
        };
      }

      // Execução real controlada (shell: false sempre, detached: true para process group kill)
      let callInterrupted = false;
      const stdoutBuf = new TailBuffer(maxOutputBytes);
      const stderrBuf = new TailBuffer(maxOutputBytes);
      let timedOut = false;

      if (ctx.signal.aborted || execOpts.signal?.aborted) {
        const tExecEndMs = Date.now();
        const report = 'Execução cancelada (signal abortado).';
        try {
          onExecution?.({
            id: execId,
            nodeId: ctx.id,
            command: safeCommand,
            output: report,
            host,
            ...(bastionLabel ? { bastion: bastionLabel } : {}),
            ok: false,
            exitCode: null,
            durationMs: tExecEndMs - tExecStartMs,
            dryRun: false,
            ts: Date.now(),
          });
        } catch { /* callback do host */ }
        return {
          kind: 'ok',
          id: execId,
          command,
          host,
          ...(bastionLabel ? { bastion: bastionLabel } : {}),
          dryRun: false,
          exitCode: null,
          durationMs: tExecEndMs - tExecStartMs,
          tExecStartMs,
          tExecEndMs,
          timedOut: false,
          truncated: false,
          interrupted: true,
          sshTransportError: false,
          requireTypedConfirm: resolvedPolicy.requireTypedConfirm,
          report,
        };
      }

      emitChunkEvent({
        type: 'exec_start',
        id: execId,
        nodeId: ctx.id,
        host,
        ...(bastionLabel ? { bastion: bastionLabel } : {}),
        command: safeCommand,
        dryRun: false,
        transport,
        ts: tExecStartMs,
      });

      const createStreamEmitter = (streamName: 'stdout' | 'stderr') => {
        const redactor = createLineRedactor();
        let pending = '';
        let flushTimer: ReturnType<typeof setTimeout> | null = null;

        const flushPending = () => {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          if (!pending) return;
          const text = pending;
          pending = '';
          emitChunkEvent({
            type: 'exec_chunk',
            id: execId,
            stream: streamName,
            text,
            ts: Date.now(),
          });
        };

        const appendRedacted = (text: string) => {
          if (!text) return;
          pending += text;
          if (Buffer.byteLength(pending, 'utf8') >= STREAM_THROTTLE_BYTES) {
            flushPending();
          } else if (!flushTimer) {
            flushTimer = setTimeout(flushPending, STREAM_THROTTLE_MS);
            flushTimer.unref?.();
          }
        };

        return {
          push(raw: string) {
            const { text } = redactor.push(raw);
            appendRedacted(text);
          },
          end() {
            const { text } = redactor.flush();
            if (text) pending += text;
            flushPending();
          },
        };
      };

      const stdoutEmitter = createStreamEmitter('stdout');
      const stderrEmitter = createStreamEmitter('stderr');

      const execResult = await new Promise<{ exitCode: number | null; errorMsg?: string }>((resolve) => {
        let settled = false;
        let child: ChildProcess | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const runHandle = {
          markInterrupted: () => {
            callInterrupted = true;
            if (child) killProcessTree(child);
          },
        };
        activeRuns.add(runHandle);

        const onCallAbort = () => {
          runHandle.markInterrupted();
        };

        const finish = (res: { exitCode: number | null; errorMsg?: string }) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (execOpts.signal) {
            execOpts.signal.removeEventListener('abort', onCallAbort);
          }
          activeRuns.delete(runHandle);
          resolve(res);
        };

        try {
          if (transport === 'local') {
            child = spawn(argv[0], argv.slice(1), {
              shell: false,
              detached: true,
              cwd,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          } else {
            const remoteCommand = buildSshRemoteCommand(argv);
            const sshArgs = buildSshArgv({
              host,
              sshUser,
              sshPort,
              remoteCommand,
              jumpHosts: effectiveJumpHosts,
              allowedJumpHosts,
              sshConfigPath,
              identityFile,
              useSshAgent,
              strictHostKeyChecking,
              connectTimeoutSec,
            });
            child = spawn('ssh', sshArgs, {
              shell: false,
              detached: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
          }
        } catch (err: unknown) {
          finish({ exitCode: null, errorMsg: (err as Error)?.message ?? String(err) });
          return;
        }

        if (execOpts.signal) {
          execOpts.signal.addEventListener('abort', onCallAbort, { once: true });
        }

        const spawned = child;
        timer = setTimeout(() => {
          timedOut = true;
          ctx.metrics.counter('exec.command.killed', 1);
          ctx.log('warn', `exec.command timeout após ${timeoutMs} ms: ${command}`);
          killProcessTree(spawned);
        }, timeoutMs);

        spawned.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf.append(chunk);
          stdoutEmitter.push(chunk.toString('utf8'));
        });
        spawned.stderr?.on('data', (chunk: Buffer) => {
          stderrBuf.append(chunk);
          stderrEmitter.push(chunk.toString('utf8'));
        });

        spawned.once('error', (err) => {
          finish({ exitCode: null, errorMsg: err.message });
        });

        spawned.once('close', (code) => {
          finish({ exitCode: code });
        });
      });

      stdoutEmitter.end();
      stderrEmitter.end();

      const interrupted = callInterrupted;
      const sshTransportError = transport === 'ssh' && execResult.exitCode === 255;
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
          runId: execOpts.runId,
          nodeId: ctx.id,
          transport,
          host,
          ...(bastionLabel ? { bastion: bastionLabel } : {}),
          command,
          dryRun: false,
          decision: 'allowed',
          reason: interrupted ? 'interrupted' : reason,
          exitCode: execResult.exitCode,
          durationMs,
          timedOut,
          ...(sshTransportError ? { sshTransportError: true } : {}),
        },
        ctx,
      );

      const report = formatReport({
        command,
        host,
        bastion: bastionLabel,
        transport,
        dryRun: false,
        exitCode: execResult.exitCode,
        durationMs,
        timedOut,
        sshTransportError,
        stdout: stdoutBuf.toString(),
        stderr: stderrText,
        reason,
      });

      const __ok = !timedOut && !interrupted && execResult.exitCode === 0 && !execResult.errorMsg;
      emitChunkEvent({
        type: 'exec_end',
        id: execId,
        exitCode: execResult.exitCode,
        durationMs,
        ok: __ok,
        truncated,
        ts: tExecEndMs,
      });
      try {
        onExecution?.({
          id: execId,
          nodeId: ctx.id,
          command: safeCommand,
          output: report,
          host,
          ...(bastionLabel ? { bastion: bastionLabel } : {}),
          ok: __ok,
          exitCode: execResult.exitCode,
          durationMs,
          dryRun: false,
          ...(sshTransportError ? { sshTransportError: true } : {}),
          ts: Date.now(),
        });
      } catch { /* callback do host */ }

      return {
        kind: 'ok',
        id: execId,
        command,
        host,
        ...(bastionLabel ? { bastion: bastionLabel } : {}),
        dryRun: false,
        exitCode: execResult.exitCode,
        durationMs,
        tExecStartMs,
        tExecEndMs,
        timedOut,
        truncated,
        interrupted,
        sshTransportError,
        requireTypedConfirm: resolvedPolicy.requireTypedConfirm,
        report,
        errorMsg: execResult.errorMsg,
      };
    }

    const prefixSummary =
      allowedPrefixes.length > 0 ? allowedPrefixes.slice(0, 12).join(', ') + (allowedPrefixes.length > 12 ? ', ...' : '') : '(nenhum)';
    const hostSummary =
      transport === 'ssh'
        ? ` | hosts permitidos: ${allowedHosts.length > 0 ? allowedHosts.join(', ') : '(nenhum)'}`
        : '';

    const toolDef: ToolDef = {
      name: resolvedToolName,
      description: `Executa comando único via ${transport} (mode=${mode}, dryRun=${dryRun}${hostSummary} | prefixos: ${prefixSummary}).`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Comando único a executar (sem metacaracteres de shell).',
          },
          ...(transport === 'ssh'
            ? {
                host: {
                  type: 'string',
                  description: `Host SSH de destino (permitidos: ${allowedHosts.length > 0 ? allowedHosts.join(', ') : 'nenhum'}).`,
                },
              }
            : {}),
          reason: {
            type: 'string',
            description: 'Motivo opcional da execução para registro no audit log.',
          },
        },
        required: transport === 'ssh' ? ['command', 'host'] : ['command'],
      },
      readonly: mode === 'readonly',
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
        if (name !== resolvedToolName) {
          return {
            ok: false,
            output: `Tool desconhecida para ${ctx.id}: ${name} (esperado: ${resolvedToolName})`,
            durationMs: 0,
          };
        }
        const outcome = await executePayload(args, {
          runId: opts.runId || defaultRunId,
          signal: opts.signal,
        });
        if (outcome.kind === 'denied') {
          return {
            ok: false,
            output: `EXEC_POLICY_DENIED: ${outcome.reason}`,
            durationMs: 0,
            meta: {
              code: 'EXEC_POLICY_DENIED',
              command: outcome.command,
              host: outcome.host,
              transport,
            },
          };
        }
        const ok = outcome.dryRun
          ? true
          : !outcome.timedOut && !outcome.interrupted && outcome.exitCode === 0 && !outcome.errorMsg;
        return {
          ok,
          output: outcome.report,
          exitCode: outcome.exitCode ?? undefined,
          dryRun: outcome.dryRun,
          durationMs: outcome.durationMs,
          meta: {
            command: outcome.command,
            host: outcome.host,
            ...(outcome.bastion ? { bastion: outcome.bastion } : {}),
            transport,
            truncated: outcome.truncated,
            timedOut: outcome.timedOut,
            interrupted: outcome.interrupted,
            ...(outcome.sshTransportError ? { sshTransportError: true } : {}),
            ...(outcome.requireTypedConfirm ? { requireTypedConfirm: true } : {}),
          },
        };
      },
    };

    return {
      toolProvider,

      async start() {},

      onControl(c: ControlMsg) {
        if (c.kind === 'interrupt') {
          if (activeRuns.size > 0) {
            ctx.metrics.counter('exec.command.killed', activeRuns.size);
            ctx.log('info', `exec.command interrompido por controle (${c.reason ?? 'interrupt'})`);
            interruptAllActive();
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

        const outcome = await executePayload(msg.payload, { runId: defaultRunId });
        if (outcome.kind === 'denied') {
          throw new GraphError('EXEC_POLICY_DENIED', ctx.id, outcome.reason);
        }

        if (outcome.interrupted) {
          return;
        }

        const prevTrace =
          msg.meta && typeof msg.meta.trace === 'object' && msg.meta.trace !== null
            ? (msg.meta.trace as Record<string, unknown>)
            : {};

        await ctx.emit('out', outcome.report, {
          meta: {
            ...msg.meta,
            exec: {
              id: outcome.id,
              command: outcome.command,
              host: outcome.host,
              ...(outcome.bastion ? { bastion: outcome.bastion } : {}),
              exitCode: outcome.exitCode,
              durationMs: outcome.durationMs,
              dryRun: outcome.dryRun,
              truncated: outcome.truncated,
              timedOut: outcome.timedOut,
              ...(outcome.sshTransportError ? { sshTransportError: true } : {}),
            },
            trace: {
              ...prevTrace,
              tExecStartMs: outcome.tExecStartMs,
              tExecEndMs: outcome.tExecEndMs,
              exitCode: outcome.exitCode,
            },
          },
        });
      },

      async stop() {
        ctx.signal.removeEventListener('abort', onAbort);
        if (activeRuns.size > 0) {
          interruptAllActive();
        }
      },
    };
  },
};
