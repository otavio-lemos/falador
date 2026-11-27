#!/usr/bin/env python
"""omni-sidecar.py — serviço RESIDENTE de LFM3-Omni-2B-MLX-8bit via mlx-vlm (porta 8092).

Expõe o mesmo contrato HTTP do sts-sidecar.py para uso direto nos nós `asr.lfm3` e `sink.captions`:
    GET  /health        → {"model": "...", "ready": true}
    POST /asr-translate → {"audioB64": <WAV PCM16 base64>, "instruction": "...", "sample_rate": 16000} → {"text": "..."}
    POST /tts           → {"text": "...", "language": "Portuguese", "voice": "male", "sample_rate": 24000} → audio/wav
"""
import argparse
import base64
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = None
PROCESSOR = None
MODEL_PATH = None
LOCK = threading.Lock()  # MLX não é thread-safe entre generates


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if self.path == "/health":
            return
        print(f"[omni-sidecar] {self.command} {self.path} - {fmt % args}", flush=True)

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"model": MODEL_PATH, "ready": MODEL is not None})
        else:
            self.send_response(404)
            self.end_headers()

    def _handle_asr_translate(self):
        from mlx_vlm import generate
        from mlx_vlm.prompt_utils import apply_chat_template

        t0 = time.monotonic()
        tmp_path = None
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            wav_b64 = req.get("audioB64", "")
            instruction = (req.get("instruction") or "").strip()
            if not wav_b64:
                raise ValueError("audioB64 obrigatorio (WAV PCM16)")
            if not instruction:
                raise ValueError("instruction obrigatoria")
            # Evita que LFM3-Omni repita a transcrição original antes da tradução
            prefix = "Transcribe the audio and translate it to "
            if instruction.startswith(prefix):
                lang = instruction[len(prefix):].split(".")[0].strip()
                instruction = f"Translate the spoken audio directly into {lang}. Output ONLY the translation, nothing else."

            wav_bytes = base64.b64decode(wav_b64)
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
                tf.write(wav_bytes)
                tmp_path = tf.name

            # LFM3-Omni MEDIDO 2026-11-27: instrução em role='system' => saída VAZIA.
            # A instrução tem que vir no MESMO message do áudio (role='user'); no system
            # o chat template põe <|audio|> e o modelo fecha com EOS sem gerar texto.
            messages = [
                {"role": "user", "content": instruction},
            ]
            with LOCK:
                prompt = apply_chat_template(PROCESSOR, MODEL.config, messages, num_audios=1)
                result = generate(MODEL, PROCESSOR, prompt, audio=[tmp_path], temperature=0)

            text_out = (getattr(result, "text", None) or "").strip()
            ms = int((time.monotonic() - t0) * 1000)
            print(f"[omni-sidecar] POST /asr-translate 200 ({ms}ms) chars={len(text_out)}", flush=True)
            self._send_json(200, {"text": text_out})
        except Exception as e:
            ms = int((time.monotonic() - t0) * 1000)
            print(f"[omni-sidecar] POST /asr-translate 500 ({ms}ms) error={e}", flush=True)
            self._send_json(500, {"error": str(e)})
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    def _handle_tts(self):
        from mlx_vlm.generate import generate_audio
        from mlx_vlm.prompt_utils import apply_chat_template

        t0 = time.monotonic()
        out_path = None
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            text = (req.get("text") or "").strip()
            if not text:
                self._send_json(400, {"error": "text obrigatorio"})
                return
            language = req.get("language", "Portuguese")
            voice = req.get("voice", "male")

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
                out_path = tf.name

            sys_prompt = f"Perform TTS in {language} using a {voice} voice."
            messages = [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": text},
            ]
            with LOCK:
                prompt = apply_chat_template(PROCESSOR, MODEL.config, messages)
                generate_audio(MODEL, PROCESSOR, prompt, output_audio_path=out_path)

            with open(out_path, "rb") as f:
                data = f.read()

            ms = int((time.monotonic() - t0) * 1000)
            print(f"[omni-sidecar] POST /tts 200 ({ms}ms) lang={language} voice={voice} bytes={len(data)}", flush=True)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            ms = int((time.monotonic() - t0) * 1000)
            print(f"[omni-sidecar] POST /tts 500 ({ms}ms) error={e}", flush=True)
            self._send_json(500, {"error": str(e)})
        finally:
            if out_path and os.path.exists(out_path):
                try:
                    os.unlink(out_path)
                except OSError:
                    pass

    def do_POST(self):
        if self.path == "/asr-translate":
            self._handle_asr_translate()
            return
        if self.path == "/tts":
            self._handle_tts()
            return
        self.send_response(404)
        self.end_headers()


def main():
    global MODEL, PROCESSOR, MODEL_PATH
    p = argparse.ArgumentParser()
    p.add_argument("--model", required=True, help="caminho do modelo LFM3-Omni-2B-MLX-8bit")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8092)
    args = p.parse_args()
    MODEL_PATH = args.model

    print(f"[omni-sidecar] carregando modelo {args.model} ...", flush=True)
    from mlx_vlm import load

    MODEL, PROCESSOR = load(args.model)
    print("[omni-sidecar] PRONTO", flush=True)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[omni-sidecar] http://{args.host}:{args.port} (/asr-translate, /tts)", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
