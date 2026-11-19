#!/usr/bin/env python
"""sts-sidecar.py — serviço RESIDENTE de TTS/STS para o Falador (regra L2).

Por que existe: o server HTTP do mlx-audio 0.6.6 (/v1/audio/speech) NÃO serve
modelos STS como o LFM3-Audio-2B (bug: repassa speed/gender/pitch que o
generate() do STS não aceita, e o endpoint é TTS-only). O modelo em si tem o
modo TTS via `model.generate(text=..., task="tts")` — este sidecar expõe só
isso por HTTP, mantendo o modelo carregado (carga fria 1,5–1,8 s não pode
ocorrer por frase).

Uso:
    .venv/bin/python services/sts-sidecar.py --model <caminho-do-snapshot> --port 8091

Endpoint:
    POST /tts  {"text": "...", "language": "English", "voice": "female", "sample_rate": 16000}
    → resposta: audio/wav bruto (streaming não — generate() do STS não é streaming;
       RTF medido 3,6×/4,9× realtime, suficiente p/ frases do Cenário 1).
    GET  /health → {"model": "..."}
"""
import argparse
import io
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading

import numpy as np

MODEL = None
MODEL_PATH = None
LOCK = threading.Lock()  # MLX não é thread-safe entre generates


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silencia o ruído padrão do servidor
        pass

    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"model": MODEL_PATH, "ready": MODEL is not None}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_asr_translate(self):
        """Transcrição+tradução por utterance (NÃO streaming) via task='chat' + áudio tipado.

        VERIFICADO no código do mlx_audio (sts/models/lfm3_audio/model.py):
        messages aceita bloco {"type":"audio","audio": <array>} + {"type":"text", ...},
        e result.text traz a decodificação (modo TEXT para task='chat').
        Pedido: {"audioB64": <WAV PCM16 base64>, "instruction": "...", "sample_rate": 16000}
        Resposta: {"text": "..."}
        """
        import base64
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            wav_b64 = req.get("audioB64", "")
            instruction = (req.get("instruction") or "").strip()
            sample_rate = int(req.get("sample_rate", 16000))
            if not wav_b64:
                raise ValueError("audioB64 obrigatorio (WAV PCM16)")
            if not instruction:
                raise ValueError("instruction obrigatoria")
            wav = base64.b64decode(wav_b64)
            with wave.open(io.BytesIO(wav), "rb") as r:
                if r.getnchannels() != 1 or r.getsampwidth() != 2:
                    raise ValueError("esperado WAV mono PCM16")
                sr = r.getframerate()
                pcm = np.frombuffer(r.readframes(r.getnframes()), dtype=np.int16)
            if sample_rate != sr:
                raise ValueError(f"sample_rate do body ({sample_rate}) != do WAV ({sr})")
            audio = (pcm.astype(np.float32) / 32768.0).squeeze()

            with LOCK:
                result = MODEL.generate(
                    messages=[
                        {"role": "user", "content": [
                            {"type": "audio", "audio": audio},
                            {"type": "text", "text": instruction},
                        ]},
                    ],
                    task="chat",
                    sample_rate=sample_rate,
                    temperature=0.0,
                    top_k=1,
                )
            self._send_json(200, {"text": (result.text or "").strip()})
        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def do_POST(self):
        if self.path == "/asr-translate":
            self._handle_asr_translate()
            return
        if self.path != "/tts":
            self.send_response(404)
            self.end_headers()
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            text = req.get("text", "").strip()
            if not text:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                body = b'{"error": "text obrigatorio"}'
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            language = req.get("language", "English")
            voice = req.get("voice", "female")
            sample_rate = int(req.get("sample_rate", 16000))

            with LOCK:
                result = MODEL.generate(
                    text=text,
                    task="tts",
                    language=language,
                    voice=voice,
                    sample_rate=sample_rate,
                )
            audio = np.asarray(result.audio).squeeze()
            sr = int(result.sample_rate)
            if audio.dtype != np.int16:
                pcm16 = np.clip(audio, -1.0, 1.0)
                pcm16 = (pcm16 * 32767.0).astype(np.int16)
            else:
                pcm16 = audio

            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sr)
                w.writeframes(pcm16.tobytes())
            data = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # delivery-friendly: erro em json
            body = json.dumps({"error": str(e)}).encode()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)


def main():
    global MODEL, MODEL_PATH
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True, help="caminho do snapshot (ou repo HF)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8091)
    args = p.parse_args()
    MODEL_PATH = args.model

    print(f"[sts-sidecar] carregando modelo {args.model} ...", flush=True)
    from mlx_audio.sts.models.lfm3_audio.model import Model as Lfm3Model

    MODEL = Lfm3Model.from_pretrained(args.model)
    print("[sts-sidecar] PRONTO", flush=True)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[sts-sidecar] http://{args.host}:{args.port}/tts", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
