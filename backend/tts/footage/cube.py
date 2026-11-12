"""3D LUT .cube I/O, same layout as frontend/studio/look.js (parseCube/writeCube).

Arrays are indexed lut[r, g, b, channel] with values 0..1. On disk the red
index varies fastest, then green, then blue.
"""

import numpy as np


def identity(size=33):
    v = np.linspace(0.0, 1.0, size)
    r, g, b = np.meshgrid(v, v, v, indexing="ij")
    return np.stack([r, g, b], -1)


def write_cube(path, lut, title="look"):
    lut = np.asarray(lut, dtype=np.float64)
    n = lut.shape[0]
    flat = lut.transpose(2, 1, 0, 3).reshape(-1, 3)  # [b, g, r] order -> red fastest
    lines = ['TITLE "%s"' % str(title).replace('"', "'"), "LUT_3D_SIZE %d" % n]
    lines += ["%.9f %.9f %.9f" % tuple(row) for row in flat]
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def read_cube(path):
    size, vals = 0, []
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line[0] == "#":
                continue
            parts = line.split()
            if parts[0][0].isalpha() or parts[0][0] == "_":
                if parts[0] == "LUT_3D_SIZE":
                    size = int(parts[1])
                continue
            if len(parts) >= 3:
                vals.append([float(p) for p in parts[:3]])
    if size < 2:
        raise ValueError("cube: missing or invalid LUT_3D_SIZE")
    if len(vals) != size ** 3:
        raise ValueError("cube: expected %d entries, got %d" % (size ** 3, len(vals)))
    lut = np.array(vals).reshape(size, size, size, 3).transpose(2, 1, 0, 3)
    return size, np.ascontiguousarray(lut)


def apply_lut(lut, rgb):
    """Trilinear sample like look.js sampleCube; rgb is [..., 3] in 0..1."""
    n = lut.shape[0]
    d = n - 1
    f = np.clip(np.asarray(rgb, dtype=np.float64), 0, 1) * d
    i0 = np.minimum(np.floor(f).astype(int), d - 1)
    t = f - i0
    out = np.zeros(f.shape)
    for dr in (0, 1):
        wr = t[..., 0] if dr else 1 - t[..., 0]
        for dg in (0, 1):
            wg = t[..., 1] if dg else 1 - t[..., 1]
            for db in (0, 1):
                wb = t[..., 2] if db else 1 - t[..., 2]
                node = lut[i0[..., 0] + dr, i0[..., 1] + dg, i0[..., 2] + db]
                out += (wr * wg * wb)[..., None] * node
    return out
