"""Local voice-over worker: Kokoro (English, French…) and Piper (Arabic), both open source and run on this machine.

Started once by the API (src/ai/local-tts.service.ts) and kept running, so each model loads only once.
Protocol, one JSON object per line:
  stdout, first line   {"ready": true, "kokoro": ["af_heart", ...], "piper": [{"id": "ar_JO-kareem-medium", "lang": "ar"}]}
                       (or {"ready": false, "error": "..."})
  stdin                {"id": "1", "engine": "kokoro", "text": "...", "voice": "af_heart", "speed": 1.0, "lang": "en-us", "out": "/tmp/x.wav"}
                       {"id": "2", "engine": "piper", "text": "...", "voice": "ar_JO-kareem-medium", "speed": 1.0, "out": "/tmp/y.wav"}
  stdout               {"id": "1", "ok": true, "ms": 3110}          (or {"id": "1", "ok": false, "error": "..."})
Setup: backend/tts/setup.sh (see README.md).
"""
import glob
import json
import os
import sys
import wave


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def load_kokoro(models):
    onnx, bin_ = os.path.join(models, "kokoro-v1.0.onnx"), os.path.join(models, "voices-v1.0.bin")
    if not (os.path.exists(onnx) and os.path.exists(bin_)):
        return None, []
    from kokoro_onnx import Kokoro
    k = Kokoro(onnx, bin_)
    return k, sorted(k.get_voices())


def piper_files(models):
    """Piper voices are <name>.onnx with <name>.onnx.json next to it, loaded on first use"""
    out = {}
    for path in sorted(glob.glob(os.path.join(models, "piper", "*.onnx"))):
        if not os.path.exists(path + ".json"):
            continue
        name = os.path.basename(path)[:-5]
        try:
            with open(path + ".json", encoding="utf-8") as f:
                lang = (json.load(f).get("language") or {}).get("family") or name.split("_")[0]
        except Exception:
            lang = name.split("_")[0]
        out[name] = {"path": path, "lang": lang}
    return out


def piper_say(voice, text, speed, out):
    from piper import SynthesisConfig
    with wave.open(out, "wb") as w:
        # length_scale > 1 is slower speech: speed 1.25 → 0.8
        voice.synthesize_wav(text, w, syn_config=SynthesisConfig(length_scale=1.0 / speed))
    with wave.open(out, "rb") as r:
        return int(round(r.getnframes() * 1000 / r.getframerate()))


def main():
    models = os.environ.get("TTS_MODELS") or os.path.join(os.path.dirname(__file__), "..", ".tts", "models")
    try:
        kokoro, kvoices = load_kokoro(models)
        pfiles = piper_files(models)
        if pfiles:
            from piper import PiperVoice  # fails here when the package is missing, not on the first request
        if not kokoro and not pfiles:
            raise RuntimeError("no voice model found in " + os.path.abspath(models))
        import soundfile as sf
    except Exception as e:  # missing package or model files: the API reports it
        say({"ready": False, "error": str(e)})
        return
    loaded = {}
    say({"ready": True, "kokoro": kvoices, "piper": [{"id": n, "lang": v["lang"]} for n, v in pfiles.items()]})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            speed = min(1.5, max(0.6, float(req.get("speed") or 1.0)))
            text, voice, out = str(req["text"]), str(req["voice"]), str(req["out"])
            if req.get("engine") == "piper":
                if voice not in pfiles:
                    raise ValueError("unknown Piper voice " + voice)
                if voice not in loaded:
                    loaded[voice] = PiperVoice.load(pfiles[voice]["path"])
                ms = piper_say(loaded[voice], text, speed, out)
            else:
                if not kokoro:
                    raise ValueError("Kokoro is not installed")
                samples, rate = kokoro.create(text, voice=voice, speed=speed, lang=str(req.get("lang") or "en-us"))
                sf.write(out, samples, rate, subtype="PCM_16")
                ms = int(round(len(samples) * 1000 / rate))
            say({"id": rid, "ok": True, "ms": ms})
        except Exception as e:
            say({"id": rid, "ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
