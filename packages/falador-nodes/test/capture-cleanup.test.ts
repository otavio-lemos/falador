// falador-nodes — W5-Fix-Capture-Orfa: o child da captura NUNCA fica órfão.
// Duas garantias cobertas:
//   C1: stop() mata o child E remove o handler de process 'exit' (sem leak).
//   C2: QUALQUER process.exit() mata o child via handler 'exit' SÍNCRONO
//       (runner morto por sinal do host sem passar por stop()).
import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureFfmpeg } from '../src/index.ts';

// binário FALSO de captura: registra o próprio pid e fica vivo (como capture-sck).
function fakeCapture(): { path: string; pidFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'falador-capture-'));
  const pidFile = join(dir, 'pid');
  const path = join(dir, 'fake-capture');
  writeFileSync(path, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`);
  chmodSync(path, 0o755);
  return { path, pidFile };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitDead(pid: number, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (!alive(pid)) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 40);
    };
    tick();
  });
}

function makeCtx(params: Record<string, unknown>) {
  return {
    params,
    log: () => {},
    signal: { aborted: false } as AbortSignal,
    emit: async () => true,
    metrics: { counter() {}, timer() {}, gauge() {} },
  } as unknown as Parameters<typeof captureFfmpeg.create>[0];
}

/** Cria o nó com o binário falso, dá start() e devolve o handler de 'exit' novo. */
async function spawnFake() {
  const fake = fakeCapture();
  const ctx = makeCtx({ backend: 'sck', input: '', chunkMs: 80, sckPath: fake.path });
  const known = new Set(process.listeners('exit'));
  const node = captureFfmpeg.create(ctx);
  const added = process.listeners('exit').filter((h) => !known.has(h));
  await node.start();
  let pid = 0;
  for (let i = 0; i < 150 && !pid; i++) {
    try {
      pid = Number(readFileSync(fake.pidFile, 'utf-8').trim());
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  assert.ok(pid > 0, 'child falso deve registrar o próprio pid');
  assert.equal(added.length, 1, 'create() registra exatamente 1 handler de exit');
  assert.equal(process.listenerCount('exit'), known.size + 1);
  return { node, pid, added: added[0] as () => void, known };
}

test('C1: stop() mata o child da captura e remove o handler de exit', async () => {
  const { node, pid, known } = await spawnFake();
  await node.stop();
  assert.equal(process.listenerCount('exit'), known.size, 'stop() remove o handler (sem leak)');
  assert.ok(await waitDead(pid), 'child deve morrer no stop()');
});

test('C2: handler de exit mata o child mesmo sem stop() (runner morto por sinal)', async () => {
  const { node, pid, added, known } = await spawnFake();
  added(); // simula o que o Node faz em process.exit() — handlers 'exit' são SÍNCRONOS
  assert.ok(await waitDead(pid), 'child deve ser morto pelo handler de exit');
  assert.ok(!alive(pid), 'SIGKILL no child é imediato');
  await node.stop(); // child já morto; só precisa limpar o listener
  assert.equal(process.listenerCount('exit'), known.size, 'stop() após cleanup não deixa listener');
});

test('C3: capture-sck real é encerrado no stop() do nó', async (t) => {
  const sckPath = fileURLToPath(new URL('../../../services/capture-sck', import.meta.url));
  if (!existsSync(sckPath)) return t.skip('services/capture-sck não compilado');
  const ctx = makeCtx({ backend: 'sck', input: '', chunkMs: 80, sckPath });
  const known = new Set(process.listeners('exit'));
  const node = captureFfmpeg.create(ctx);
  try {
    await node.start();
  } catch (err) {
    await node.stop();
    return t.skip(`capture-sck não subiu aqui (TCC/ambiente): ${String((err as Error)?.message ?? err)}`);
  }
  await new Promise((r) => setTimeout(r, 1200));
  await node.stop();
  assert.equal(process.listenerCount('exit'), known.size, 'stop() limpa o handler de exit');
});