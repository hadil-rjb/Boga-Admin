# Local voice-overs

The video editor's **Generate voice** runs entirely on this server. No account, no API key, no subscription, no cost
per voice-over, and it works offline once installed. Only commercially licensed models are used.

| Language | Engine | Voices | Weights license |
| --- | --- | --- | --- |
| English (US, UK), French, Spanish, Italian, Portuguese | [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) via [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) | 38 voices (Heart, Adam, Emma, George, Siwis…) | Apache-2.0 |
| Arabic, Modern Standard | [SILMA TTS v1](https://huggingface.co/silma-ai/silma-tts) | the Silma voice, or the brand's own samples | Apache-2.0 (code MIT) |
| Arabic, Modern Standard | [Habibi-TTS](https://huggingface.co/SWivid/Habibi-TTS) `Specialized/MSA` | same | Apache-2.0 |
| Arabic, Egyptian | Habibi-TTS `Specialized/EGY` | same | Apache-2.0 |
| Arabic, Moroccan | Habibi-TTS `Specialized/MAR` | same | Apache-2.0 |
| Arabic, Algerian | Habibi-TTS `Specialized/ALG` | same | Apache-2.0 |

### What is deliberately not used

- **Habibi-TTS Unified, SAU and UAE** checkpoints are licensed CC-BY-NC-SA-4.0 (non-commercial: SADA and Mixat data).
  The setup never downloads them and the worker refuses them.
- **Habibi's sample voices** (`habibi_tts/assets`): the MP3s come from the ElevenLabs voice library and the WAVs from the
  Habibi benchmark (non-commercial data), so they are not offered as voices.
- **Piper `ar_JO-kareem`** (the earlier Arabic voice): its training data has no license and it was fine-tuned from
  `lessac`, whose data is licensed for research only. The setup removes it.

### Licensing notes to keep in mind

- The Habibi repository's metadata tag says `cc-by-nc-sa-4.0` (it covers the whole repository). Its model card and the
  maintainer state that the specialized ALG, EGY, IRQ, MAR and MSA checkpoints are Apache-2.0 (model card README and
  [discussion #1](https://huggingface.co/SWivid/Habibi-TTS/discussions/1)). The same discussion asks about the source of
  the in-house Algerian data, and the maintainer only answered that the ALG model permits commercial use.
- SILMA TTS v1 was pretrained from scratch on the F5-TTS architecture (its model card); it does not reuse the
  non-commercial F5-TTS base weights.
- A voice sample must come from someone who agreed to it: the editor asks for that before saving one.

Check these pages again before a large commercial launch: licenses can change.

## Setup (once per machine)

Needs Python 3.10 or newer (3.12 recommended). Kokoro takes ~350 MB; the Arabic models ~8 GB with PyTorch.

```bash
cd backend
./tts/setup.sh                    # everything
ARABIC=0 ./tts/setup.sh           # Kokoro only
HABIBI="MSA EGY" ./tts/setup.sh   # SILMA and only some Habibi dialects
```

It creates two Python environments (`.tts/venv` for Kokoro, `.tts/f5venv` with PyTorch for SILMA and Habibi), downloads
the models into `.tts/models`, and fetches the vocoder (Vocos, MIT) and the Arabic diacritizer (CATT, Apache-2.0) once.
Running it again only fetches what's missing. Restart the API afterwards.

Other locations: `TTS_PYTHON`, `TTS_F5_PYTHON` (the two venvs' `python`) and `TTS_MODELS` (the models folder).
`TTS_F5_DEVICE=cpu` forces the CPU; `TTS_F5_KEEP` sets how many Arabic models stay loaded (default 1; each takes 1.4 to 2.6 GB of memory, so raise it only with 16 GB or more).

## How it runs

`src/ai/local-tts.service.ts` drives two workers, each started on its first request and stopped when idle:

- `tts/voice_worker.py` (ONNX): Kokoro, and any Piper voice placed in `.tts/models/piper/` (check its license first).
- `tts/f5_worker.py` (PyTorch, Apple GPU when there is one): SILMA and Habibi. A model loads in 10 to 30 s the first time,
  then a line takes a few seconds. Numbers are spelled out in words before speaking.

The Arabic models speak in the voice of a 5 to 8 second reference clip. The editor offers SILMA's sample voice, and
**Audio → ⋯ → Add a voice sample** stores a brand's own clip (recorded or uploaded, with its transcript) on the brand.
Without the setup, the Audio tab says so, and a voice can still be uploaded or recorded. Music is composed in the browser.
