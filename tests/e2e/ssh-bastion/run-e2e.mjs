// tests/e2e/ssh-bastion/run-e2e.mjs
// Harness E2E Real — Docker Bastion + Target SSH -J + Redact + Audit (Node 26 ESM, zero deps)
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Importa os nós oficiais e helpers do repositório
import { execCommand } from '../../../packages/falador-nodes/src/exec-command.ts';
import {
  GENESIS_HASH,
  chainAuditEvent,
  verifyAuditChain,
} from '../../../packages/falador-nodes/src/audit.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const VALIDATE_RUN_CLI = join(ROOT, 'packages/falador-cli/validate-run.mjs');

/** Verifica disponibilidade do daemon Docker sem falhar silenciosamente */
function checkDockerAvailable() {
  try {
    const res = spawnSync('docker', ['info'], { stdio: 'pipe', encoding: 'utf8' });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Aguarda porta TCP responder (para garantir que o sshd subiu) */
async function waitForPort(port, host = '127.0.0.1', timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((res) => {
      const sock = new net.Socket();
      sock.setTimeout(500);
      sock.once('connect', () => {
        sock.destroy();
        res(true);
      });
      sock.once('timeout', () => {
        sock.destroy();
        res(false);
      });
      sock.once('error', () => {
        sock.destroy();
        res(false);
      });
      sock.connect(port, host);
    });
    if (ok) {
      // Pequena folga adicional para o sshd completar o handshake inicial
      await new Promise((r) => setTimeout(r, 200));
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** Cria fake NodeCtx para executar o nó execCommand isolado com rastreamento completo */
function createFakeCtx(params, bindings = {}) {
  const ctl = new AbortController();
  const emitted = [];
  const logs = [];
  const counters = new Map();
  return {
    ctx: {
      id: 'exec-e2e',
      params,
      bindings,
      signal: ctl.signal,
      log: (level, msg) => logs.push({ level, msg }),
      metrics: {
        counter: (name, inc = 1) => counters.set(name, (counters.get(name) ?? 0) + inc),
        timer: () => {},
      },
      emit: async (port, payload, opts) => {
        emitted.push({ port, payload, meta: opts?.meta });
      },
    },
    ctl,
    emitted,
    logs,
    counters,
  };
}

async function main() {
  console.log('=== Falador E2E SSH Bastion Harness ===\n');

  // 1. Verificação do daemon Docker
  console.log('[1/4] Verificando daemon Docker...');
  if (!checkDockerAvailable()) {
    console.log('[SKIP] DOCKER_UNAVAILABLE: Docker daemon is not accessible.');
    console.log('Harness finalizado limpo (exit 0) devido à ausência do runtime Docker.');
    process.exit(0);
  }
  console.log('✅ Docker daemon acessível e operacional.\n');

  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const imageTag = `falador-ssh-e2e:${runSuffix}`;
  const networkName = `falador-net-${runSuffix}`;
  const bastionName = `bastion-${runSuffix}`;
  const targetName = `target-node-${runSuffix}`;
  const tempDir = mkdtempSync(join(tmpdir(), `falador-ssh-e2e-${runSuffix}-`));
  const auditDir = join(tempDir, 'audit');
  mkdirSync(auditDir, { recursive: true });

  console.log(`[2/4] Preparando infraestrutura efêmera em ${tempDir}:`);
  console.log(`      - Image: ${imageTag}`);
  console.log(`      - Network: ${networkName}`);
  console.log(`      - Bastion container: ${bastionName}`);
  console.log(`      - Target container: ${targetName} (alias: target-node)`);

  let bastionPort = 0;

  try {
    // 2. Geração de chaves ed25519 efêmeras
    const clientKeyPath = join(tempDir, 'id_ed25519');
    const bastionHostKeyPath = join(tempDir, 'bastion_host_key');
    const targetHostKeyPath = join(tempDir, 'target_host_key');
    const secretsPath = join(tempDir, 'secrets.env');

    spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', clientKeyPath, '-C', 'client'], { stdio: 'ignore' });
    spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', bastionHostKeyPath, '-C', 'bastion'], { stdio: 'ignore' });
    spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', targetHostKeyPath, '-C', 'target'], { stdio: 'ignore' });

    chmodSync(clientKeyPath, 0o600);
    chmodSync(bastionHostKeyPath, 0o600);
    chmodSync(targetHostKeyPath, 0o600);

    const clientPub = readFileSync(`${clientKeyPath}.pub`, 'utf8').trim();
    const bastionPub = readFileSync(`${bastionHostKeyPath}.pub`, 'utf8').trim();
    const targetPub = readFileSync(`${targetHostKeyPath}.pub`, 'utf8').trim();

    writeFileSync(secretsPath, 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nDB_PASSWORD=supersecret\n', 'utf8');

    // 3. Build da imagem Alpine enxuta
    console.log('      - Construindo imagem Docker...');
    const buildRes = spawnSync('docker', ['build', '-t', imageTag, __dirname], { stdio: 'inherit' });
    assert.equal(buildRes.status, 0, 'Falha ao construir imagem Docker');

    // 4. Criação da rede bridge isolada
    console.log('      - Criando rede bridge...');
    execSync(`docker network create ${networkName}`, { stdio: 'ignore' });

    // 5. Inicialização dos containers
    console.log('      - Subindo container bastion com porta mapeada em localhost...');
    execSync(
      `docker run -d --name ${bastionName} --network ${networkName} --network-alias bastion ` +
      `-p 127.0.0.1:0:22 ` +
      `-v "${bastionHostKeyPath}:/etc/ssh/ssh_host_ed25519_key:ro" ` +
      `-v "${clientKeyPath}.pub:/root/.ssh/authorized_keys:ro" ` +
      `${imageTag}`,
      { stdio: 'ignore' },
    );

    console.log('      - Subindo container target-node isolado na rede bridge...');
    execSync(
      `docker run -d --name ${targetName} --hostname target-node --network ${networkName} --network-alias target-node ` +
      `-v "${targetHostKeyPath}:/etc/ssh/ssh_host_ed25519_key:ro" ` +
      `-v "${clientKeyPath}.pub:/root/.ssh/authorized_keys:ro" ` +
      `-v "${secretsPath}:/tmp/secrets.env:ro" ` +
      `${imageTag}`,
      { stdio: 'ignore' },
    );

    // Obtém a porta mapeada do bastion
    const portOut = execSync(`docker port ${bastionName} 22/tcp`, { encoding: 'utf8' }).trim();
    const match = /:(\d+)$/.exec(portOut);
    assert.ok(match, `Não foi possível extrair porta do bastion: ${portOut}`);
    bastionPort = Number(match[1]);
    console.log(`      - Bastion acessível em 127.0.0.1:${bastionPort}`);

    // Aguarda sshd no bastion
    const ready = await waitForPort(bastionPort, '127.0.0.1');
    assert.ok(ready, `Timeout aguardando SSH no bastion (porta ${bastionPort})`);

    // 6. Popula known_hosts temporário para strictHostKeyChecking: 'yes'
    const knownHostsPath = join(tempDir, 'known_hosts');
    const knownHostsContent = [
      `[127.0.0.1]:${bastionPort} ${bastionPub}`,
      `target-node ${targetPub}`,
      `[target-node]:22 ${targetPub}`,
    ].join('\n') + '\n';
    writeFileSync(knownHostsPath, knownHostsContent, 'utf8');

    // Cria ssh_config que utiliza o known_hosts e a chave privada efêmera
    const sshConfigPath = join(tempDir, 'ssh_config');
    const sshConfigContent = [
      'Host *',
      `  UserKnownHostsFile ${knownHostsPath}`,
      '  StrictHostKeyChecking yes',
      '  IdentitiesOnly yes',
      `  IdentityFile ${clientKeyPath}`,
      '  ConnectTimeout 5',
      '  BatchMode yes',
    ].join('\n') + '\n';
    writeFileSync(sshConfigPath, sshConfigContent, 'utf8');

    console.log('✅ Infraestrutura pronta e validada.\n');

    // =========================================================================
    // CENÁRIO 1: Comando diagnóstico real via bastion -> target-node
    // =========================================================================
    console.log('[3/4] Executando Cenários de Teste...');
    console.log('\n--- Cenário 1: Comando Diagnóstico Real via Bastion (-J) ---');

    const execAuditFile = join(tempDir, 'exec-audit.jsonl');
    const chunks1 = [];
    const runId1 = `run-c1-${Date.now()}`;

    const { ctx: ctx1 } = createFakeCtx({
      transport: 'ssh',
      mode: 'allowlist',
      dryRun: false,
      allowedPrefixes: ['uname', 'hostname', 'cat'],
      allowedHosts: ['target-node'],
      defaultHost: 'target-node',
      sshUser: 'root',
      sshPort: 22,
      jumpHosts: [`root@127.0.0.1:${bastionPort}`],
      allowedJumpHosts: [`root@127.0.0.1:${bastionPort}`],
      identityFile: clientKeyPath,
      sshConfigPath: sshConfigPath,
      strictHostKeyChecking: 'yes',
      auditLogPath: execAuditFile,
      timeoutMs: 15000,
    }, {
      __onExecChunk: (ev) => chunks1.push(ev),
      runId: runId1,
    });

    const rt1 = execCommand.create(ctx1);
    const res1 = await rt1.toolProvider.invoke(
      'exec_ssh',
      { command: 'uname -a', host: 'target-node' },
      { signal: new AbortController().signal, runId: runId1, callerNodeId: 'caller-1' },
    );

    console.log('Saída de uname -a:');
    console.log(res1.output.trim());

    assert.equal(res1.ok, true, `Comando diagnóstico falhou: ${res1.output}`);
    assert.equal(res1.exitCode, 0, `ExitCode divergente de 0: ${res1.exitCode}`);
    assert.match(res1.output, /Linux/i);
    assert.match(res1.output, /target-node/i);

    // Validação de chunks em tempo real recebidos antes do término
    const textChunks1 = chunks1.filter((c) => c.type === 'exec_chunk');
    assert.ok(textChunks1.length > 0, 'Deve ter recebido ao menos 1 exec_chunk em tempo real');
    const combinedChunks1 = textChunks1.map((c) => c.text).join('');
    assert.match(combinedChunks1, /Linux/i);
    assert.match(combinedChunks1, /target-node/i);

    // Executa também 'hostname' para validar comando adicional no mesmo canal
    const res1b = await rt1.toolProvider.invoke(
      'exec_ssh',
      { command: 'hostname', host: 'target-node' },
      { signal: new AbortController().signal, runId: runId1, callerNodeId: 'caller-1' },
    );
    assert.equal(res1b.ok, true);
    assert.match(res1b.output, /target-node/);

    // Validação de integridade da cadeia SHA-256 via verifyAuditChain e validate-run.mjs
    console.log('\nValidando integridade da trilha de auditoria SHA-256...');
    let prevHash = GENESIS_HASH;
    const auditChainEvents = [];

    const eStart = chainAuditEvent({
      runId: runId1,
      seq: 1,
      ts: Date.now() - 500,
      op: 'run_started',
      nodeId: 'runner',
    }, prevHash);
    auditChainEvents.push(eStart);
    prevHash = eStart.hash;

    const eTool = chainAuditEvent({
      runId: runId1,
      seq: 2,
      ts: Date.now() - 200,
      op: 'tool_call',
      nodeId: 'exec-e2e',
      tool: 'exec_ssh',
      args: { command: 'uname -a', host: 'target-node' },
      ok: true,
      gate: 'approved',
      outputPreview: res1.output.slice(0, 100),
    }, prevHash);
    auditChainEvents.push(eTool);
    prevHash = eTool.hash;

    const eEnd = chainAuditEvent({
      runId: runId1,
      seq: 3,
      ts: Date.now(),
      op: 'run_stopped',
      nodeId: 'runner',
    }, prevHash);
    auditChainEvents.push(eEnd);

    // 1) Teste direto do verifyAuditChain
    const chainCheck = verifyAuditChain(auditChainEvents);
    assert.deepEqual(chainCheck, { ok: true, checked: 3 }, 'verifyAuditChain falhou na cadeia legítima');

    // 2) Teste de detecção de adulteração (tampering)
    const tampered = [auditChainEvents[0], { ...auditChainEvents[1], ok: false }, auditChainEvents[2]];
    const tamperedCheck = verifyAuditChain(tampered);
    assert.equal(tamperedCheck.ok, false, 'verifyAuditChain deveria ter rejeitado evento adulterado');

    // 3) Gravação e validação via CLI determinístico validate-run.mjs
    const auditRunFile = join(auditDir, `${runId1}.jsonl`);
    writeFileSync(auditRunFile, auditChainEvents.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const validateRes = spawnSync(process.execPath, [VALIDATE_RUN_CLI, runId1], {
      env: { ...process.env, FALADOR_AUDIT_DIR: auditDir },
      encoding: 'utf8',
    });
    console.log('validate-run.mjs output:');
    console.log(validateRes.stdout.trim());
    assert.equal(validateRes.status, 0, `validate-run.mjs falhou com exit code ${validateRes.status}:\n${validateRes.stderr}`);
    assert.match(validateRes.stdout, /Cadeia SHA-256 íntegra/);
    assert.match(validateRes.stdout, /Overall: PASS/);
    console.log('✅ Cenário 1 PASS: Comando diagnóstico executado via bastion com chunks e auditoria SHA-256 íntegra.');

    // =========================================================================
    // CENÁRIO 2: Teste negativo de vazamento de segredo (Redaction)
    // =========================================================================
    console.log('\n--- Cenário 2: Teste Negativo de Vazamento de Segredo (Redaction) ---');

    const chunks2 = [];
    const runId2 = `run-c2-${Date.now()}`;
    const { ctx: ctx2 } = createFakeCtx({
      transport: 'ssh',
      mode: 'allowlist',
      dryRun: false,
      allowedPrefixes: ['cat'],
      allowedHosts: ['target-node'],
      defaultHost: 'target-node',
      sshUser: 'root',
      sshPort: 22,
      jumpHosts: [`root@127.0.0.1:${bastionPort}`],
      allowedJumpHosts: [`root@127.0.0.1:${bastionPort}`],
      identityFile: clientKeyPath,
      sshConfigPath: sshConfigPath,
      strictHostKeyChecking: 'yes',
      auditLogPath: execAuditFile,
      timeoutMs: 15000,
    }, {
      __onExecChunk: (ev) => chunks2.push(ev),
      runId: runId2,
    });

    const rt2 = execCommand.create(ctx2);
    // Comando remoto que imprime os segredos na saída padrão
    const res2 = await rt2.toolProvider.invoke(
      'exec_ssh',
      { command: 'cat /tmp/secrets.env', host: 'target-node' },
      { signal: new AbortController().signal, runId: runId2, callerNodeId: 'caller-2' },
    );

    console.log('Saída de cat /tmp/secrets.env (mascarada):');
    console.log(res2.output.trim());

    const rawAws = 'AKIAIOSFODNN7EXAMPLE';
    const rawSecret = 'supersecret';

    // 1) Validação da saída final do comando
    assert.equal(res2.output.includes(rawAws), false, 'Segredo AWS vazou na saída final!');
    assert.equal(res2.output.includes(rawSecret), false, 'Segredo de senha vazou na saída final!');
    assert.match(res2.output, /\[REDACTED:aws_key\]/, 'Ausência do marcador [REDACTED:aws_key] na saída final');
    assert.match(res2.output, /\[REDACTED:secret\]/, 'Ausência do marcador [REDACTED:secret] na saída final');

    // 2) Validação dos chunks recebidos em streaming
    const textChunks2 = chunks2.filter((c) => c.type === 'exec_chunk').map((c) => c.text);
    for (const chunk of textChunks2) {
      assert.equal(chunk.includes(rawAws), false, `Segredo AWS vazou em chunk de streaming: ${chunk}`);
      assert.equal(chunk.includes(rawSecret), false, `Segredo de senha vazou em chunk de streaming: ${chunk}`);
    }
    const combinedChunks2 = textChunks2.join('');
    assert.match(combinedChunks2, /\[REDACTED:aws_key\]/);
    assert.match(combinedChunks2, /\[REDACTED:secret\]/);

    // 3) Validação do audit JSONL (exec-audit.jsonl)
    const auditLines = readFileSync(execAuditFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const c2Audit = auditLines.find((a) => a.runId === runId2);
    assert.ok(c2Audit, 'Registro de auditoria para o Cenário 2 não encontrado');
    const auditText = JSON.stringify(c2Audit);
    assert.equal(auditText.includes(rawAws), false, 'Segredo AWS vazou no audit log!');
    assert.equal(auditText.includes(rawSecret), false, 'Segredo de senha vazou no audit log!');

    console.log('✅ Cenário 2 PASS: Segredos mascarados em exec_chunk, saída final e audit JSONL.');

    // =========================================================================
    // CENÁRIO 3: Comando interativo (vim /etc/hosts) bloqueado imediatamente
    // =========================================================================
    console.log('\n--- Cenário 3: Bloqueio Imediato de Comando Interativo (EXEC_POLICY_DENIED) ---');

    const chunks3 = [];
    const runId3 = `run-c3-${Date.now()}`;
    const { ctx: ctx3 } = createFakeCtx({
      transport: 'ssh',
      mode: 'allowlist',
      dryRun: false,
      allowedPrefixes: ['uname', 'cat', 'vim'], // Mesmo se 'vim' estivesse na allowlist, denylist dura bloqueia
      allowedHosts: ['target-node'],
      defaultHost: 'target-node',
      sshUser: 'root',
      sshPort: 22,
      jumpHosts: [`root@127.0.0.1:${bastionPort}`],
      allowedJumpHosts: [`root@127.0.0.1:${bastionPort}`],
      identityFile: clientKeyPath,
      sshConfigPath: sshConfigPath,
      strictHostKeyChecking: 'yes',
      auditLogPath: execAuditFile,
    }, {
      __onExecChunk: (ev) => chunks3.push(ev),
      runId: runId3,
    });

    const rt3 = execCommand.create(ctx3);
    const res3 = await rt3.toolProvider.invoke(
      'exec_ssh',
      { command: 'vim /etc/hosts', host: 'target-node' },
      { signal: new AbortController().signal, runId: runId3, callerNodeId: 'caller-3' },
    );

    console.log('Resultado da tentativa com vim:');
    console.log(res3.output.trim());

    assert.equal(res3.ok, false, 'Comando interativo deveria retornar ok: false');
    assert.match(res3.output, /EXEC_POLICY_DENIED/);
    assert.match(res3.output, /Binário interativo/i);

    // Valida que nenhum chunk de streaming remoto foi emitido (bloqueio antes de abrir SSH)
    assert.equal(chunks3.length, 0, 'Nenhum chunk SSH deveria ser emitido para comando bloqueado');

    // Valida registro de negação no audit log
    const updatedAuditLines = readFileSync(execAuditFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const c3Audit = updatedAuditLines.find((a) => a.runId === runId3);
    assert.ok(c3Audit, 'Registro de auditoria para o Cenário 3 não encontrado');
    assert.equal(c3Audit.decision, 'denied');
    assert.match(c3Audit.reason, /Binário interativo/i);

    console.log('✅ Cenário 3 PASS: Comando interativo bloqueado imediatamente com EXEC_POLICY_DENIED sem spawn.');

    console.log('\n[4/4] Todos os 3 cenários E2E foram executados com sucesso total!');
  } finally {
    // Limpeza garantida em bloco finally
    console.log('\nExecutando limpeza de recursos efêmeros (finally)...');
    try {
      execSync(`docker rm -f ${bastionName} ${targetName}`, { stdio: 'ignore' });
    } catch {}
    try {
      execSync(`docker network rm ${networkName}`, { stdio: 'ignore' });
    } catch {}
    try {
      execSync(`docker rmi ${imageTag}`, { stdio: 'ignore' });
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    console.log('✅ Containers, rede, imagem e diretório temporário removidos.');
  }
}

main().catch((err) => {
  console.error('\n❌ Erro fatal na execução do harness E2E:');
  console.error(err);
  process.exit(1);
});
