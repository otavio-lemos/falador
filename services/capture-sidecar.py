#!/usr/bin/env python3
# capture-sidecar — sounddevice (PortAudio) → stdout PCM s16le mono contínuo.
# POR QUE: ffmpeg 9.0.2 avfoundation captura só ~25% dos samples nesta máquina
# (medido 2026-11-19 em BlackHole E mic, AGENTS.md §4); PortAudio captura 100%.
# Mesmo contrato de stdout do capture.ffmpeg: bytes crus, chunks de --chunk-ms.
# stdout = SÓ PCM; logs vão para stderr.
import argparse
import sys

import numpy as np
import sounddevice as sd

ap = argparse.ArgumentParser()
ap.add_argument('--device', default='BlackHole', help='nome (substring) ou índice PortAudio de device de ENTRADA')
ap.add_argument('--rate', type=int, default=16000, help='sample rate de SAÍDA (resample do clock nativo)')
ap.add_argument('--chunk-ms', type=int, default=80)
a = ap.parse_args()

devs = sd.query_devices()
if a.device.isdigit():
    inputs = [i for i, d in enumerate(devs) if d['max_input_channels'] > 0]
    dev = inputs[int(a.device)]
else:
    dev = next(i for i, d in enumerate(devs)
               if d['max_input_channels'] > 0 and a.device.lower() in d['name'].lower())
native = int(sd.query_devices(dev)['default_samplerate'])
in_n = round(native * a.chunk_ms / 1000)
out_n = round(a.rate * a.chunk_ms / 1000)

# ponytail: resample linear por bloco (fase zera a cada bloco, erro ≤ 1 sample na
# borda — irrelevante p/ ASR); upgrade = phase carry contínuo se medir artefato.
x_in = np.arange(in_n)
x_out = np.linspace(0, in_n - 1, out_n)

def callback(indata, frames, time_info, status):
    if status:
        print(f'[capture-sidecar] {status}', file=sys.stderr, flush=True)
    mono = indata[:, 0].astype(np.float64)
    pcm = np.interp(x_out, x_in, mono).astype(np.int16)
    sys.stdout.buffer.write(pcm.tobytes())
    sys.stdout.buffer.flush()

print(f'[capture-sidecar] PRONTO dev={dev} ({sd.query_devices(dev)["name"]}) '
      f'nativo={native} saida={a.rate} chunk={a.chunk_ms}ms', file=sys.stderr, flush=True)
with sd.InputStream(samplerate=native, channels=1, dtype='int16', device=dev,
                    blocksize=in_n, callback=callback):
    try:
        while True:
            sd.sleep(1000)
    except KeyboardInterrupt:
        pass