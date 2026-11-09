"""Recolour the old terracotta UI accent in landing-page screenshots to the CineHand Rec Red, pixel by pixel in HSV.
Only strongly saturated pixels in the terracotta hue band move; greys, skin and lamp-light (more yellow) stay put."""
import sys, numpy as np
from PIL import Image

def rgb_to_hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1); d = mx - mn
    h = np.zeros_like(mx)
    m = d > 1e-6
    rm = m & (mx == r); gm = m & (mx == g) & ~rm; bm = m & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6; h[gm] = (b - r)[gm] / d[gm] + 2; h[bm] = (r - g)[bm] / d[bm] + 4
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    return h * 60, s, mx

def hsv_to_rgb(h, s, v):
    c = v * s; x = c * (1 - np.abs((h / 60) % 2 - 1)); m = v - c
    z = np.zeros_like(h); i = (h // 60).astype(int) % 6
    r = np.choose(i, [c, x, z, z, x, c]); g = np.choose(i, [x, c, c, x, z, z]); b = np.choose(i, [z, z, x, c, c, x])
    return np.stack([r + m, g + m, b + m], -1)

for arg in sys.argv[1:]:
    path, _, keep = arg.partition(':')  # optional :x0,y0,x1,y1 = a video area to leave untouched
    im = Image.open(path); alpha = im.getchannel('A') if im.mode == 'RGBA' else None
    a = np.asarray(im.convert('RGB')).astype(np.float64) / 255
    h, s, v = rgb_to_hsv(a)
    band = (h >= 6) & (h <= 26) & (s >= 0.28) & (v >= 0.18)        # terracotta family incl. tinted fills
    w = np.clip((s - 0.28) / 0.15, 0, 1) * band                        # soft edge on desaturated anti-aliasing
    if keep:
        x0, y0, x1, y1 = map(int, keep.split(',')); w[y0:y1, x0:x1] = 0; band[y0:y1, x0:x1] = False
    nh = h + (2.0 - h) * w                                              # → rec red hue
    ns = np.clip(s * (1 + 0.25 * w), 0, 1)
    out = hsv_to_rgb(nh, ns, v)
    res = Image.fromarray((out * 255 + .5).astype(np.uint8))
    if alpha: res.putalpha(alpha)
    res.save(path, 'WEBP', quality=88, method=6)
    print(path, f'{int(band.sum())} px recoloured')
