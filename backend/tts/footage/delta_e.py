"""Mean CIEDE2000 colour difference between two same-size images.

  delta_e.py A.png B.png                      ->  {"mean": float}
  delta_e.py --near IMG.png '#RRGGBB' Y0 Y1   ->  {"near": float}
      the fraction of the pixels in rows Y0..Y1 (fractions of the height) within CIEDE2000 10 of the colour

Used by the end-to-end preview/export parity test (backend/src/footage/e2e.footage.test.ts). Lab comes from color.py
(sRGB/709 display encoding, D65), the same conversion grade.py uses. Alpha is ignored.
"""

import json
import os
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import color  # noqa: E402


def ciede2000(lab1, lab2):
    """Per-pixel CIEDE2000 (kL = kC = kH = 1) of two [..., 3] Lab arrays."""
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]
    c_bar = (np.hypot(a1, b1) + np.hypot(a2, b2)) / 2
    g = 0.5 * (1 - np.sqrt(c_bar ** 7 / (c_bar ** 7 + 25.0 ** 7)))
    a1p, a2p = (1 + g) * a1, (1 + g) * a2
    c1p, c2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    h1p = np.where(c1p == 0, 0.0, h1p)
    h2p = np.where(c2p == 0, 0.0, h2p)

    dLp = L2 - L1
    dCp = c2p - c1p
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(c1p * c2p == 0, 0.0, dh)
    dHp = 2 * np.sqrt(c1p * c2p) * np.sin(np.radians(dh) / 2)

    Lp_bar = (L1 + L2) / 2
    Cp_bar = (c1p + c2p) / 2
    hsum = h1p + h2p
    hp_bar = np.where(np.abs(h1p - h2p) <= 180, hsum / 2, np.where(hsum < 360, (hsum + 360) / 2, (hsum - 360) / 2))
    hp_bar = np.where(c1p * c2p == 0, hsum, hp_bar)

    t = (1 - 0.17 * np.cos(np.radians(hp_bar - 30)) + 0.24 * np.cos(np.radians(2 * hp_bar))
         + 0.32 * np.cos(np.radians(3 * hp_bar + 6)) - 0.20 * np.cos(np.radians(4 * hp_bar - 63)))
    d_theta = 30 * np.exp(-(((hp_bar - 275) / 25) ** 2))
    r_c = 2 * np.sqrt(Cp_bar ** 7 / (Cp_bar ** 7 + 25.0 ** 7))
    s_l = 1 + 0.015 * (Lp_bar - 50) ** 2 / np.sqrt(20 + (Lp_bar - 50) ** 2)
    s_c = 1 + 0.045 * Cp_bar
    s_h = 1 + 0.015 * Cp_bar * t
    r_t = -np.sin(np.radians(2 * d_theta)) * r_c
    return np.sqrt((dLp / s_l) ** 2 + (dCp / s_c) ** 2 + (dHp / s_h) ** 2 + r_t * (dCp / s_c) * (dHp / s_h))


def load_lab(path):
    rgb = np.asarray(Image.open(path).convert("RGB"), dtype=np.float64) / 255
    return color.rgb_to_lab(rgb)


NEAR_DE = 10.0


def near_fraction(path, hex_color, y0, y1):
    lab = load_lab(path)
    h = lab.shape[0]
    band = lab[int(round(y0 * h)):max(int(round(y1 * h)), int(round(y0 * h)) + 1)]
    rgb = np.array([int(hex_color.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float64) / 255
    target = np.broadcast_to(color.rgb_to_lab(rgb), band.shape)
    return float((ciede2000(band, target) <= NEAR_DE).mean())


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "--near":
        if len(argv) != 5:
            print(json.dumps({"ok": False, "error": "usage: delta_e.py --near IMG.png '#RRGGBB' Y0 Y1"}))
            return 2
        print(json.dumps({"near": round(near_fraction(argv[1], argv[2], float(argv[3]), float(argv[4])), 6)}))
        return 0
    if len(argv) != 2:
        print(json.dumps({"ok": False, "error": "usage: delta_e.py A.png B.png"}))
        return 2
    a, b = load_lab(argv[0]), load_lab(argv[1])
    if a.shape != b.shape:
        print(json.dumps({"ok": False, "error": f"size mismatch: {a.shape[1]}x{a.shape[0]} vs {b.shape[1]}x{b.shape[0]}"}))
        return 1
    print(json.dumps({"mean": round(float(ciede2000(a, b).mean()), 4)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
