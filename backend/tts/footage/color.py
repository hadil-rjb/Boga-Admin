"""Color conversions for grade.py: sRGB/709 <-> Lab (D65), YCbCr, HLG -> 709 SDR.

Display encoding uses the sRGB EOTF/OETF pair, matching look.js decode/encode.
"""

import numpy as np

# Linear BT.709/sRGB primaries -> XYZ, D65
_RGB2XYZ = np.array([
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
])
_XYZ2RGB = np.linalg.inv(_RGB2XYZ)
_WHITE = _RGB2XYZ.sum(axis=1)  # D65 white for this matrix (Y = 1)


def srgb_decode(v):
    v = np.asarray(v, dtype=np.float64)
    return np.where(v <= 0.04045, v / 12.92, ((np.maximum(v, 0) + 0.055) / 1.055) ** 2.4)


def srgb_encode(v):
    v = np.maximum(np.asarray(v, dtype=np.float64), 0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * v ** (1 / 2.4) - 0.055)


def _f(t):
    d = 6 / 29
    return np.where(t > d ** 3, np.cbrt(t), t / (3 * d * d) + 4 / 29)


def _finv(t):
    d = 6 / 29
    return np.where(t > d, t ** 3, 3 * d * d * (t - 4 / 29))


def rgb_to_lab(rgb):
    xyz = srgb_decode(rgb) @ _RGB2XYZ.T / _WHITE
    fx, fy, fz = (_f(xyz[..., i]) for i in range(3))
    return np.stack([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], -1)


def lab_to_rgb(lab):
    """Lab -> display-encoded RGB; not clipped (callers clip)."""
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    xyz = np.stack([_finv(fx), _finv(fy), _finv(fz)], -1) * _WHITE
    lin = xyz @ _XYZ2RGB.T
    return np.sign(lin) * srgb_encode(np.abs(lin))


def ycbcr(rgb255):
    """Full-range BT.601 (JPEG) YCbCr on 0..255 RGB; returns Cb, Cr."""
    r, g, b = rgb255[..., 0], rgb255[..., 1], rgb255[..., 2]
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return cb, cr


def to_hex(rgb01):
    c = np.clip(np.round(np.asarray(rgb01, dtype=np.float64) * 255), 0, 255).astype(int)
    return "#%02X%02X%02X" % tuple(c)


# ---- HLG / BT.2020 -> BT.709 SDR ----------------------------------------

_HLG_A = 0.17883277
_HLG_B = 1 - 4 * _HLG_A
_HLG_C = 0.5 - _HLG_A * np.log(4 * _HLG_A)
_BT2020_Y = np.array([0.2627, 0.6780, 0.0593])
_BT2020_TO_709 = np.array([  # BT.2087 linear-light primaries conversion
    [1.660491, -0.587641, -0.072850],
    [-0.124550, 1.132900, -0.008349],
    [-0.018151, -0.100579, 1.118730],
])
_PQ = dict(m1=2610 / 16384, m2=2523 / 4096 * 128, c1=3424 / 4096, c2=2413 / 4096 * 32, c3=2392 / 4096 * 32)


def hlg_inverse_oetf(e):
    e = np.clip(np.asarray(e, dtype=np.float64), 0, 1)
    hi = (np.exp((e - _HLG_C) / _HLG_A) + _HLG_B) / 12
    return np.where(e <= 0.5, e * e / 3, hi)


def hlg_ootf(scene, peak=1000.0, gamma=1.2):
    """Scene-linear BT.2020 RGB (0..1) -> display light in nits (Lb = 0)."""
    ys = scene @ _BT2020_Y
    return peak * (ys ** (gamma - 1))[..., None] * scene


def pq_encode(nits):
    p = _PQ
    y = (np.maximum(nits, 0) / 10000) ** p["m1"]
    return ((p["c1"] + p["c2"] * y) / (1 + p["c3"] * y)) ** p["m2"]


def pq_decode(e):
    p = _PQ
    x = np.maximum(e, 0) ** (1 / p["m2"])
    return 10000 * (np.maximum(x - p["c1"], 0) / (p["c2"] - p["c3"] * x)) ** (1 / p["m1"])


def bt2390_eetf(nits, src_peak=1000.0, dst_peak=100.0):
    """BT.2390 EETF roll-off in the PQ domain (black level 0), nits -> nits."""
    lo, span = pq_encode(0.0), pq_encode(src_peak) - pq_encode(0.0)
    e1 = (pq_encode(nits) - lo) / span
    max_lum = (pq_encode(dst_peak) - lo) / span
    ks = 1.5 * max_lum - 0.5
    t = np.clip((e1 - ks) / (1 - ks), 0, 1)
    t2, t3 = t * t, t * t * t
    spline = (2 * t3 - 3 * t2 + 1) * ks + (t3 - 2 * t2 + t) * (1 - ks) + (-2 * t3 + 3 * t2) * max_lum
    e2 = np.where(e1 < ks, e1, spline)
    return pq_decode(e2 * span + lo)


def hlg_to_709(code, peak=1000.0, sdr_white=100.0):
    """HLG BT.2020 code values [..., 3] -> BT.709 SDR code values (sRGB OETF).

    The EETF acts on max(R, G, B) and scales all three channels by the same
    ratio, which keeps hue and saturation ratios and cannot push one channel
    past the target peak.
    """
    disp = hlg_ootf(hlg_inverse_oetf(code), peak)
    disp = np.maximum(disp @ _BT2020_TO_709.T, 0)
    m = disp.max(axis=-1)
    mapped = bt2390_eetf(m, peak, sdr_white)
    ratio = np.where(m > 1e-9, mapped / np.maximum(m, 1e-9), 0.0)
    lin = np.clip(disp * ratio[..., None] / sdr_white, 0, 1)
    return np.clip(srgb_encode(lin), 0, 1)
