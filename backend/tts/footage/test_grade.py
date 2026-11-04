import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
GRADE = os.path.join(HERE, "grade.py")
W, H = 256, 144


def run(*args):
    p = subprocess.run([sys.executable, GRADE, *args], capture_output=True, text=True)
    lines = [l for l in p.stdout.splitlines() if l.strip()]
    assert len(lines) == 1, p.stdout + p.stderr
    return p.returncode, json.loads(lines[0])


def save_frames(d, frames):
    os.makedirs(d, exist_ok=True)
    for i, f in enumerate(frames):
        img = np.clip(np.round(f * 255), 0, 255).astype(np.uint8)
        Image.fromarray(img, "RGB").save(os.path.join(d, f"f{i:03d}.png"))
    return str(d)


def scene(seed):
    """Smooth synthetic frame (0..1 RGB) with a skin-toned face blob in the middle."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:H, 0:W] / np.array([H, W])[:, None, None]
    base = np.stack([0.25 + 0.4 * x, 0.3 + 0.3 * y, 0.45 - 0.2 * x * y], -1)
    base += rng.uniform(-0.08, 0.08, 3)
    base += 0.03 * np.sin(np.stack([x * 9 + seed, y * 7, x * y * 11], -1))
    cx, cy = 0.5 + rng.uniform(-0.05, 0.05), 0.45
    face = ((x - cx) / 0.12) ** 2 + ((y - cy) / 0.25) ** 2 < 1
    base[face] = np.array([0.82, 0.6, 0.48]) + 0.04 * (y[face, None] - 0.45)
    return np.clip(base, 0.02, 0.98)


def test_identity_when_ref_equals_src(tmp_path):
    frames = [scene(s) for s in range(4)]
    src = save_frames(tmp_path / "src", frames)
    ref = save_frames(tmp_path / "ref", frames)
    out = tmp_path / "look.cube"
    code, res = run("transfer", "--src", src, "--ref", ref, "--out", str(out), "--stats", str(tmp_path / "s.json"))
    assert code == 0 and res["ok"] is True
    import cube

    size, lut = cube.read_cube(str(out))
    assert size == 33
    ident = cube.identity(33)
    assert np.abs(lut - ident).max() < 1 / 255
    assert json.loads((tmp_path / "s.json").read_text()) == res["stats"]


def test_removes_uniform_cast(tmp_path):
    import color

    refs = [scene(s) for s in range(4)]
    srcs = []
    for f in refs:
        lab = color.rgb_to_lab(f)
        lab[..., 2] += 20
        srcs.append(np.clip(color.lab_to_rgb(lab), 0, 1))
    src = save_frames(tmp_path / "src", srcs)
    ref = save_frames(tmp_path / "ref", refs)
    code, res = run("transfer", "--src", src, "--ref", ref, "--out", str(tmp_path / "look.cube"), "--stats", str(tmp_path / "s.json"))
    assert code == 0 and res["ok"] is True
    g = res["stats"]["global"]
    assert g["src"]["b"] - g["ref"]["b"] > 15
    assert abs(g["result"]["b"] - g["ref"]["b"]) < 1.5


def test_l_curve_is_monotonic(tmp_path):
    import grade

    rng = np.random.default_rng(1)
    src_l = rng.uniform(10, 90, 50000)
    ref_l = np.concatenate([rng.normal(30, 5, 30000), rng.normal(75, 8, 20000)]).clip(0, 100)
    curve = grade.l_curve(src_l, ref_l)
    assert curve.shape == (257,)
    assert np.all(np.diff(curve) >= 0)
    assert curve[0] >= 0 and curve[-1] <= 100
    # it actually moves mids toward the reference distribution
    assert abs(np.interp(50, np.linspace(0, 100, 257), curve) - 50) > 5


def test_cube_roundtrip(tmp_path):
    import cube

    rng = np.random.default_rng(2)
    lut = rng.uniform(0, 1, (5, 5, 5, 3))
    p = str(tmp_path / "x.cube")
    cube.write_cube(p, lut, "t")
    size, back = cube.read_cube(p)
    assert size == 5
    assert np.allclose(back, lut, atol=1e-6)
    # look.js layout: red index varies fastest, then green, then blue
    cube.write_cube(p, cube.identity(3), "id")
    rows = [l.split() for l in open(p).read().splitlines() if l and l[0].isdigit()]
    assert [float(v) for v in rows[1]] == [0.5, 0, 0]
    assert [float(v) for v in rows[3]] == [0, 0.5, 0]
    assert [float(v) for v in rows[9]] == [0, 0, 0.5]
    text = open(p).read()
    assert "LUT_3D_SIZE 3" in text


def hlg_lut(tmp_path):
    import cube

    p = tmp_path / "hlg.cube"
    code, res = run("hlg2709", str(p))
    assert code == 0 and res == {"ok": True}
    size, lut = cube.read_cube(str(p))
    assert size == 33
    return lut


def test_hlg2709_maps_hlg_white_75pct_to_near_sdr_white(tmp_path):
    lut = hlg_lut(tmp_path)
    gray = lut[24, 24, 24]  # node 24/32 == 0.75
    assert np.allclose(gray, gray.mean(), atol=1e-4)
    # HLG 75% = 203 nit reference white; the specified pipeline (OOTF 1000 nit,
    # BT.2390 EETF to 100 nit, sRGB OETF) lands it at ~0.946 = near SDR white.
    assert 0.90 <= gray.mean() <= 0.98
    assert np.allclose(lut[0, 0, 0], 0, atol=1e-6)
    assert np.allclose(lut[32, 32, 32], 1, atol=1e-4)
    assert lut.min() >= 0 and lut.max() <= 1
    # monotonic along the neutral axis
    neutral = np.array([lut[i, i, i, 1] for i in range(33)])
    assert np.all(np.diff(neutral) >= 0)



def caption_frame(seed, text):
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:H, 0:W] / np.array([H, W])[:, None, None]
    f = np.stack([0.15 + 0.2 * x, 0.18 + 0.1 * y, 0.3 + 0.1 * x], -1) + rng.uniform(-0.03, 0.03, 3)
    if text:
        r0, r1 = int(0.60 * H), int(0.70 * H)
        f[r0:r1, 70:180] = np.array([0xE8, 0xB5, 0x4A]) / 255  # gold highlight box
        for cx in range(30, 226, 6):  # white glyph strokes across the line
            f[r0 + 2 : r1 - 2, cx : cx + 3] = 1.0
    return np.clip(f, 0, 1)


def test_textframes_finds_white_text_and_gold_box(tmp_path):
    frames = [caption_frame(i, text=i % 2 == 0) for i in range(12)]
    d = save_frames(tmp_path / "frames", frames)
    code, res = run("textframes", "--frames", d, "--keep", "6")
    assert code == 0 and res["ok"] is True
    assert sorted(res["frames"]) == [f"f{i:03d}.png" for i in range(0, 12, 2)]
    y0, y1 = res["band"]
    assert 0.40 <= y0 <= 0.65 and 0.65 <= y1 <= 0.85
    t = res["colors"]["text"]
    assert all(int(t[i : i + 2], 16) >= 0xF0 for i in (1, 3, 5))
    hl = res["colors"]["highlight"]
    assert hl is not None
    rgb = [int(hl[i : i + 2], 16) for i in (1, 3, 5)]
    assert max(abs(a - b) for a, b in zip(rgb, (0xE8, 0xB5, 0x4A))) <= 12


def test_textframes_none_when_no_text(tmp_path):
    frames = [caption_frame(i, text=False) for i in range(8)]
    d = save_frames(tmp_path / "frames", frames)
    code, res = run("textframes", "--frames", d, "--keep", "6")
    assert code == 0 and res["ok"] is True
    assert res["frames"] == []
    assert res["colors"]["text"] is None
    assert res["colors"]["highlight"] is None
