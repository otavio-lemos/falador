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

Endpoints:
    POST /tts  {"text": "...", "language": "English", "voice": "female", "sample_rate": 16000}
    → resposta: audio/wav bruto (generate() acumula a frase inteira; RTF 3,6×/4,9×).
    POST /tts-stream  (mesmo corpo)
    → resposta: PCM s16le mono 24 kHz cru, escrito POR FRAME enquanto o modelo fala
      (stream_slots + codec.decode a cada 4 frames = 320 ms). Medido: 1º chunk em
      262 ms e frase de 6,88 s em 1,46 s (o /tts só respondia ao fim dos 1,46 s).
      Headers: X-Sample-Rate, X-Sample-Format.
    GET  /health → {"model": "..."}
"""
import argparse
import io
import re
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import time

import numpy as np

MODEL = None
MODEL_PATH = None
LOCK = threading.Lock()  # MLX não é thread-safe entre generates
FRAMES_PER_CHUNK = 4  # 4 frames de 80 ms = 320 ms de áudio por decode
SILENCE_RMS_FLOOR = 1.5e-4
SILENCE_PEAK_FLOOR = 2.0e-3
TOOL_CALL_RE = re.compile(r"<tool_call>.*?</tool_call>", re.DOTALL)


def _normalize_tts_language(language: str) -> str:
    """Cartão oficial LFM3-Audio-2B: para inglês em TTS, usar American/British English."""
    s = (language or "English").strip()
    if s.lower() == "english":
        return "American English"
    return s


def _instruction_to_system_prompt(instruction: str) -> str:
    """Converte a instrução do nó para o system prompt oficial do cartão LFM3-Audio-2B."""
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


def _to_pcm16(wav):
    x = np.clip(np.asarray(wav, dtype=np.float32).squeeze(), -1.0, 1.0)
    return (x * 32767.0).astype(np.int16).tobytes()


def _pcm16_chunks(text, language, voice):
    """PCM s16le 24 kHz à medida que o modelo fala (stream_slots por frame).

    Os 12 codec tokens de cada frame viram 1920 amostras (80 ms); decodifica em
    lotes de 4 frames p/ amortizar o codec sem perder latência.
    """
    import mlx.core as mx

    tts_lang = _normalize_tts_language(language)
    messages = [
        {"role": "system", "content": f"Perform TTS in {tts_lang} using a {voice} voice."},
        {"role": "user", "content": [{"type": "text", "text": text}]},
    ]
    inputs = MODEL.processor.prepare(messages)
    codec = MODEL.codec()
    eos = MODEL.config.audio_eos_code
    batch = []
    for _token, codes in MODEL.stream_slots(**inputs, generation_mode="audio"):
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
    def log_message(self, fmt, *args):  # evita ruído do GET /health; erros inesperados ainda são logados
        if self.path == "/health":
            return
        print(f"[sts-sidecar] {self.command} {self.path} - {fmt % args}", flush=True)

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
        t0 = time.monotonic()
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
            dur_s = len(pcm) / max(1, sample_rate)
            rms = float(np.sqrt(np.mean(audio * audio))) if audio.size else 0.0
            peak = float(np.max(np.abs(audio))) if audio.size else 0.0
            if audio.size == 0 or (rms < SILENCE_RMS_FLOOR and peak < SILENCE_PEAK_FLOOR):
                ms = int((time.monotonic() - t0) * 1000)
                print(f"[sts-sidecar] POST /asr-translate 200 ({ms}ms) audio={dur_s:.1f}s silent=true chars=0", flush=True)
                self._send_json(200, {"text": ""})
                return

            # Contrato oficial LFM3-Audio-2B: instrução em role='system' e só o áudio em
            # role='user' (evita que o modelo traduza o texto da instrução em janelas curtas).
            sys_prompt = _instruction_to_system_prompt(instruction)
            with LOCK:
                result = MODEL.generate(
                    messages=[
                        {"role": "system", "content": sys_prompt},
                        {"role": "user", "content": [{"type": "audio", "audio": audio}]},
                    ],
                    task="chat",
                    sample_rate=sample_rate,
                    temperature=0.0,
                    top_k=1,
                )
            text_out = TOOL_CALL_RE.sub("", result.text or "").strip()
            ms = int((time.monotonic() - t0) * 1000)
            print(f"[sts-sidecar] POST /asr-translate 200 ({ms}ms) audio={dur_s:.1f}s chars={len(text_out)}", flush=True)
            self._send_json(200, {"text": text_out})
        except Exception as e:
            ms = int((time.monotonic() - t0) * 1000)
            print(f"[sts-sidecar] POST /asr-translate 500 ({ms}ms) error={e}", flush=True)
            self._send_json(500, {"error": str(e)})

    def _handle_tts_stream(self):
        t0 = time.monotonic()
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n) or b"{}")
            text = (req.get("text") or "").strip()
            if not text:
                self._send_json(400, {"error": "text obrigatorio"})
                return
            language = req.get("language", "English")
            voice = req.get("voice", "female")
            sr = 24000  # o codec do LFM3-Audio sai sempre a 24 kHz

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
                f"[sts-sidecar] POST /tts-stream 200 ({ms}ms, 1º chunk {first_ms}ms) "
                f"lang={language} voice={voice} bytes={sent}",
                flush=True,
            )
        except (BrokenPipeError, ConnectionResetError):
            print("[sts-sidecar] /tts-stream: cliente desconectou", flush=True)
        except Exception as e:  # delivery-friendly: erro em json
            ms = int((time.monotonic() - t0) * 1000)
            print(f"[sts-sidecar] POST /tts-stream 500 ({ms}ms) error={e}", flush=True)
            try:
                self._send_json(500, {"error": str(e)})
            except OSError:
                pass

    def do_POST(self):
        if self.path == "/asr-translate":
            self._handle_asr_translate()
            return
        if self.path == "/tts-stream":
            self._handle_tts_stream()
            return
        if self.path != "/tts":
            self.send_response(404)
            self.end_headers()
            return
        t0 = time.monotonic()
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
            language = _normalize_tts_language(req.get("language", "English"))
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
            ms = int((time.monotonic() - t0) * 1000)
            print(f"[sts-sidecar] POST /tts 200 ({ms}ms) lang={language} voice={voice} bytes={len(data)}", flush=True)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # delivery-friendly: erro em json
            ms = int((time.monotonic() - t0) * 1000)
            print(f"[sts-sidecar] POST /tts 500 ({ms}ms) error={e}", flush=True)
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
