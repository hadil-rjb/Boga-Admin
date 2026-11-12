"""Local transcription worker: faster-whisper (large-v3-turbo, int8), word-level timestamps.

Started once by the API (src/footage/jobs.service.ts) and kept running, so the model loads only once.
Protocol, one JSON object per line:
  stdout, first line   {"ready": true}   (or {"ready": false, "error": "..."})
  stdin                {"id": "1", "audio": "/path/16k-mono.wav", "lang": "ar"}      (lang optional: auto-detect)
  stdout               {"id": "1", "ok": true, "lang": "ar", "words": [{"t": "word", "s": 120, "e": 480, "p": 0.97}]}
                       (or {"id": "1", "ok": false, "error": "..."}); s and e are integer milliseconds
Model files come from HF_HOME (backend/.tts/hf).
"""
import json
import os
import sys
import wave

import numpy as np

MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")


def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_wav(path):
    """The API writes 16 kHz mono 16-bit PCM. Decoding it here keeps faster-whisper's own decoder (PyAV, version-sensitive) out of the way."""
    with wave.open(path, "rb") as r:
        if r.getsampwidth() != 2 or r.getnchannels() != 1 or r.getframerate() != 16000:
            raise ValueError("expected a 16 kHz mono 16-bit WAV")
        return np.frombuffer(r.readframes(r.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def transcribe(model, audio, lang):
    segments, info = model.transcribe(load_wav(audio), language=lang or None, word_timestamps=True, vad_filter=True)
    words, prev = [], 0
    for seg in segments:
        for w in seg.words or []:
            t = (w.word or "").strip()
            if not t:
                continue
            s = max(int(round(w.start * 1000)), prev)  # increasing: a word never starts before the previous one
            e = max(int(round(w.end * 1000)), s)
            words.append({"t": t, "s": s, "e": e, "p": round(float(w.probability), 3)})
            prev = s
    return words, info.language


def main():
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    except Exception as e:  # missing package or model: the API reports it
        say({"ready": False, "error": str(e)})
        return
    say({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            words, lang = transcribe(model, req["audio"], req.get("lang"))
            say({"id": rid, "ok": True, "lang": lang, "words": words})
        except Exception as e:
            say({"id": rid, "ok": False, "error": str(e) or e.__class__.__name__})


if __name__ == "__main__":
    main()
