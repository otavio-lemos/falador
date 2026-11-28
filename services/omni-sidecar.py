#!/usr/bin/env python
"""omni-sidecar.py — serviço RESIDENTE de LFM3-Omni-2B-MLX-8bit via mlx-vlm (porta 8092).

Expõe o mesmo contrato HTTP do sts-sidecar.py para uso direto nos nós `asr.lfm3` e `sink.captions`:
    GET  /health        → {"model": "...", "ready": true}
    POST /asr-translate → {"audioB64": <WAV PCM16 base64>, "instruction": "...", "sample_rate": 16000} → {"text": "..."}
    POST /tts           → {"text": "...", "language": "Portuguese", "voice": "male", "sample_rate": 24000} → audio/wav
    POST /tts-stream    → mesmo corpo do /tts, mas responde PCM s16le mono 24 kHz cru
                          escrito POR FRAME enquanto o modelo fala (stream_slots +
                          codec.decode a cada 4 frames). Medido: 1º chunk em 112 ms e
                          frase de 7,04 s em 1,23 s (o /tts só respondia ao fim).
"""
import argparse
import base64
import io
import json
import os
import re
import tempfile
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

MODEL = None
PROCESSOR = None
MODEL_PATH = None
LOCK = threading.Lock()  # MLX não é thread-safe entre generates
FRAMES_PER_CHUNK = 4  # 4 frames de 80 ms = 320 ms de áudio por decode
SILENCE_RMS_FLOOR = 1.5e-4
SILENCE_PEAK_FLOOR = 2.0e-3
TOOL_CALL_RE = re.compile(r"<tool_call>.*?</tool_call>", re.DOTALL)


def _normalize_tts_language(language: str) -> str:
    """Cartão oficial LFM3-Omni-2B: para inglês em TTS, usar American/British English."""
    s = (language or "Portuguese").strip()
    if s.lower() == "english":
        return "American English"
    return s


def _instruction_to_system_prompt(instruction: str) -> str:
    """Converte a instrução do nó para o system prompt oficial do cartão LFM3-Omni-2B."""
    s = instruction.strip()
    low = s.lower()
    if low.startswith("perform asr") or "verbatim in its original language" in low:
        return "Perform ASR. Respond in text."
    for prefix in (
        "Transcribe the audio and translate it to ",
        "Translate the spoken audio directly into ",
        "Translate the following speech into ",
    ):
        if s.startswith(prefix):
            rest = s[len(prefix):]
            lang = rest.split(" in text form")[0].split(".")[0].strip()
            if lang:
                return f"Translate the following speech into {lang} in text form. Respond in text."
    if "respond in text" not in low:
        return f"{s.rstrip('.')}." + " Respond in text."
    return s


def _is_silent_wav(wav_bytes: bytes) -> bool:
    """Evita alucinações ('Nada.', 'Thank you.', <tool_call>) em janelas mudas do SCK."""
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as r:
            if r.getsampwidth() != 2 or r.getnframes() == 0:
                return r.getnframes() == 0
            pcm = np.frombuffer(r.readframes(r.getnframes()), dtype=np.int16)
        if pcm.size == 0:
            return True
        f = pcm.astype(np.float32) / 32768.0
        rms = float(np.sqrt(np.mean(f * f)))
        peak = float(np.max(np.abs(f)))
        return rms < SILENCE_RMS_FLOOR and peak < SILENCE_PEAK_FLOOR
    except Exception:
        return False


def _to_pcm16(wav):
    x = np.clip(np.asarray(wav, dtype=np.float32).squeeze(), -1.0, 1.0)
    return (x * 32767.0).astype(np.int16).tobytes()


def _pcm16_chunks(text, language, voice):
    """PCM s16le 24 kHz à medida que o modelo fala (stream_slots por frame)."""
    import mlx.core as mx
    from mlx_vlm.prompt_utils import apply_chat_template
    from mlx_vlm.utils import prepare_inputs

    tts_lang = _normalize_tts_language(language)
    messages = [
        {"role": "system", "content": f"Perform TTS in {tts_lang} using a {voice} voice."},
        {"role": "user", "content": text},
    ]
    prompt = apply_chat_template(PROCESSOR, MODEL.config, messages)
    inputs = prepare_inputs(
        PROCESSOR, images=None, audio=None, videos=None, prompts=prompt, add_special_tokens=True
    )
    input_ids = inputs.pop("input_ids")
    inputs.pop("attention_mask", None)
    codec = MODEL.codec()
    eos = MODEL.config.audio_eos_code
    batch = []
    for _token, codes in MODEL.stream_slots(
        input_ids, generation_mode="audio", **inputs, **MODEL.audio_sampling
    ):
        if codes is None:
            continue
        if int(codes[0].item()) == eos:
            break
        batch.append(codes)
        if len(batch) == FRAMES_PER_CHUNK:
            yield _to_pcm16(codec.decode(mx.stack(batch, axis=-1)))
            batch = []
    if batch:
        yield _to_pcm16(codec.decode(mx.stack(batch, axis=-1)))


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
        from mlx_vlm.prompt_utils import apply_chat_template
        from mlx_vlm.utils import prepare_inputs

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

            wav_bytes = base64.b64decode(wav_b64)
            if _is_silent_wav(wav_bytes):
                ms = int((time.monotonic() - t0) * 1000)
                print(f"[omni-sidecar] POST /asr-translate 200 ({ms}ms) silent=true chars=0", flush=True)
                self._send_json(200, {"text": ""})
                return

            sys_prompt = _instruction_to_system_prompt(instruction)
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
                tf.write(wav_bytes)
                tmp_path = tf.name

            # Contrato oficial LFM3-Omni-2B: instrução em role='system', áudio isolado em
            # role='user' e generation_mode='text' em stream_slots (suprime <|audio_start|> e
            # <|mixed_start|> — sem isso o mlx_vlm.generate abria modo áudio e devolvia '').
            messages = [
                {"role": "system", "content": sys_prompt},
                {"role": "user", "content": ""},
            ]
            with LOCK:
                prompt = apply_chat_template(PROCESSOR, MODEL.config, messages, num_audios=1)
                inputs = prepare_inputs(
                    PROCESSOR, images=None, audio=[tmp_path], videos=None, prompts=prompt, add_special_tokens=True
                )
                input_ids = inputs.pop("input_ids")
                inputs.pop("attention_mask", None)
                toks = []
                for tok, _codes in MODEL.stream_slots(
                    input_ids, max_tokens=512, generation_mode="text", temperature=0.0, **inputs
                ):
                    toks.append(tok)
                raw_text = PROCESSOR.tokenizer.decode(toks, skip_special_tokens=True)

            text_out = TOOL_CALL_RE.sub("", raw_text or "").strip()
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
            language = _normalize_tts_language(req.get("language", "Portuguese"))
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

    def _handle_tts_stream(self):
        t0 = time.monotonic()
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            text = (req.get("text") or "").strip()
            if not text:
                self._send_json(400, {"error": "text obrigatorio"})
                return
            language = req.get("language", "Portuguese")
            voice = req.get("voice", "male")
            sr = 24000  # o codec do LFM3-Omni sai sempre a 24 kHz

            # Segura o lock pela geração inteira (como o /tts): o cliente lê o corpo
            # sem esperar a reprodução, então o wall time é o da geração (~1,2 s).
            with LOCK:
                gen = _pcm16_chunks(text, language, voice)
                first = next(gen, None)  # erro aqui ainda vira 500
                if first is None:
                    self._send_json(500, {"error": "sem audio gerado"})
                    return
                first_ms = int((time.monotonic() - t0) * 1000)
                self.send_response(200)
                self.send_header("Content-Type", "audio/pcm")
                self.send_header("X-Sample-Rate", str(sr))
                self.send_header("X-Sample-Format", "s16le-mono")
                self.end_headers()
                sent = len(first)
                self.wfile.write(first)
                for chunk in gen:
                    self.wfile.write(chunk)
                    sent += len(chunk)
            ms = int((time.monotonic() - t0) * 1000)
            print(
                f"[omni-sidecar] POST /tts-stream 200 ({ms}ms, 1º chunk {first_ms}ms) "
                f"lang={language} voice={voice} bytes={sent}",
                flush=True,
            )
        except (BrokenPipeError, ConnectionResetError):
            print("[omni-sidecar] /tts-stream: cliente desconectou", flush=True)
        except Exception as e:
            ms = int((time.monotonic() - t0) * 1000)
            print(f"[omni-sidecar] POST /tts-stream 500 ({ms}ms) error={e}", flush=True)
            try:
                self._send_json(500, {"error": str(e)})
            except OSError:
                pass

    def do_POST(self):
        if self.path == "/asr-translate":
            self._handle_asr_translate()
            return
        if self.path == "/tts":
            self._handle_tts()
            return
        if self.path == "/tts-stream":
            self._handle_tts_stream()
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
