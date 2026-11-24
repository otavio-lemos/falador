// apps/web-server.terminal.test.mjs — testes do Terminal PTY real (pty-bridge.py + SSE + HTTP)
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

async function waitForOutput(reader, matcher, timeoutMs = 8000) {
  const dec = new TextDecoder();
  let sseBuf = '';
  let ptyOut = '';
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(50, deadline - Date.now());
    const readPromise = reader.read();
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining));
    const res = await Promise.race([readPromise, timeoutPromise]);
    if (res.timeout || res.done) break;

    sseBuf += dec.decode(res.value, { stream: true });
    let idx;
    while ((idx = sseBuf.indexOf('\n\n')) >= 0) {
      const block = sseBuf.slice(0, idx);
      sseBuf = sseBuf.slice(idx + 2);
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      if (eventLine && eventLine.slice(7).trim() === 'output') {
        try {
          const parsed = JSON.parse(dataLine.slice(6));
          if (typeof parsed.data === 'string') {
            ptyOut += Buffer.from(parsed.data, 'base64').toString('utf8');
          }
        } catch { /* ignore */ }
      }
    }
    if (matcher(ptyOut)) return ptyOut;
  }
  return ptyOut;
}

describe('apps/web-server.mjs — Terminal PTY real', () => {
  test('PTY session: echo, pwd, resize e DELETE encerram o processo e retornam 404 em input', async () => {
    const { createWebServer } = await import('./web-server.mjs');
    const server = createWebServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const ctl = new AbortController();
    let sessionId = '';
    try {
      // 1. Cria sessão PTY real
      const createRes = await fetch(`${baseUrl}/api/terminal/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      });
      assert.equal(createRes.status, 200);
      const created = await createRes.json();
      assert.equal(created.alive, true);
      assert.equal(typeof created.id, 'string');
      assert.ok(created.id.length > 0);
      assert.equal(typeof created.cwd, 'string');
      sessionId = created.id;

      // 2. Conecta SSE
      const streamRes = await fetch(`${baseUrl}/api/terminal/stream?id=${encodeURIComponent(sessionId)}`, {
        signal: ctl.signal,
      });
      assert.equal(streamRes.status, 200);
      assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/);
      const reader = streamRes.body.getReader();

      // 3. Envia echo FALADOR_PTY_OK_123\r e verifica saída real do PTY
      const echoInput = await fetch(`${baseUrl}/api/terminal/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, data: 'echo FALADOR_PTY_OK_123\r' }),
      });
      assert.equal(echoInput.status, 200);

      const echoOut = await waitForOutput(reader, (txt) => txt.includes('FALADOR_PTY_OK_123'));
      assert.ok(echoOut.includes('FALADOR_PTY_OK_123'), `Esperado FALADOR_PTY_OK_123 na saída PTY, veio: ${JSON.stringify(echoOut)}`);

      // 4. Envia pwd\r e verifica cwd real na saída
      const pwdInput = await fetch(`${baseUrl}/api/terminal/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, data: 'pwd\r' }),
      });
      assert.equal(pwdInput.status, 200);

      const pwdOut = await waitForOutput(reader, (txt) => txt.includes(created.cwd));
      assert.ok(pwdOut.includes(created.cwd), `Esperado ${created.cwd} na saída PTY, veio: ${JSON.stringify(pwdOut)}`);

      // 5. Resize retorna 200
      const resizeRes = await fetch(`${baseUrl}/api/terminal/resize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, cols: 120, rows: 40 }),
      });
      assert.equal(resizeRes.status, 200);
      assert.deepEqual(await resizeRes.json(), { ok: true });

      // 6. DELETE encerra a sessão e input subsequente retorna 404
      const delRes = await fetch(`${baseUrl}/api/terminal/session?id=${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      assert.equal(delRes.status, 200);
      assert.deepEqual(await delRes.json(), { ok: true });

      const afterDelInput = await fetch(`${baseUrl}/api/terminal/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sessionId, data: 'echo nope\r' }),
      });
      assert.equal(afterDelInput.status, 404);
    } finally {
      ctl.abort();
      if (sessionId) {
        await fetch(`${baseUrl}/api/terminal/session?id=${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {});
      }
      await new Promise((resolve) => server.close(() => resolve()));
    }
  });
});
