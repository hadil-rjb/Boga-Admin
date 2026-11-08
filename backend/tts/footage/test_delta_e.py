import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image

import delta_e

HERE = os.path.dirname(os.path.abspath(__file__))


def test_sharma_reference_pairs():
    # Sharma, Wu, Dalal (2005) CIEDE2000 test data: pairs 1, 7, 17, 25
    lab1 = np.array([[50, 2.6772, -79.7751], [50, 0, 0], [50, 2.5, 0], [60.2574, -34.0099, 36.2677]])
    lab2 = np.array([[50, 0, -82.7485], [50, -1, 2], [73, 25, -18], [60.4626, -34.1751, 39.4387]])
    expected = np.array([2.0425, 2.3669, 27.1492, 1.2644])
    assert np.allclose(delta_e.ciede2000(lab1, lab2), expected, atol=1e-4)


def test_cli_identical_is_zero_and_known_pair(tmp_path):
    rng = np.random.default_rng(1)
    img = rng.integers(0, 256, (24, 32, 3), dtype=np.uint8)
    a, b, c = tmp_path / "a.png", tmp_path / "b.png", tmp_path / "c.png"
    Image.fromarray(img).save(a)
    Image.fromarray(img).save(b)
    Image.fromarray(np.zeros((24, 32, 3), np.uint8)).save(c)

    def run(x, y):
        p = subprocess.run([sys.executable, os.path.join(HERE, "delta_e.py"), str(x), str(y)], capture_output=True, text=True)
        assert p.returncode == 0, p.stdout + p.stderr
        return json.loads(p.stdout)["mean"]

    assert run(a, b) == 0
    # black vs white: L 0 vs 100, a = b = 0 -> CIEDE2000 = 100 / S_L with S_L at L' = 50 -> 1 => 100
    Image.fromarray(np.full((24, 32, 3), 255, np.uint8)).save(b)
    assert abs(run(c, b) - 100) < 0.01


def test_near_fraction_counts_band_pixels(tmp_path):
    img = np.zeros((100, 10, 3), np.uint8)
    img[60:65, :5] = (0xD8, 0xAC, 0x6C)  # 5 rows x 5 px of the colour inside the band
    img[10:20] = (0xD8, 0xAC, 0x6C)  # outside the band: not counted
    Image.fromarray(img).save(tmp_path / "f.png")
    assert abs(delta_e.near_fraction(str(tmp_path / "f.png"), "#D8AC6C", 0.5, 0.7) - 25 / 200) < 1e-9
    assert delta_e.near_fraction(str(tmp_path / "f.png"), "#2050E0", 0.5, 0.7) == 0
