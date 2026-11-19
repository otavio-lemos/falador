#!/usr/bin/env python3
# playback-sidecar — reprodução com DEVICE ALVO via sounddevice (PortAudio).
# Residente por run (spawnado pelo sink.playback backend sounddevice):
#   stdin  (1 linha JSON por fala): {"wavB64": "<WAV PCM16 b64>", "device": "BlackHole"}
#   stdout (1 linha JSON por fala): {"ok": true, "seconds": 2.9}  ou {"ok": false, "error": "..."}
# POR QUE: afplay só toca na saída default; p/ injetar o TTS no mic virtual da call
# (BlackHole 2ch) precisa mirar o device. PortAudio não faz SRC no macOS → resample
# linear pro clock nativo do device (medido: 24k em 48k = fala 2×, AGENTS §4).
# stdout = SÓ JSON; logs em stderr.
import base64
import io
import json
import sys
import time
import wave

import numpy as np
import sounddevice as sd


def resolve_device(spec):
    devs = sd.query_devices()
    if str(spec).isdigit():
        outs = [i for i, d in enumerate(devs) if d['max_output_channels'] > 0]
        return outs[int(spec)]
    return next(i for i, d in enumerate(devs)
                if d['max_output_channels'] > 0 and str(spec).lower() in d['name'].lower())


def play(req):
    w = wave.open(io.BytesIO(base64.b64decode(req['wavB64'])), 'rb')
    sr, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
    data = np.frombuffer(w.readframes(n), dtype=np.int16)
    if ch == 2:
        data = data.reshape(-1, 2).mean(axis=1).astype(np.int16)
    dev = resolve_device(req.get('device', 'BlackHole'))
    dev_sr = int(sd.query_devices(dev)['default_samplerate'])
    if sr != dev_sr:
        xi = np.linspace(0, len(data) - 1, int(len(data) * dev_sr / sr))
        data = np.interp(xi, np.arange(len(data)), data.astype(np.float64)).astype(np.int16)
        sr = dev_sr
    t0 = time.time()
    sd.play(data, sr, device=dev)
    sd.wait()
    return {'ok': True, 'seconds': round(time.time() - t0, 2),
            'device': sd.query_devices(dev)['name']}


print('[playback-sidecar] PRONTO (stdin JSON lines)', file=sys.stderr, flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        res = play(json.loads(line))
    except Exception as e:  # nunca derruba o residente por uma fala ruim
        res = {'ok': False, 'error': str(e)}
    sys.stdout.write(json.dumps(res) + '\n')
    sys.stdout.flush()