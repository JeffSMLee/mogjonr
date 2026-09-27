"""Tiny local speech-to-text server for the trob bot.

Accepts raw 16-bit little-endian mono PCM at 48 kHz (POST body) and returns {"text": "..."}.
Keeps the Whisper model loaded so each utterance transcribes quickly.
"""
import glob
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# CTranslate2 loads CUDA 12 libraries (cublas64_12.dll, ...) lazily. On Windows they come from the
# nvidia-*-cu12 pip wheels, whose bin folders are not on the DLL search path by default.
if sys.platform == "win32":
    import site

    for sp in site.getsitepackages():
        for dll_dir in glob.glob(os.path.join(sp, "nvidia", "*", "bin")):
            os.add_dll_directory(dll_dir)
            os.environ["PATH"] = dll_dir + os.pathsep + os.environ["PATH"]

import numpy as np
from faster_whisper import WhisperModel
from scipy.signal import resample_poly

HOST = os.environ.get("STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("STT_PORT", "8765"))
MODEL = os.environ.get("WHISPER_MODEL", "base.en")  # try small.en if it misses "trob" too often
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")  # "cuda", "cpu" or "auto"


def load_model() -> WhisperModel:
    """Load the model and run one warm-up pass so missing CUDA libraries fail here, not mid-call."""
    if DEVICE != "cpu":
        try:
            m = WhisperModel(MODEL, device=DEVICE, compute_type="int8")
            list(m.transcribe(np.zeros(16000, dtype=np.float32), language="en")[0])
            return m
        except Exception as e:  # e.g. RuntimeError: Library cublas64_12.dll is not found
            print(f"GPU init failed ({e}); falling back to CPU", file=sys.stderr)
    return WhisperModel(MODEL, device="cpu", compute_type="int8")


model = load_model()
lock = threading.Lock()  # one transcription at a time on the shared model


def transcribe(raw: bytes) -> str:
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    audio = resample_poly(audio, 1, 3).astype(np.float32)  # 48 kHz -> 16 kHz
    with lock:
        segments, _ = model.transcribe(
            audio,
            language="en",
            beam_size=1,
            vad_filter=True,
            initial_prompt="Hey Trob. Trob is in the call.",  # biases spelling toward "Trob"
            hotwords="Trob",
        )
        return " ".join(s.text for s in segments).strip()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/transcribe":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            text = transcribe(raw[: len(raw) - len(raw) % 2]) if raw else ""
            status, body = 200, json.dumps({"text": text}).encode()
        except Exception as e:
            print(f"Transcription error: {e}", file=sys.stderr)
            status, body = 500, json.dumps({"error": str(e)}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"STT server on http://{HOST}:{PORT} using {MODEL} on {model.model.device}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
