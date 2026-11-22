import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { captureFfmpeg, resolveSounddeviceInput } from '../src/capture-ffmpeg.ts';

test('capture.ffmpeg exporta node type', () => {
  assert.equal(captureFfmpeg.type, 'capture.ffmpeg');
});

test('sounddevice: input vazio usa Microfone; nome explícito é preservado', () => {
  assert.equal(resolveSounddeviceInput(''), 'Microfone');
  assert.equal(resolveSounddeviceInput('   '), 'Microfone');
  assert.equal(resolveSounddeviceInput('Microfone (MacBook Pro)'), 'Microfone (MacBook Pro)');
  assert.equal(resolveSounddeviceInput(':0'), '0');
});

test('capture-sidecar --list devolve JSON de devices de entrada', () => {
  const out = execFileSync(
    '/Users/otaviolemos/ml/falador/.venv/bin/python',
    ['/Users/otaviolemos/ml/falador/services/capture-sidecar.py', '--list'],
    { encoding: 'utf8', timeout: 10000 },
  );
  const devices = JSON.parse(out) as { id: number; name: string; sampleRate: number }[];
  assert.ok(Array.isArray(devices));
  for (const d of devices) {
    assert.equal(typeof d.id, 'number');
    assert.ok(d.name.trim().length > 0);
    assert.ok(d.sampleRate > 0);
  }
});
