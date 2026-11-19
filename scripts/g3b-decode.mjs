// g3b-decode.mjs — G3b: decode incremental vs decode completo (mesmo áudio, mesmo modelo)
// Baseline : POST /v1/audio/transcriptions (decode completo, offline)
// Produção : WS   /v1/realtime (streaming, frames 100 ms, server_vad)
// Métricas : texto, WER-Levenshtein contra a referência, 1º delta, completed
// Rodar: node scripts/g3b-decode.mjs   (requer server :8090 vivo e warm)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const VOXTRAL = '/Users/otaviolemos/.cache/huggingface/hub/models--mlx-community--Voxtral-Mini-4B-Realtime-2602-4bit/snapshots/fdebf7b2af834a1db4b8a3c99ab7480b333adf9e';
const REF = {
  en: 'Effective caching in inference engines depends on prefill length, KV layout, and the residency of the model in unified memory.',
  pt: 'Caching eficaz em engines de inferência depende do tamanho do prefill, do layout de KV e da residência do modelo na memória unificada.',
};
const FRAME = 3200; // 100 ms @16k s16le
const PACE_MS = 100;
const SILENCE_FRAMES = 60; // 6 s de silêncio final p/ fechar o turno

const to16kPcm = (wavPath) => {
  const r = spawnSync('/opt/homebrew/bin/ffmpeg', [
    '-i', wavPath, '-f', 's16le', '-ac', '1', '-ar', '16000', '-loglevel', 'error', 'pipe:1',
  ], { encoding: 'buffer' });
  if (r.status !== 0) throw new Error('ffmpeg resample: ' + r.stderr);
  return r.stdout;
};

function wer(ref, hyp) {
  const norm = (s) => s.toLowerCase().replace(/[^a-zà-ú0-9\s]/gi, '').split(/\s+/).filter(Boolean);
  const a = norm(ref), b = norm(hyp);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] / Math.max(1, a.length);
}

async function offline(wavPath) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(wavPath)], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', VOXTRAL);
  const t0 = performance.now();
  const res = await fetch('http://127.0.0.1:8090/v1/audio/transcriptions', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`offline HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { text: String(j.text ?? ''), ms: Math.round(performance.now() - t0) };
}

async function streaming(wavPath) {
  const pcm = to16kPcm(wavPath);
  const ws = new WebSocket(`ws://127.0.0.1:8090/v1/realtime?model=${encodeURIComponent(VOXTRAL)}`);
  let firstDelta = null, done = null, text = '';
  await new Promise((ok, err) => { ws.onopen = ok; ws.onerror = err; });
  ws.send(JSON.stringify({ type: 'session.update', session: { audio: { input: { format: { type: 'audio/pcm', rate: 16000 }, turn_detection: { type: 'server_vad' } } } } }));
  const t0 = performance.now();
  let i = 0, queued = 0;
  const pump = () => {
    while (queued < 8 && i < pcm.length) { // lookahead de 8 frames (produção: mic em tempo real)
      const chunk = pcm.subarray(i, Math.min(pcm.length, i + FRAME));
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk).toString('base64') }));
      i += FRAME; queued++;
      setTimeout(() => { queued--; pump(); }, PACE_MS);
    }
    if (i >= pcm.length && !pump.silence) {
      pump.silence = true;
      const sil = Buffer.alloc(FRAME);
      for (let k = 0; k < SILENCE_FRAMES; k++) {
        setTimeout(() => { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: sil.toString('base64') })); }, k * PACE_MS);
      }
    }
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    if (m.type === 'conversation.item.input_audio_transcription.delta') {
      text += m.delta ?? '';
      if (firstDelta === null) firstDelta = Math.round(performance.now() - t0);
    }
    if (m.type === 'conversation.item.input_audio_transcription.completed') {
      text = String(m.transcript ?? text);
      done = Math.round(performance.now() - t0);
    }
  };
  const tEnd = performance.now() + 40_000;
  pump();
  while (done === null && performance.now() < tEnd) await new Promise((r) => setTimeout(r, 200));
  ws.close();
  if (done === null) throw new Error('streaming: completed não chegou em 40 s');
  return { text, firstDelta, completed: done };
}

async function main() {
  const results = {};
  for (const lang of ['en', 'pt']) {
    const wav = `/tmp/g3b-${lang}.wav`;
    console.log(`\n== ${lang.toUpperCase()} ==`);
    const off = await offline(wav);
    const st = await streaming(wav);
    results[lang] = {
      offline: { texto: off.text, wer: +wer(REF[lang], off.text).toFixed(4), ms: off.ms },
      streaming: { texto: st.text, wer: +wer(REF[lang], st.text).toFixed(4), primeiro_delta_ms: st.firstDelta, completed_ms: st.completed },
    };
    console.log(JSON.stringify(results[lang], null, 2));
  }
  console.log('\nG3B_RESULT_JSON ' + JSON.stringify(results));
}
main().catch((e) => { console.error(e); process.exit(1); });
