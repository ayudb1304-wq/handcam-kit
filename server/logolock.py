"""Logo lock: put the exact logo on the product in an AI video, in every frame, so it never morphs or warps.

    python3 server/logolock.py lock VIDEO LOGO.png QUAD OUT.mp4 [--cover auto|on|off] [--report REPORT.json]
    python3 server/logolock.py find VIDEO LOGO.png       (prints {"quad": [[x,y] x4] | null, "inliers": n})

QUAD is JSON: where the logo's top-left, top-right, bottom-right and bottom-left corners sit in the FIRST frame,
as fractions of the frame (0..1) or as pixels: [[x,y],[x,y],[x,y],[x,y]].

Why it can't morph: the logo is never redrawn by a model. Each frame shows the supplied PNG's own pixels, moved only by a
perspective (homography), the way a flat label moves when the camera moves. Only where it sits changes per frame.

How:
1. Track the surface around the logo (the product's label, a box side) through the shot: corner points (LK optical
   flow, RANSAC homography) predict each frame, then ECC aligns the surface to the FIRST frame's look to sub-pixel
   accuracy (no drift). When the surface has turned too far to match the first frame, ECC aligns frame to frame instead.
   The middle of the logo area is left out of tracking: that is where the AI's own logo wobbles.
2. Cover the AI's version of the logo (when the label around it is plain): a smooth colour surface fitted to the label
   right around the logo, re-fitted every frame so it follows the lighting.
3. Draw the logo: premultiplied alpha, mip level chosen for its size on screen, warped at 2x and filtered down (clean
   edges), lit by the label's brightness relative to the first frame (the first frame shows the logo's exact colours),
   motion-blurred along its own movement when it moves fast, softened by half a pixel like the footage around it.
4. Where tracking is lost (the surface leaves the frame, something covers it) the logo fades out instead of drifting.
Known limits: one flat surface per logo (a curved bottle is treated as flat, fine while it turns less than ~30°);
hands or objects passing in front of the logo are not cut out.
Needs: pip install opencv-python-headless numpy, and ffmpeg.
"""
import json, math, subprocess, sys
import cv2
import numpy as np

TRACK_SIDE = 1280      # tracking resolution (long side)
GROWS = (2.0, 2.5, 3.0, 3.6, 4.4)  # the tracked surface: the logo area grown by this much (the smallest that pins it)
HOLE = 0.55            # ... minus the middle of the logo area (the AI's own logo morphs there)
PIN_PX = 0.004         # "pins it": the noise-only corner error bound; ~40x smaller than the real error (calibrated on logolock_check.py)
NOISE = 4.0            # image noise + compression + the AI's own shimmer, in grey levels
ECC_GOOD = 0.80        # ECC correlation that counts as a good lock
CHAIN_GOOD = 0.85      # ... frame to frame (stricter: errors there add up)
REACQUIRE = 0.85       # ... to bring a lost logo back
SS = 2                 # supersampling of the drawn logo


# ---------------------------------------------------------------------------------------------- geometry helpers
def scale_about_centre(quad, k):
    c = quad.mean(axis=0)
    return (quad - c) * k + c


def apply_h(H, pts):
    p = np.asarray(pts, np.float64).reshape(-1, 1, 2)
    return cv2.perspectiveTransform(p, H).reshape(-1, 2)


def translate(x, y):
    return np.array([[1, 0, x], [0, 1, y], [0, 0, 1]], np.float64)


def poly_mask(shape, *polys, holes=()):
    m = np.zeros(shape, np.uint8)
    for p in polys:
        cv2.fillPoly(m, [np.round(p).astype(np.int32)], 255)
    for p in holes:
        cv2.fillPoly(m, [np.round(p).astype(np.int32)], 0)
    return m


def convex_ok(quad, w, h):
    """A sane quad: convex, not tiny, not absurdly large."""
    q = np.asarray(quad, np.float64)
    cross = []
    for i in range(4):
        a, b, c = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        cross.append((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]))
    area = abs(cv2.contourArea(q.astype(np.float32)))
    return (all(x > 0 for x in cross) or all(x < 0 for x in cross)) and area > 64 and area < 4 * w * h


def quad_shape(q):
    """(signed area, side lengths / sqrt(area)): the quad's handedness and proportions, free of its size."""
    q = np.asarray(q, np.float64)
    x, y = q[:, 0], q[:, 1]
    area = 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))
    sides = np.linalg.norm(np.roll(q, -1, axis=0) - q, axis=1)
    return area, sides / math.sqrt(max(abs(area), 1e-9))


def read_quad(text, w, h):
    q = np.array(json.loads(text), np.float64).reshape(4, 2)
    if q.max() <= 1.5:  # fractions of the frame
        q = q * [w, h]
    return q


# ---------------------------------------------------------------------------------------------- 1. tracking
def gray(frame, s):
    g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s != 1 else g


# How the logo's surface may move. A full perspective needs a surface with detail all around; a narrow or plain one
# (a tree trunk, a far-away label) only pins a simpler motion, which is what it does anyway when it is small on screen.
MODELS = ('homography', 'affine', 'similarity')


def as3(W):
    return W if W.shape == (3, 3) else np.vstack([W, [0, 0, 1]])


def to_similarity(H, centre):
    """The nearest scale + rotation + shift to an affine H, keeping where `centre` lands."""
    A = H[:2, :2]
    U, S_, Vt = np.linalg.svd(A)
    R = U @ Vt
    if np.linalg.det(R) < 0 or np.linalg.det(A) <= 0:
        return None
    M = np.eye(3)
    M[:2, :2] = R * math.sqrt(abs(np.linalg.det(A)))
    c = np.array([centre[0], centre[1], 1.0])
    M[:2, 2] = (H @ c)[:2] - M[:2, :2] @ c[:2]
    return M


def ecc(template, tmask, image, W, model='homography'):
    """ECC from template coords to image coords, starting at W (3x3). (rho, W 3x3) or (0, None)."""
    motion = cv2.MOTION_HOMOGRAPHY if model == 'homography' else cv2.MOTION_AFFINE
    W0 = (W if model == 'homography' else W[:2]).astype(np.float32)
    try:
        crit = (cv2.TERM_CRITERIA_COUNT | cv2.TERM_CRITERIA_EPS, 80, 1e-6)
        if hasattr(cv2, 'findTransformECCWithMask'):
            rho, W2 = cv2.findTransformECCWithMask(template, image, tmask, np.full(image.shape, 255, np.uint8), W0, motion, crit, 5)
        else:  # older OpenCV: the template's mask is approximated by its crop
            rho, W2 = cv2.findTransformECC(template, image, W0, motion, crit, None, 5)
    except cv2.error:
        return 0.0, None
    W2 = as3(W2.astype(np.float64))
    if model == 'similarity':
        h, w = template.shape
        W2 = to_similarity(W2, (w / 2, h / 2))
        if W2 is None:
            return 0.0, None
    return float(rho), W2


@np.errstate(all="ignore")
def corner_wobble(g, quad, region, inner, model='homography'):
    """How firmly this surface pins the logo's corners: the expected corner error (px) from NOISE grey levels of noise,
    from the motion model's Fisher information over the surface's gradients."""
    c = quad.mean(axis=0)
    k = max(np.linalg.norm(quad[0] - quad[2]), 1) / 2          # normalise coordinates (conditioning)
    m = poly_mask(g.shape, region, holes=[inner]) > 0
    gs = cv2.GaussianBlur(g.astype(np.float32), (0, 0), 1.0)
    Ix, Iy = cv2.Sobel(gs, cv2.CV_32F, 1, 0, ksize=3) / 8, cv2.Sobel(gs, cv2.CV_32F, 0, 1, ksize=3) / 8
    yy, xx = np.nonzero(m)
    if len(xx) < 200:
        return math.inf
    step = max(1, len(xx) // 60000)
    xx, yy = xx[::step], yy[::step]
    ix, iy = Ix[yy, xx].astype(np.float64), Iy[yy, xx].astype(np.float64)
    x, y = (xx - c[0]) / k, (yy - c[1]) / k
    # parameters live in coordinates scaled by 1/k; a pixel of image motion is k of them
    if model == 'similarity':
        J = np.stack([ix * x + iy * y, -ix * y + iy * x, ix, iy], 1) * k
    else:
        J = np.stack([ix * x, ix * y, ix, iy * x, iy * y, iy, -(ix * x + iy * y) * x, -(ix * x + iy * y) * y], 1) * k
        if model == 'affine':
            J = J[:, :6]
    F = J.T @ J * step
    try:
        cov = np.linalg.inv(F) * NOISE ** 2
    except np.linalg.LinAlgError:
        return math.inf
    worst = 0.0
    for qx, qy in (quad - c) / k:
        if model == 'similarity':
            A = np.array([[qx, -qy, 1, 0], [qy, qx, 0, 1]]) * k
        else:
            A = np.array([[qx, qy, 1, 0, 0, 0, -qx * qx, -qx * qy], [0, 0, 0, qx, qy, 1, -qx * qy, -qy * qy]]) * k
            if model == 'affine':
                A = A[:, :6]
        worst = max(worst, math.sqrt(max(np.linalg.eigvalsh(A @ cov @ A.T))))
    return worst


def choose_surface(g, q):
    """The richest motion, on the smallest surface around the logo, that pins its corners to PIN_PX.
    -> (model, grow, wobble px). When nothing does, the steadiest one (reported, so the person can be told)."""
    inner = scale_about_centre(q, HOLE)
    best = None
    for model in MODELS:
        for grow in GROWS:
            wob = corner_wobble(g, q, scale_about_centre(q, grow), inner, model)
            if best is None or wob < best[2]:
                best = (model, grow, wob)
            if wob <= PIN_PX:
                return model, grow, wob
    return best


def outliers(template, tmask, image, W):
    """Template pixels that don't follow the surface (background with parallax, a hand passing): a mask to drop."""
    h, w = template.shape
    warped = cv2.warpPerspective(image, W.astype(np.float32), (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP)
    valid = (tmask > 0) & (cv2.warpPerspective(np.full(image.shape, 255, np.uint8), W.astype(np.float32), (w, h),
                                                flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP) > 0)
    if valid.sum() < 100:
        return None
    a, b = template.astype(np.float32), warped.astype(np.float32)
    a = (a - a[valid].mean()) / (a[valid].std() + 1e-6)
    b = (b - b[valid].mean()) / (b[valid].std() + 1e-6)
    r = cv2.GaussianBlur(np.abs(a - b), (0, 0), 2.0)
    bad = valid & (r > max(4.0 * np.median(r[valid]), 0.35))
    if bad.mean() < 0.01:
        return None
    return cv2.dilate(bad.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0


def robust_ecc(template, tmask, image, W, model):
    """ECC, then again without the pixels that moved differently."""
    rho, W1 = ecc(template, tmask, image, W, model)
    if W1 is None:
        return rho, W1
    bad = outliers(template, tmask, image, W1)
    if bad is not None:
        m2 = tmask.copy()
        m2[bad] = 0
        if (m2 > 0).sum() > 0.4 * (tmask > 0).sum():
            rho2, W2 = ecc(template, m2, image, W1, model)
            if W2 is not None:
                return rho2, W2
    return rho, W1


def surface_template(g, H, region, inner):
    """The tracked surface as it looks in `g` (where H puts region): crop, mask, crop offset."""
    reg, inn = apply_h(H, region), apply_h(H, inner)
    hh, ww = g.shape
    x0, y0 = np.floor(reg.min(axis=0)).astype(int)
    x1, y1 = np.ceil(reg.max(axis=0)).astype(int)
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, ww), min(y1, hh)
    if x1 - x0 < 16 or y1 - y0 < 16:
        return None
    off = np.array([x0, y0], np.float64)
    m = poly_mask((y1 - y0, x1 - x0), reg - off, holes=[inn - off])
    return g[y0:y1, x0:x1], m, translate(x0, y0)


def track(video, quad0):
    """Per frame: H (frame-0 pixels -> frame-t pixels, full resolution) and a confidence 0..1."""
    cap = cv2.VideoCapture(video)
    ok, f0 = cap.read()
    if not ok:
        raise SystemExit(f'cannot read {video}')
    H0, W0 = f0.shape[:2]
    s = min(1.0, TRACK_SIDE / max(W0, H0))
    S, Si = np.diag([s, s, 1.0]), np.diag([1 / s, 1 / s, 1.0])
    q0 = quad0 * s
    g0 = gray(f0, s)
    model, grow, wobble = choose_surface(g0, q0)
    region, inner = scale_about_centre(q0, grow), scale_about_centre(q0, HOLE)

    first = surface_template(g0, np.eye(3), region, inner)
    if first is None:
        raise SystemExit('the logo area is too small or outside the frame')
    shape0 = quad_shape(q0)

    def plausible(H, Hprev=None):
        """The logo can only move like a label on a surface: same handedness, no squashing, no sudden size jumps."""
        q = apply_h(H, q0)
        if not convex_ok(q, 4 * g0.shape[1], 4 * g0.shape[0]):
            return False
        sh = quad_shape(q)
        if np.sign(sh[0]) != np.sign(shape0[0]) or np.any(np.abs(np.log(sh[1] / shape0[1])) > math.log(1.6)):
            return False
        if Hprev is not None:
            r = abs(sh[0]) / max(abs(quad_shape(apply_h(Hprev, q0))[0]), 1e-6)
            if not 0.75 < r < 1.33:
                return False
        return True

    def from_first(g, starts):
        """Lock onto the first frame's look of the surface, trying each starting guess. -> (H, rho) or (None, 0)"""
        tpl, tm, off = first
        best = (None, 0.0)
        for st in starts:
            rho, Wt = robust_ecc(tpl, tm, g, st @ off, model)
            if Wt is not None and rho > best[1]:
                best = (Wt @ np.linalg.inv(off), rho)
        return best

    Hs, conf = [np.eye(3)], [1.0]
    prev, prevH, lost, coast = g0, np.eye(3), False, 0
    size = np.linalg.norm(q0[0] - q0[2])
    while True:
        ok, f = cap.read()
        if not ok:
            break
        g = gray(f, s)
        H, c = None, 0.0
        if lost:
            # only the first frame's look can bring the logo back (never a chain from a lost state: no jumping to a lookalike)
            cand, rho = from_first(g, [prevH, np.eye(3)])
            if cand is not None and rho >= REACQUIRE and plausible(cand):
                H, c, lost = cand, rho, False
        else:
            # a. predict with corner points tracked from the previous frame (forward-backward checked)
            pred, lk_ok = prevH, False
            m = poly_mask(prev.shape, apply_h(prevH, region), holes=[apply_h(prevH, inner)])
            pts = cv2.goodFeaturesToTrack(prev, 500, 0.005, 4, mask=m, blockSize=7)
            if pts is not None and len(pts) >= 8:
                nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, g, pts, None, winSize=(21, 21), maxLevel=4)
                back, st2, _ = cv2.calcOpticalFlowPyrLK(g, prev, nxt, None, winSize=(21, 21), maxLevel=4)
                good = (st.ravel() == 1) & (st2.ravel() == 1) & (np.linalg.norm((back - pts).reshape(-1, 2), axis=1) < 0.7)
                if good.sum() >= 8:
                    a, b = pts[good], nxt[good]
                    if model == 'homography':
                        Hinc, inl = cv2.findHomography(a, b, cv2.RANSAC, 1.5)
                    elif model == 'affine':
                        Hinc, inl = cv2.estimateAffine2D(a, b, method=cv2.RANSAC, ransacReprojThreshold=1.5)
                    else:
                        Hinc, inl = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC, ransacReprojThreshold=1.5)
                    if Hinc is not None and inl is not None and inl.sum() >= 8:
                        pred, lk_ok = as3(Hinc) @ prevH, True
            # b. refine against the first frame (no drift) ...
            cand, rho = from_first(g, [pred])
            if cand is not None and rho >= ECC_GOOD and plausible(cand, prevH) and (
                    not lk_ok or np.abs(apply_h(cand, q0) - apply_h(pred, q0)).max() < max(4.0, 0.2 * size)):
                H, c = cand, rho
            # ... or, when the surface now looks too different from then, against the previous frame
            if H is None:
                pt = surface_template(prev, prevH, region, inner)
                if pt is not None:
                    tpl, tm, off = pt
                    rho2, Wp = robust_ecc(tpl, tm, g, (pred @ np.linalg.inv(prevH)) @ off, model)
                    if Wp is not None and rho2 >= CHAIN_GOOD:
                        cand = Wp @ np.linalg.inv(off) @ prevH
                        if plausible(cand, prevH):
                            H, c = cand, min(rho2, 0.9)
            # ... or coast on the points for a few frames, fading
            if H is None and lk_ok and coast < 3 and plausible(pred, prevH):
                H, c = pred, 0.45
            coast = coast + 1 if c < ECC_GOOD else 0
            if H is None:
                lost = True
        if H is None:
            H = prevH  # hold where it was last seen; it is invisible (confidence 0)
        # out of frame: the logo area mostly left the picture
        inside = cv2.contourArea(cv2.convexHull(np.clip(apply_h(H, q0), [0, 0], [g.shape[1], g.shape[0]]).astype(np.float32)))
        if inside < 0.15 * max(cv2.contourArea(apply_h(H, q0).astype(np.float32)), 1):
            c = 0.0
        Hs.append(H)
        conf.append(c)
        prev, prevH = g, H
    cap.release()
    return [Si @ H @ S for H in Hs], conf, {'motion': model, 'surface_grow': grow, 'corner_wobble_px': round(wobble / s, 3)}


# ---------------------------------------------------------------------------------------------- 2. cover the AI's logo
def quad_fit_terms(u, v):
    return np.stack([np.ones_like(u), u, v, u * u, v * v, u * v], axis=-1)


def label_surface(frame, P, n=96, band=0.22):
    """Fit a smooth colour surface to the label just around the logo (logo coords u,v in 0..1).
    Returns (coef 6x3, robust residual) or (None, inf)."""
    lo, hi = -band, 1 + band
    gw = n
    A = translate(lo, lo) @ np.diag([(hi - lo) / gw, (hi - lo) / gw, 1.0])   # grid px -> u,v
    M = P @ A                                                                 # grid px -> frame px
    patch = cv2.warpPerspective(frame, M, (gw, gw), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                                borderMode=cv2.BORDER_CONSTANT, borderValue=(-1, -1, -1))
    valid = cv2.warpPerspective(np.full(frame.shape[:2], 255, np.uint8), M, (gw, gw),
                                flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP) > 0
    jj, ii = np.mgrid[0:gw, 0:gw]
    u, v = lo + (ii + 0.5) * (hi - lo) / gw, lo + (jj + 0.5) * (hi - lo) / gw
    ring = valid & ~((u > -0.03) & (u < 1.03) & (v > -0.03) & (v < 1.03))
    if ring.sum() < 80:
        return None, math.inf
    return fit_surface(quad_fit_terms(u[ring], v[ring]), patch[ring].astype(np.float64))


@np.errstate(all='ignore')  # numpy + Apple Accelerate raise false floating-point flags in matmul
def fit_surface(X, Y):
    keep = np.ones(len(Y), bool)
    for _ in range(3):
        coef, *_ = np.linalg.lstsq(X[keep], Y[keep], rcond=None)
        r = np.abs(X @ coef - Y).max(axis=1)
        mad = np.median(r[keep]) + 1e-6
        keep = r < max(3.0 * mad, 6.0)
        if keep.sum() < 40:
            return None, math.inf
    return coef, float(np.median(np.abs(X[keep] @ coef - Y[keep])) * 1.4826)


def cover_layer(frame, P, coef, pad=0.06):
    """The fitted label colour over the logo area (a little larger than it), feathered, in frame pixels."""
    h, w = frame.shape[:2]
    lo, hi = -pad, 1 + pad
    c = apply_h(P, [[lo, lo], [hi, lo], [hi, hi], [lo, hi]])
    x0, y0 = np.floor(c.min(axis=0)).astype(int) - 2
    x1, y1 = np.ceil(c.max(axis=0)).astype(int) + 2
    x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
    if x1 <= x0 or y1 <= y0:
        return None
    Pinv = np.linalg.inv(P)
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float64)
    uvw = np.stack([xx, yy, np.ones_like(xx)], -1) @ Pinv.T
    u, v = uvw[..., 0] / uvw[..., 2], uvw[..., 1] / uvw[..., 2]
    col = quad_fit_terms(u, v) @ coef
    # feather: 1 inside, 0 outside the padded area, over ~2 px
    d = np.minimum.reduce([u - lo, hi - u, v - lo, hi - v])
    px = 1.0 / max(np.linalg.norm(c[1] - c[0]), np.linalg.norm(c[3] - c[0]), 1) * (hi - lo)  # one pixel in u units
    a = np.clip(d / (2.0 * px), 0, 1)
    return x0, y0, np.clip(col, 0, 255).astype(np.float32), a.astype(np.float32)


# ---------------------------------------------------------------------------------------------- 3. draw the logo
class Logo:
    def __init__(self, path):
        img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
        if img is None:
            raise SystemExit(f'cannot read {path}')
        if img.ndim == 2:
            img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
        if img.shape[2] == 3:
            img = np.dstack([img, np.full(img.shape[:2], 255, np.uint8)])
        if img.dtype != np.uint8:
            img = (img / 257).astype(np.uint8)
        a = img[..., 3:4].astype(np.float32) / 255
        pm = np.dstack([img[..., :3].astype(np.float32) * a, a[..., 0] * 255])  # premultiplied BGRA
        self.h, self.w = img.shape[:2]
        self.levels = [pm]
        while min(self.levels[-1].shape[:2]) > 16:
            self.levels.append(cv2.pyrDown(self.levels[-1]))
        self.opaque = float((img[..., 3] > 250).mean())

    def level_for(self, screen_px):
        """The mip level just bigger than SS x the size it covers on screen (no aliasing)."""
        k = 0
        while k + 1 < len(self.levels) and self.levels[k + 1].shape[1] >= SS * screen_px:
            k += 1
        lv = self.levels[k]
        return lv, lv.shape[1] / self.w

    def layer(self, C, shape, blur_quads=None):
        """Premultiplied BGRA layer of the logo with its corners at C (4x2 frame px). -> (x0, y0, layer) or None."""
        h, w = shape[:2]
        quads = blur_quads or [C]
        allc = np.vstack(quads)
        x0, y0 = np.floor(allc.min(axis=0)).astype(int) - 2
        x1, y1 = np.ceil(allc.max(axis=0)).astype(int) + 2
        x0, y0, x1, y1 = max(x0, 0), max(y0, 0), min(x1, w), min(y1, h)
        if x1 <= x0 or y1 <= y0:
            return None
        screen = max(np.linalg.norm(C[1] - C[0]), np.linalg.norm(C[2] - C[3]), 1)
        lv, k = self.level_for(screen)
        lw, lh = lv.shape[1], lv.shape[0]
        src = np.float32([[0, 0], [lw, 0], [lw, lh], [0, lh]])
        acc = None
        for q in quads:
            dst = ((q - [x0, y0]) * SS).astype(np.float32)
            M = cv2.getPerspectiveTransform(src, dst)
            big = cv2.warpPerspective(lv, M, ((x1 - x0) * SS, (y1 - y0) * SS), flags=cv2.INTER_LINEAR,
                                      borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
            acc = big if acc is None else acc + big
        acc /= len(quads)
        return x0, y0, cv2.resize(acc, (x1 - x0, y1 - y0), interpolation=cv2.INTER_AREA)


def logo_corners(H, quad0):
    return apply_h(H, quad0)


def shutter_quads(Cs, t, n_max=48):
    """Corner sets across a half-frame shutter around t, when the logo moves fast (else None)."""
    a, b = Cs[max(t - 1, 0)], Cs[min(t + 1, len(Cs) - 1)]
    span = np.abs(b - a).max() / 2 / 2  # px moved during half a frame
    n = int(min(n_max, math.ceil(span / 0.6)))  # steps under a pixel apart: a smooth streak, not copies
    if n < 2:
        return None
    out = []
    for u in np.linspace(-0.25, 0.25, n):
        nb = a if u < 0 else b
        out.append(Cs[t] + (nb - Cs[t]) * abs(u))
    return out


# ---------------------------------------------------------------------------------------------- 4. the whole job
def luminance(bgr):
    return 0.114 * bgr[..., 0] + 0.587 * bgr[..., 1] + 0.299 * bgr[..., 2]


def under_lum(frame, P):
    """Median brightness of what is under the logo (the product's own surface there)."""
    M = P @ translate(0.1, 0.1) @ np.diag([0.8 / 24, 0.8 / 24, 1.0])
    patch = cv2.warpPerspective(frame, M, (24, 24), flags=cv2.INTER_AREA | cv2.WARP_INVERSE_MAP)
    return float(np.median(luminance(patch.astype(np.float64))))


def mean_lum(coef):
    """Mean brightness of a fitted label surface over the logo area (u, v in 0..1)."""
    return float(luminance(np.array([1, 0.5, 0.5, 1 / 3, 1 / 3, 0.25]) @ coef))


def lock(video, logo_path, quad_text, out, cover='auto', report=None, soft=0.5):
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()
    quad0 = read_quad(quad_text, W, H)
    if not convex_ok(quad0, W, H):
        raise SystemExit('the logo corners do not make a sensible shape')
    logo = Logo(logo_path)

    Hs, conf, tinfo = track(video, quad0)
    Cs = [logo_corners(h, quad0) for h in Hs]
    unit = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])
    Ps = [cv2.getPerspectiveTransform(unit, c.astype(np.float32)).astype(np.float64) for c in Cs]

    # visibility: gone the frame the lock is lost (never a logo left floating on something else), back in over 4
    vis, a = [], 1.0
    for c in conf:
        a = min(1.0, a + 0.25) if c >= 0.6 else 0.0
        vis.append(a)

    cap = cv2.VideoCapture(video)
    ok, f0 = cap.read()
    coef0, resid0 = label_surface(f0, Ps[0])
    use_cover = cover == 'on' or (cover == 'auto' and coef0 is not None and resid0 < 10.0 and logo.opaque < 0.97)
    ref_lum = mean_lum(coef0) if use_cover else under_lum(f0, Ps[0])
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', f'{fps}',
                            '-i', '-', '-i', video, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'medium',
                            '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', '-movflags', '+faststart', out],
                           stdin=subprocess.PIPE)
    gains, t, gain = [], 0, 1.0
    while True:
        ok, frame = cap.read()
        if not ok or t >= len(Ps):
            break
        out_f = frame.astype(np.float32)
        P, C = Ps[t], Cs[t]
        if vis[t] > 0:
            coef = label_surface(frame, P)[0] if use_cover else None
            # light: the surface's brightness now vs in the first frame (frame 0 shows the logo's exact colours),
            # steadied over a few frames (it is a measurement, not a look) and kept within ±25%
            now = (mean_lum(coef) if coef is not None else under_lum(frame, P)) / max(ref_lum, 1)
            gain = float(np.clip(gain + 0.35 * (now - gain), 0.75, 1.25))
            gains.append(gain)
            if use_cover and coef is not None:
                cl = cover_layer(frame, P, coef)
                if cl:
                    x0, y0, col, al = cl
                    al = al[..., None] * vis[t]
                    roi = out_f[y0:y0 + col.shape[0], x0:x0 + col.shape[1]]
                    roi[:] = roi * (1 - al) + col * al
            lay = logo.layer(C, frame.shape, shutter_quads(Cs, t))
            if lay:
                x0, y0, L = lay
                if soft > 0:
                    L = cv2.GaussianBlur(L, (0, 0), soft)
                rgb, al = L[..., :3] * gain, (L[..., 3:4] / 255) * vis[t]
                roi = out_f[y0:y0 + L.shape[0], x0:x0 + L.shape[1]]
                roi[:] = roi * (1 - al) + rgb * vis[t]
        enc.stdin.write(np.clip(out_f + 0.5, 0, 255).astype(np.uint8).tobytes())
        t += 1
    enc.stdin.close()
    if enc.wait() != 0:
        raise SystemExit('ffmpeg could not write the video')
    cap.release()
    rep = {
        'frames': len(conf), 'fps': fps, 'size': [W, H],
        'locked': round(sum(c >= ECC_GOOD for c in conf) / len(conf), 3),
        'faded_frames': int(sum(v < 1 for v in vis)),
        'cover': bool(use_cover),
        **tinfo,
        'light_gain': [round(min(gains), 3), round(max(gains), 3)] if gains else None,
        'corners': [np.round(c, 2).tolist() for c in Cs],
        'confidence': [round(c, 3) for c in conf],
    }
    if report:
        with open(report, 'w') as fh:
            json.dump(rep, fh)
    return rep


def find(video, logo_path):
    """Where the logo (or the AI's version of it) is in the first frame, if it can be recognised."""
    cap = cv2.VideoCapture(video)
    ok, f0 = cap.read()
    cap.release()
    if not ok:
        return {'quad': None, 'inliers': 0}
    img = cv2.imread(logo_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return {'quad': None, 'inliers': 0}
    if img.ndim == 3 and img.shape[2] == 4:
        a = img[..., 3:4].astype(np.float32) / 255
        flat = (img[..., :3] * a + 128 * (1 - a)).astype(np.uint8)
        mask = (img[..., 3] > 10).astype(np.uint8) * 255
    else:
        flat, mask = (img if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)), None
    k = min(1.0, 800 / max(flat.shape[:2]))
    lg = cv2.resize(cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY), None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    if mask is not None:
        mask = cv2.resize(mask, (lg.shape[1], lg.shape[0]), interpolation=cv2.INTER_NEAREST)
    sift = cv2.SIFT_create()
    k1, d1 = sift.detectAndCompute(lg, mask)
    k2, d2 = sift.detectAndCompute(cv2.cvtColor(f0, cv2.COLOR_BGR2GRAY), None)
    if d1 is None or d2 is None or len(k1) < 6:
        return {'quad': None, 'inliers': 0}
    pairs = cv2.BFMatcher().knnMatch(d1, d2, k=2)
    good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < 0.75 * n.distance]
    if len(good) < 8:
        return {'quad': None, 'inliers': len(good)}
    src = np.float32([k1[m.queryIdx].pt for m in good]) / k
    dst = np.float32([k2[m.trainIdx].pt for m in good])
    Hm, inl = cv2.findHomography(src, dst, cv2.RANSAC, 4.0)
    n = int(inl.sum()) if inl is not None else 0
    h, w = img.shape[:2]
    if Hm is None or n < 10:
        return {'quad': None, 'inliers': n}
    q = apply_h(Hm, [[0, 0], [w, 0], [w, h], [0, h]])
    H0, W0 = f0.shape[:2]
    if not convex_ok(q, W0, H0):
        return {'quad': None, 'inliers': n}
    return {'quad': np.round(q / [W0, H0], 5).tolist(), 'inliers': n}


if __name__ == '__main__':
    args = sys.argv[1:]
    opt = lambda name, d=None: args[args.index(name) + 1] if name in args else d
    if args[:1] == ['find'] and len(args) >= 3:
        print(json.dumps(find(args[1], args[2])))
    elif args[:1] == ['lock'] and len(args) >= 5:
        rep = lock(args[1], args[2], args[3], args[4], cover=opt('--cover', 'auto'), report=opt('--report'))
        print(json.dumps({k: v for k, v in rep.items() if k not in ('corners', 'confidence')}))
    else:
        print(__doc__)
        sys.exit(2)
