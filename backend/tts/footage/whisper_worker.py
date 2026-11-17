"""Local transcription worker: faster-whisper (large-v3-turbo, int8), word-level timestamps.

Started once by the API (src/footage/jobs.service.ts) and kept running, so the model loads only once.
Protocol, one JSON object per line:
  stdout, first line   {"ready": true}   (or {"ready": false, "error": "..."})
  stdin                {"id": "1", "audio": "/path/16k-mono.wav", "lang": "ar", "prompt": "..."}
                       (lang optional: auto-detect; prompt optional: a sample in the speaker's dialect, see src/footage/dialect.ts)
  (optional "model": another Whisper model for this request, e.g. "large-v3" for the dialect pass; loaded once, kept;
   when it cannot be loaded the default one answers and "model" in the reply says which did)
  stdout               {"id": "1", "ok": true, "lang": "ar", "model": "large-v3-turbo", "words": [{"t": "word", "s": 120, "e": 480, "p": 0.97}]}
                       (or {"id": "1", "ok": false, "error": "..."}); s and e are integer milliseconds
Model files come from HF_HOME (backend/.tts/hf).
"""
import json
import os
import sys
import wave

import numpy as np

MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
THREADS = os.cpu_count() or 4  # every core: CTranslate2 uses 4 by default


def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def load_wav(path):
    """The API writes 16 kHz mono 16-bit PCM. Decoding it here keeps faster-whisper's own decoder (PyAV, version-sensitive) out of the way."""
    with wave.open(path, "rb") as r:
        if r.getsampwidth() != 2 or r.getnchannels() != 1 or r.getframerate() != 16000:
            raise ValueError("expected a 16 kHz mono 16-bit WAV")
        return np.frombuffer(r.readframes(r.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


# Arabic speakers mix in English: without a hint Whisper writes "SpaceX" as "سبيس أكس". A short sample of mixed text,
# English terms in Latin letters and punctuated, steers it to write them in English and to punctuate (better caption breaks).
MIXED_HINT = {"ar": "صباح الخير. اليوم بنحكي عن SpaceX و Tesla و AI، وعن الـ portfolio والـ marketing."}


def transcribe(model, audio, lang, prompt=None):
    pcm = load_wav(audio)
    if not lang:  # detected first, so an Arabic video gets the mixed-language hint too
        try:
            lang = model.detect_language(pcm, vad_filter=True)[0]
        except Exception:
            lang = None
    segments, info = model.transcribe(pcm, language=lang or None, word_timestamps=True, vad_filter=True,
                                      initial_prompt=prompt or MIXED_HINT.get(lang or ""))
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
        models = {MODEL: WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=THREADS)}
    except Exception as e:  # missing package or model: the API reports it
        say({"ready": False, "error": str(e)})
        return
    failed = set()

    def pick(name):
        """The requested model (loaded on first use), else the default one"""
        if not name or name == MODEL or name in failed:
            return MODEL
        if name not in models:
            try:
                models[name] = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=THREADS)
            except Exception as e:
                failed.add(name)
                sys.stderr.write(f"whisper model {name} unavailable: {e}\n")
                return MODEL
        return name

    say({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            name = pick(req.get("model"))
            words, lang = transcribe(models[name], req["audio"], req.get("lang"), req.get("prompt"))
            say({"id": rid, "ok": True, "lang": lang, "model": name, "words": words})
        except Exception as e:
            say({"id": rid, "ok": False, "error": str(e) or e.__class__.__name__})


if __name__ == "__main__":
    main()
