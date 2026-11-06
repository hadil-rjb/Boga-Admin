#!/usr/bin/env bash
# Installs the local voice engines of the video editor (see README.md):
#   Kokoro (English, French…)                          ~350 MB
#   Arabic: SILMA TTS v1 + Habibi-TTS MSA / EGY / MAR / ALG   ~8 GB with PyTorch (ARABIC=0 skips it,
#   HABIBI="MSA EGY" installs only some dialects)
# Only commercially licensed models are downloaded (Apache-2.0). Everything runs on this machine: no account, no API key,
# no cost per voice-over. Safe to run again: only what's missing is fetched.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-}"
if [ -z "$PY" ]; then for c in python3.12 python3.11 python3.10 python3.13 python3; do
  if command -v "$c" >/dev/null && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then PY="$c"; break; fi
done; fi
[ -n "$PY" ] || { echo "Needs Python 3.10 or newer (set PYTHON=/path/to/python3)"; exit 1; }

get() { [ -s "$2" ] || { echo "Downloading $(basename "$2")…"; mkdir -p "$(dirname "$2")"; curl -fsSL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }; }

# ---------- Kokoro (Apache-2.0) ----------
[ -x .tts/venv/bin/python ] || "$PY" -m venv .tts/venv
.tts/venv/bin/pip install --quiet --upgrade pip
.tts/venv/bin/pip install --quiet "kokoro-onnx>=0.4" soundfile "piper-tts>=1.3"
K=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
get "$K/kokoro-v1.0.onnx" .tts/models/kokoro-v1.0.onnx   # 325 MB
get "$K/voices-v1.0.bin" .tts/models/voices-v1.0.bin     # 28 MB
# Piper's Arabic voice (ar_JO-kareem) is not installed: its training data has no license and it was fine-tuned from
# "lessac", whose data is licensed for research only. Remove it if an earlier version of this script added it.
rm -f .tts/models/piper/ar_JO-kareem-medium.onnx .tts/models/piper/ar_JO-kareem-medium.onnx.json

# ---------- Arabic: SILMA TTS v1 and Habibi-TTS (F5-TTS, PyTorch) ----------
if [ "${ARABIC:-1}" != "0" ]; then
  [ -x .tts/f5venv/bin/python ] || "$PY" -m venv .tts/f5venv
  F=.tts/f5venv/bin/pip
  $F install --quiet --upgrade pip
  $F install --quiet "torch>=2.4,<2.9" "torchaudio>=2.4,<2.9" "numpy>=2,<2.3" "f5-tts>=1.1.5,<1.2" "habibi-tts==0.1.1"
  # silma-tts pins NVIDIA's number normalizer, which needs pynini (no macOS build): the worker spells numbers itself
  $F install --quiet --no-deps "silma-tts==1.0.5"
  # the CATT diacritizer asks for onnxruntime-gpu (no macOS build): the standard onnxruntime has the same API
  $F install --quiet --no-deps "catt_tashkeel==1.0.2"
  $F install --quiet "onnxruntime>=1.22" num2words

  # SILMA TTS v1 · Apache-2.0 · https://huggingface.co/silma-ai/silma-tts
  S=https://huggingface.co/silma-ai/silma-tts/resolve/main
  for f in model.pt vocab.txt config.yaml; do get "$S/$f" ".tts/models/silma/$f"; done   # 2.6 GB

  # Habibi-TTS specialized checkpoints · Apache-2.0 for MSA, EGY, MAR, ALG (and IRQ) · https://huggingface.co/SWivid/Habibi-TTS
  # The Unified, SAU and UAE checkpoints are CC-BY-NC-SA-4.0 (non-commercial): never downloaded.
  H=https://huggingface.co/SWivid/Habibi-TTS/resolve/main/Specialized
  for d in ${HABIBI:-MSA EGY MAR ALG}; do
    case "$d" in MSA) ck=model_200000 ;; EGY|MAR|ALG|IRQ) ck=model_100000 ;; *) echo "Skipping $d: not a commercially licensed Habibi model"; continue ;; esac
    get "$H/$d/$ck.safetensors" ".tts/models/habibi/$d/$ck.safetensors"   # 1.35 GB each
    get "$H/$d/vocab.txt" ".tts/models/habibi/$d/vocab.txt"
  done

  # The vocoder (charactr/vocos-mel-24khz, MIT) and the diacritizer (CATT, Apache-2.0) download once, then work offline
  HF_HOME="$PWD/.tts/hf" .tts/f5venv/bin/python - <<'PY'
from f5_tts.infer.utils_infer import load_vocoder
load_vocoder(vocoder_name="vocos", device="cpu")
from catt_tashkeel import CATTEncoderOnly
CATTEncoderOnly()
PY
fi

echo "Local voices installed. Restart the API: the Audio tab lists them."
