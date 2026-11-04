"""Footage grading CLI. Every command prints exactly one JSON line on stdout.

  grade.py hlg2709 OUT.cube
  grade.py transfer --src DIR --ref DIR --out look.cube --stats stats.json
  grade.py textframes --frames DIR --keep 6
"""

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image

import color
import cube

LUT_SIZE = 33
SKIN_WEIGHT = 0.6
MIN_SKIN = 0.02
STD_PRIOR = 4.0  # Lab units added to both stds before the ratio
SKIN_ANCHOR_SIGMA = 18.0  # L units; minimum width of the skin-anchor bump on the L curve
SKIN_ANCHOR_MAX_SHIFT = 30.0  # L units; cap on the skin anchor shift
SKIN_MIN_CHROMA = 12  # Lab C*; neutral/cream walls sit below this
# Lab hue angle (deg). Real frames: face ~42-44, warm wall / wood map ~78-80 at
# the same chroma, so chroma alone cannot separate them.
SKIN_MAX_HUE = 65
FACE_CX, FACE_CY, FACE_RX, FACE_RY = 0.5, 0.33, 0.22, 0.16  # face prior, relative to w/h
BAND = (0.40, 0.85)
EDGE_STEP = 48  # |d luma / dx| on 0..255 that counts as a strong edge
DENSE_ROW = 0.08  # fraction of strong-edge pixels that makes a row "edge-dense"
MIN_DENSE_ROWS = 3  # a frame needs this many dense rows in the band to hold text


# ---- frames ---------------------------------------------------------------

def load_frames(d):
    names = sorted(n for n in os.listdir(d) if n.lower().endswith(".png"))
    if not names:
        raise ValueError("no PNG frames in %s" % d)
    imgs = [np.asarray(Image.open(os.path.join(d, n)).convert("RGB"), dtype=np.float64) / 255 for n in names]
    return names, imgs


# ---- skin mask ------------------------------------------------------------

def label_components(mask):
    """4-connected labels by min-label propagation (numpy only, no scipy)."""
    h, w = mask.shape
    big = h * w + 1
    lab = np.where(mask, np.arange(1, h * w + 1).reshape(h, w), big)
    while True:
        prev = lab
        m = lab.copy()
        m[1:] = np.minimum(m[1:], lab[:-1])
        m[:-1] = np.minimum(m[:-1], lab[1:])
        m[:, 1:] = np.minimum(m[:, 1:], lab[:, :-1])
        m[:, :-1] = np.minimum(m[:, :-1], lab[:, 1:])
        lab = np.where(mask, m, big)
        if np.array_equal(lab, prev):
            return np.where(mask, lab, 0)


def face_prior(h, w):
    """Ellipse where a talking-head face sits (center 0.5w, 0.33h; radii 0.22w x 0.16h)."""
    y, x = np.mgrid[0:h, 0:w]
    return ((x + 0.5 - FACE_CX * w) / (FACE_RX * w)) ** 2 + ((y + 0.5 - FACE_CY * h) / (FACE_RY * h)) ** 2 <= 1


def skin_mask(rgb, lab=None):
    """Largest component of Cb/Cr box AND C* >= SKIN_MIN_CHROMA AND hue <= SKIN_MAX_HUE
    AND the face prior.

    The chroma floor drops cream/beige walls that pass the Cb/Cr box, the hue cap
    drops yellow-orange wood and warm walls of skin-like chroma; the prior
    keeps walls, hands and wood from merging with the face. The prior is convex,
    so any component inside it already has its centroid inside it.
    """
    if lab is None:
        lab = color.rgb_to_lab(rgb)
    cb, cr = color.ycbcr(rgb * 255)
    mask = (cb >= 77) & (cb <= 127) & (cr >= 133) & (cr <= 173)
    mask &= np.hypot(lab[..., 1], lab[..., 2]) >= SKIN_MIN_CHROMA
    mask &= np.degrees(np.arctan2(lab[..., 2], lab[..., 1])) <= SKIN_MAX_HUE
    mask &= face_prior(*mask.shape)
    if not mask.any():
        return mask
    labels = label_components(mask)
    counts = np.bincount(labels.ravel())
    counts[0] = 0
    return labels == int(np.argmax(counts))


def clip_lab(imgs):
    """All pixels as Lab plus a parallel skin flag."""
    labs, skins = [], []
    for img in imgs:
        lab = color.rgb_to_lab(img)
        labs.append(lab.reshape(-1, 3))
        skins.append(skin_mask(img, lab).reshape(-1))
    return np.concatenate(labs), np.concatenate(skins)


# ---- transfer ---------------------------------------------------------------

def l_curve(src_l, ref_l, bins=256):
    """Monotonic L map sampled at the 257 bin edges over 0..100.

    CDF match on 256 bins; a tiny uniform prior keeps both CDFs strictly
    increasing so empty bins invert cleanly (same inputs -> exact identity).
    The offset from identity is box-smoothed (9 bins) and the curve is then
    forced non-decreasing.
    """
    edges = np.linspace(0, 100, bins + 1)

    def cdf(v):
        h, _ = np.histogram(np.clip(v, 0, 100), bins=edges)
        h = h / max(h.sum(), 1) + 1e-6
        return np.concatenate([[0], np.cumsum(h)]) / (h.sum())

    mapped = np.interp(cdf(src_l), cdf(ref_l), edges)
    delta = np.pad(mapped - edges, 4, mode="edge")
    smooth = edges + np.convolve(delta, np.ones(9) / 9, mode="valid")
    return np.clip(np.maximum.accumulate(smooth), 0, 100)


def skin_anchor(curve, src_skin_l, ref_skin_l, sigma=SKIN_ANCHOR_SIGMA):
    """Bend the L curve so the source skin median moves to the reference's.

    d = median(ref skin L) - f(m), m = median(src skin L), capped at
    +-SKIN_ANCHOR_MAX_SHIFT; add d * exp(-(x - m)^2 / (2 s^2)) with
    s = max(sigma, 0.75 |d|), so the bump's steepest slope |d|/s * e^-0.5 stays
    <= 0.81 and an identity-slope curve never turns back (no flat plateaus after
    the non-decreasing pass). Then clamp 0..100 and force non-decreasing.
    """
    x = np.linspace(0, 100, len(curve))
    m = float(np.median(src_skin_l))
    d = float(np.median(ref_skin_l)) - float(np.interp(m, x, curve))
    d = float(np.clip(d, -SKIN_ANCHOR_MAX_SHIFT, SKIN_ANCHOR_MAX_SHIFT))
    s = max(sigma, 0.75 * abs(d))
    bent = curve + d * np.exp(-((x - m) ** 2) / (2 * s ** 2))
    return np.maximum.accumulate(np.clip(bent, 0, 100))


def _moments(ab):
    # STD_PRIOR shrinks the std ratio toward 1: a small, flat region (a face
    # patch with std < 1 Lab unit) would otherwise give ratios like 2x that the
    # 0.6 skin weight then applies to every non-skin color far from skin.
    return ab.mean(axis=0), ab.std(axis=0) + STD_PRIOR


def ab_transfer(src_lab, src_skin, ref_lab, ref_skin):
    """Returns (fn: ab -> ab, mode). Mean/std match, 0.6 skin / 0.4 rest blend."""
    regions = src_skin.mean() >= MIN_SKIN and ref_skin.mean() >= MIN_SKIN
    pairs = []
    if regions:
        for sel_s, sel_r, wgt in ((src_skin, ref_skin, SKIN_WEIGHT), (~src_skin, ~ref_skin, 1 - SKIN_WEIGHT)):
            pairs.append((_moments(src_lab[sel_s, 1:]), _moments(ref_lab[sel_r, 1:]), wgt))
    else:
        pairs.append((_moments(src_lab[:, 1:]), _moments(ref_lab[:, 1:]), 1.0))

    def fn(ab):
        out = np.zeros_like(ab)
        for (ms, ss), (mr, sr), wgt in pairs:
            out += wgt * (mr + (ab - ms) * np.clip(sr / ss, 0.5, 2))
        return out

    return fn, "regions" if regions else "global"


def grade_lab(lab, curve, ab_fn):
    out = lab.copy()
    out[..., 0] = np.interp(lab[..., 0], np.linspace(0, 100, len(curve)), curve)
    out[..., 1:] = ab_fn(lab[..., 1:])
    return out


def bake(curve, ab_fn, size=LUT_SIZE):
    nodes = cube.identity(size)
    return np.clip(color.lab_to_rgb(grade_lab(color.rgb_to_lab(nodes), curve, ab_fn)), 0, 1)


def _means(lab):
    if len(lab) == 0:
        return None
    m = lab.mean(axis=0)
    return {"L": round(float(m[0]), 3), "a": round(float(m[1]), 3), "b": round(float(m[2]), 3)}


def transfer_stats(src_lab, src_skin, ref_lab, ref_skin, res_lab, mode):
    def region(ss, rs):
        return {"src": _means(src_lab[ss]), "ref": _means(ref_lab[rs]), "result": _means(res_lab[ss])}

    all_s, all_r = np.ones(len(src_lab), bool), np.ones(len(ref_lab), bool)
    return {
        "mode": mode,
        "skinFraction": {"src": round(float(src_skin.mean()), 4), "ref": round(float(ref_skin.mean()), 4)},
        "skin": region(src_skin, ref_skin),
        "rest": region(~src_skin, ~ref_skin),
        "global": region(all_s, all_r),
    }


def cmd_transfer(a):
    _, src_imgs = load_frames(a.src)
    _, ref_imgs = load_frames(a.ref)
    src_lab, src_skin = clip_lab(src_imgs)
    ref_lab, ref_skin = clip_lab(ref_imgs)
    curve = l_curve(src_lab[:, 0], ref_lab[:, 0])
    ab_fn, mode = ab_transfer(src_lab, src_skin, ref_lab, ref_skin)
    if mode == "regions":
        curve = skin_anchor(curve, src_lab[src_skin, 0], ref_lab[ref_skin, 0])
    lut = bake(curve, ab_fn)
    cube.write_cube(a.out, lut, "look")
    src_rgb = np.concatenate([i.reshape(-1, 3) for i in src_imgs])
    res_lab = color.rgb_to_lab(cube.apply_lut(lut, src_rgb))
    stats = transfer_stats(src_lab, src_skin, ref_lab, ref_skin, res_lab, mode)
    with open(a.stats, "w") as f:
        json.dump(stats, f, indent=2)
    return {"ok": True, "stats": stats}


# ---- hlg2709 --------------------------------------------------------------

def cmd_hlg2709(a):
    lut = color.hlg_to_709(cube.identity(LUT_SIZE))
    cube.write_cube(a.out, lut, "HLG BT.2020 to BT.709 SDR")
    return {"ok": True}


# ---- textframes -----------------------------------------------------------

def band_rows(img):
    h = img.shape[0]
    return int(BAND[0] * h), int(round(BAND[1] * h))


def row_edge_density(img):
    """Per-row fraction of strong horizontal-gradient pixels inside the band."""
    y0, y1 = band_rows(img)
    luma = (img[y0:y1] * 255) @ np.array([0.2126, 0.7152, 0.0722])
    edges = np.abs(np.diff(luma, axis=1)) > EDGE_STEP
    return edges.mean(axis=1)


def kmeans(x, k=3, iters=20):
    """Deterministic k-means: centroids seeded at chroma quantiles."""
    chroma = np.hypot(x[:, 1], x[:, 2])
    order = np.argsort(chroma)
    cent = x[order[np.linspace(0, len(x) - 1, k).astype(int)]].copy()
    for _ in range(iters):
        lab = np.argmin(((x[:, None] - cent[None]) ** 2).sum(-1), axis=1)
        for j in range(k):
            if np.any(lab == j):
                cent[j] = x[lab == j].mean(axis=0)
    return cent, lab


def caption_colors(imgs, dense):
    """Text = median of L>85 pixels; highlight = most chromatic k-means cluster."""
    rows, band_px = [], 0
    for img, d in zip(imgs, dense):
        y0, y1 = band_rows(img)
        band_px += (y1 - y0) * img.shape[1]
        rows.append(img[y0:y1][d].reshape(-1, 3))
    px = np.concatenate(rows)
    lab = color.rgb_to_lab(px)
    text = px[lab[:, 0] > 85]
    text_hex = color.to_hex(np.median(text, axis=0)) if len(text) else None
    vivid = lab[np.hypot(lab[:, 1], lab[:, 2]) > 30]
    hl_hex = None
    if len(vivid) >= 3:
        cent, members = kmeans(vivid)
        j = int(np.argmax(np.hypot(cent[:, 1], cent[:, 2])))
        if (members == j).sum() / band_px >= 0.015:
            hl_hex = color.to_hex(np.clip(color.lab_to_rgb(cent[j]), 0, 1))
    return text_hex, hl_hex


def cmd_textframes(a):
    names, imgs = load_frames(a.frames)
    dens = [row_edge_density(i) for i in imgs]
    scored = [(float(d.mean()), n, i, d >= DENSE_ROW) for n, i, d in zip(names, imgs, dens)]
    scored = [s for s in scored if s[3].sum() >= MIN_DENSE_ROWS]
    top = sorted(scored, key=lambda s: -s[0])[: a.keep]
    empty = {"ok": True, "frames": [], "band": None, "colors": {"text": None, "highlight": None}}
    if not top:
        return empty
    any_dense = np.any([s[3] for s in top], axis=0)
    h = imgs[0].shape[0]
    y0 = band_rows(imgs[0])[0]
    idx = np.nonzero(any_dense)[0]
    band = [round((y0 + idx[0]) / h, 4), round((y0 + idx[-1] + 1) / h, 4)]
    text, hl = caption_colors([s[2] for s in top], [s[3] for s in top])
    return {"ok": True, "frames": [s[1] for s in top], "band": band, "colors": {"text": text, "highlight": hl}}


# ---- CLI ------------------------------------------------------------------

def parse(argv):
    p = argparse.ArgumentParser(prog="grade.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    h = sub.add_parser("hlg2709")
    h.add_argument("out")
    t = sub.add_parser("transfer")
    for k in ("--src", "--ref", "--out", "--stats"):
        t.add_argument(k, required=True)
    f = sub.add_parser("textframes")
    f.add_argument("--frames", required=True)
    f.add_argument("--keep", type=int, default=6)
    return p.parse_args(argv)


class _ArgError(Exception):
    pass


def main(argv=None):
    commands = {"hlg2709": cmd_hlg2709, "transfer": cmd_transfer, "textframes": cmd_textframes}
    try:
        p_err = sys.stderr
        sys.stderr = open(os.devnull, "w")  # argparse usage noise must not hide the JSON line
        try:
            args = parse(argv)
        except SystemExit:
            raise _ArgError("invalid arguments: %s" % " ".join(argv if argv is not None else sys.argv[1:]))
        finally:
            sys.stderr.close()
            sys.stderr = p_err
        out = commands[args.cmd](args)
    except Exception as e:  # one JSON line, non-zero exit
        print(json.dumps({"ok": False, "error": str(e) or e.__class__.__name__}))
        return 1
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
