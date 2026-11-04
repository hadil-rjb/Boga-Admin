"""Arabic voice-over worker: SILMA TTS v1 (Modern Standard Arabic) and the Habibi-TTS dialect models (MSA, Egyptian,
Moroccan, Algerian), both built on F5-TTS and run on this machine with PyTorch. Only Apache-2.0 checkpoints are used.

These models speak in the voice of a short reference clip (5 to 10 seconds) and its transcript: the built-in SILMA
sample, or a brand's own recording. Started by the API (src/ai/local-tts.service.ts) on the first Arabic request.
Protocol, one JSON object per line:
  stdout, first line   {"ready": true, "device": "mps"}            (or {"ready": false, "error": "..."})
  stdin                {"id": "1", "model": "habibi-EGY", "text": "...", "ref_audio": "/path.wav", "ref_text": "...",
                        "speed": 1.0, "out": "/tmp/x.wav"}             model: silma | habibi-MSA | habibi-EGY | habibi-MAR | habibi-ALG
  stdout               {"id": "1", "ok": true, "ms": 3110}          (or {"id": "1", "ok": false, "error": "..."})
Setup: backend/tts/setup.sh (see README.md).
"""
import json
import os
import re
import sys
import types
from collections import OrderedDict

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")  # a few F5 ops have no Apple GPU kernel yet

MODELS = os.environ.get("TTS_MODELS") or os.path.join(os.path.dirname(__file__), "..", ".tts", "models")
# Habibi dialects whose checkpoints are Apache-2.0 (the Unified, SAU and UAE ones are CC-BY-NC-SA and never loaded)
HABIBI = {"MSA": "model_200000", "EGY": "model_100000", "MAR": "model_100000", "ALG": "model_100000"}
KEEP = int(os.environ.get("TTS_F5_KEEP", "1"))  # models kept in memory at once (1.4 to 2.6 GB each)
# Diffusion steps per line: 16 is SILMA's default and twice as fast as Habibi's 32, with a small loss of detail
STEPS = int(os.environ.get("TTS_F5_STEPS", "16"))
# Half-precision weights on a GPU: half the memory (a model fits without swapping on 8 GB machines) and faster
HALF = os.environ.get("TTS_F5_HALF", "1") != "0"
BUILTIN = "builtin:silma"
# Transcript of SILMA's sample clip (silma_tts/api.py)
SILMA_REF_TEXT = "ويدقق النظر في القرآن الكريم وسائر الكتب السماوية ويتبع مسالك الرسل العظام عليهم الصلاة والسلام."


# The protocol owns stdout: the libraries' own prints (progress, model paths) go to stderr instead
OUT, sys.stdout = sys.stdout, sys.stderr


def say(obj):
    OUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    OUT.flush()


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def stub_nemo():
    """silma_tts imports NVIDIA's text normalizer at load time; it needs pynini, which has no macOS build.
    Numbers are spelled out with num2words below instead, so a stand-in module is enough."""
    if "nemo_text_processing" in sys.modules:
        return
    try:
        import nemo_text_processing  # noqa: F401  (installed: use it)
        return
    except Exception:
        pass
    pkg = types.ModuleType("nemo_text_processing")
    tn = types.ModuleType("nemo_text_processing.text_normalization")
    norm = types.ModuleType("nemo_text_processing.text_normalization.normalize")

    class Normalizer:  # never called: normalize_numbers=False
        def __init__(self, *a, **k):
            pass

        def normalize(self, text, **k):
            return text

    norm.Normalizer = Normalizer
    sys.modules.update({"nemo_text_processing": pkg, "nemo_text_processing.text_normalization": tn, "nemo_text_processing.text_normalization.normalize": norm})


def spell_numbers(text):
    """12 → اثنا عشر, 3.5 → ثلاثة فاصلة خمسة (Arabic text), digits elsewhere in English words"""
    try:
        from num2words import num2words
    except Exception:
        return text
    arabic = bool(re.search(r"[؀-ۿ]", text))
    text = text.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789"))

    def one(m):
        s = m.group(0).replace(",", "")
        try:
            return num2words(float(s) if "." in s else int(s), lang="ar" if arabic else "en")
        except Exception:
            return m.group(0)

    return re.sub(r"\d+(?:[.,]\d+)?", one, text)


def main():
    try:
        stub_nemo()
        import soundfile as sf
        import torch
        from importlib.resources import files
        from omegaconf import OmegaConf
        from hydra.utils import get_class
        device = os.environ.get("TTS_F5_DEVICE") or ("cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu")
    except Exception as e:
        say({"ready": False, "error": str(e)})
        return

    loaded = OrderedDict()  # model name → (kind, model, vocoder)
    vocoders = {}

    def vocoder(kind):
        if kind not in vocoders:
            from f5_tts.infer.utils_infer import load_vocoder
            vocoders[kind] = load_vocoder(vocoder_name="vocos", device=device)
        return vocoders[kind]

    def load(name):
        if name in loaded:
            loaded.move_to_end(name)
            return loaded[name]
        while len(loaded) >= KEEP:  # free the least recently used model
            loaded.popitem(last=False)
            if device == "mps":
                torch.mps.empty_cache()
        if name == "silma":
            from silma_tts.infer import utils_infer as su
            cfg = OmegaConf.load(str(files("silma_tts").joinpath("config.yaml")))
            ckpt, vocab = os.path.join(MODELS, "silma", "model.pt"), os.path.join(MODELS, "silma", "vocab.txt")
            model = su.load_model(get_class(f"silma_tts.model.{cfg.model.backbone}"), cfg.model.arch, ckpt, cfg.model.mel_spec.mel_spec_type, vocab, "euler", False, device)
            su.load_tashkeel_model()  # adds the short vowels SILMA reads best with
            entry = ("silma", model, su.load_vocoder("vocos", False, "", device))
        elif name.startswith("habibi-") and name[7:] in HABIBI:
            from f5_tts.infer.utils_infer import load_model
            d = name[7:]
            cfg = OmegaConf.load(str(files("f5_tts").joinpath("configs/F5TTS_v1_Base.yaml")))
            ckpt = os.path.join(MODELS, "habibi", d, HABIBI[d] + ".safetensors")
            model = load_model(get_class(f"f5_tts.model.{cfg.model.backbone}"), cfg.model.arch, ckpt, mel_spec_type="vocos", vocab_file=os.path.join(MODELS, "habibi", d, "vocab.txt"), device=device)
            entry = ("habibi", model, vocoder("vocos"))
        else:
            raise ValueError("unknown model " + name)
        if HALF and device != "cpu":
            entry[1].half()
        loaded[name] = entry
        log(f"loaded {name} on {device}")
        return entry

    def speak(req):
        kind, model, voc = load(str(req["model"]))
        text = spell_numbers(str(req["text"]).strip())
        speed = min(1.5, max(0.6, float(req.get("speed") or 1.0)))
        ref_audio, ref_text = str(req["ref_audio"]), str(req.get("ref_text") or "")
        if ref_audio == BUILTIN:  # the sample voice that ships with SILMA TTS (MIT / Apache-2.0)
            ref_audio, ref_text = str(files("silma_tts").joinpath("infer/ref_audio_samples/ar.ref.24k.wav")), SILMA_REF_TEXT
        if not ref_text:
            raise ValueError("the reference clip needs its transcript")
        if kind == "silma":
            from silma_tts.infer import utils_infer as su
            ref_audio, ref_text = su.preprocess_ref_audio_text(ref_audio, ref_text, show_info=log)
            wav, sr, _ = su.infer_process(ref_audio, ref_text, text, model, voc, "vocos", show_info=log, progress=None, speed=speed, device=device, force_tashkeel=True, nfe_step=STEPS)
        else:
            from f5_tts.infer.utils_infer import preprocess_ref_audio_text
            from habibi_tts.infer.utils_infer import infer_process
            ref_audio, ref_text = preprocess_ref_audio_text(ref_audio, ref_text, show_info=log)
            # specialized checkpoints take the text as it is (the dialect tag is for the Unified model only)
            wav, sr, _ = infer_process(ref_audio, ref_text, text, model, voc, mel_spec_type="vocos", show_info=log, progress=None, speed=speed, device=device, dialect_id=None, nfe_step=STEPS)
        sf.write(str(req["out"]), wav, sr, subtype="PCM_16")
        return int(round(len(wav) * 1000 / sr))

    say({"ready": True, "device": device})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            say({"id": rid, "ok": True, "ms": speak(req)})
        except Exception as e:
            log("error", repr(e))
            say({"id": rid, "ok": False, "error": str(e)[:400]})


if __name__ == "__main__":
    main()
