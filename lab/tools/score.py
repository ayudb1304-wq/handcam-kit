"""Move match v0: how closely does an AI video follow the camera move of a HandCam take?

    python3 lab/tools/score.py TAKE.json RESULT.mp4 [RESULT2.mp4 ...]

Turning and tilting: truth comes from the take's raw samples (yaw = turn left/right, pitch = tilt up/down,
degrees); the result's are estimated by phase correlation between consecutive frames.
Walking (forward/back, up/down): needs measure.mp4 next to TAKE.json (lab/tools/render.mjs makes it: the same
camera path through a speckled copy of the set). Both it and the result are measured the same way, from dense
optical flow fitted with zoom + shift per frame, and compared. "fwd" is how much bigger the view got, in %.
Known limits: fast whips with motion blur read smaller than they are; frames inside fast turns are skipped
for walking; sideways walking (orbits) shows up inside the turn numbers, not on its own.
Needs: pip install opencv-python-headless numpy
"""
import json, math, sys
import cv2
import numpy as np


def export_vfov(take):
    """Vertical fov of HandCam's exported video (mirrors public/shared/frames.js exportFov/exportSize)."""
    fov, a = take["view"].get("fov", 60), take["view"].get("aspect", 9 / 16)
    out = 9 / 16 if a < 1 else 16 / 9
    if out >= a:
        return fov
    half_w = math.tan(math.radians(fov) / 2) * a
    return math.degrees(2 * math.atan(half_w / out))


def take_curves(take):
    """Yaw and pitch (degrees, relative to the first sample) per sample time, from the raw quaternions."""
    t, yaw, pitch = [], [], []
    for s in take["samples"]:
        x, y, z, w = s["q"]
        # forward = q * (0,0,-1)
        fx = -(2 * (x * z + w * y))
        fy = -(2 * (y * z - w * x))
        fz = -(1 - 2 * (x * x + y * y))
        t.append(s["ts"] / 1000)
        yaw.append(math.degrees(math.atan2(-fx, -fz)))
        pitch.append(math.degrees(math.asin(max(-1, min(1, fy)))))
    yaw = np.unwrap(np.radians(yaw))
    return np.array(t), np.degrees(yaw - yaw[0]), np.array(pitch) - pitch[0]


def video_curves(path, vfov_deg):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    prev, f, win = None, None, None
    yaw, pitch, out_t, i = 0.0, 0.0, [], 0
    ys, ps = [], []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        h, w = g.shape
        scale = 320 / w
        if f is None:
            f = (h * scale / 2) / math.tan(math.radians(vfov_deg) / 2)  # focal length in px (square pixels)
        g = g[h // 4: 3 * h // 4, :]  # middle band: the set itself, not empty sky and floor
        g = cv2.equalizeHist(cv2.resize(g, None, fx=scale, fy=scale)).astype(np.float32)
        if win is None:
            win = cv2.createHanningWindow((g.shape[1], g.shape[0]), cv2.CV_32F)
        if prev is not None:
            (dx, dy), _ = cv2.phaseCorrelate(prev, g, win)
            yaw += math.degrees(math.atan(dx / f))    # content moves right -> camera turned left (+yaw)
            pitch += math.degrees(math.atan(dy / f))  # content moves down  -> camera tilted up (+pitch)
        out_t.append(i / fps); ys.append(yaw); ps.append(pitch)
        prev, i = g, i + 1
    return np.array(out_t), np.array(ys), np.array(ps), i / fps


def flow_motion(path, width=320):
    """Per frame: (t, fwd zoom %, up/down shift px), from Farneback flow fitted to shift + zoom + roll.
    Frames inside fast turns (big sideways shift) get zero zoom: their flow is mostly blur."""
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    prev, A, wts, out = None, None, None, []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        g = cv2.resize(g, None, fx=width / g.shape[1], fy=width / g.shape[1])
        if prev is not None:
            flow = cv2.calcOpticalFlowFarneback(prev, g, None, 0.5, 4, 21, 3, 5, 1.1, 0)
            if A is None:
                h, w = g.shape
                X, Y = np.meshgrid(np.arange(w) - w / 2, np.arange(h) - h / 2)
                x, y, n = X.ravel(), Y.ravel(), X.size
                A = np.zeros((2 * n, 4))
                A[:n, 0], A[:n, 2], A[:n, 3] = 1, x, -y   # u = a + d x - r y
                A[n:, 1], A[n:, 2], A[n:, 3] = 1, y, x    # v = b + d y + r x
            gx, gy = cv2.Sobel(prev, cv2.CV_32F, 1, 0), cv2.Sobel(prev, cv2.CV_32F, 0, 1)
            wt = np.sqrt(gx * gx + gy * gy)
            wt = np.sqrt(np.minimum(wt, np.percentile(wt, 95))).ravel()
            ww = np.concatenate([wt, wt])
            a, b, d, _ = np.linalg.lstsq(A * ww[:, None], np.concatenate([flow[..., 0].ravel(), flow[..., 1].ravel()]) * ww, rcond=None)[0]
            out.append((len(out) / fps + 1 / fps, 0.0 if abs(a) > 8 else d * 100, b))
        prev = g
    t = np.array([0.0] + [o[0] for o in out])
    return t, np.cumsum([0.0] + [o[1] for o in out]), np.cumsum([0.0] + [o[2] for o in out])


def moves_vertically(take, pitch):
    heights = [s["p"][1] for s in take["samples"]]
    return max(heights) - min(heights) > 0.2 or float(np.ptp(pitch)) > 8


def wobble(t, v, fast=None):
    """The shake: what is left after removing the slow move (0.25 s moving average), ignoring fast moves
    (whips), where the residual is the move itself. Pass `fast` to reuse the truth's mask for the result."""
    dt = np.median(np.diff(t))
    n = max(3, int(round(0.25 / dt)) | 1)
    slow = np.convolve(np.pad(v, n // 2, mode="edge"), np.ones(n) / n, mode="valid")
    if fast is None:
        fast = np.abs(np.gradient(slow, dt)) > 60  # deg/s
    calm = ~fast
    return (float(np.std((v - slow)[calm])) if calm.any() else 0.0), fast


def score(take, result, measure=None):
    tt, ty, tp = take_curves(take)
    rt, ry, rp, dur = video_curves(result, export_vfov(take))
    end = min(tt[-1], rt[-1])
    grid = np.arange(0, end, 1 / 24)
    # truth is shown sample-at-or-before (no blending), like the export
    idx = np.clip(np.searchsorted(tt, grid, side="right") - 1, 0, len(tt) - 1)
    Ty, Tp = ty[idx], tp[idx]
    Ry, Rp = np.interp(grid, rt, ry), np.interp(grid, rt, rp)
    rms = lambda a, b: float(np.sqrt(np.mean((a - b) ** 2)))
    shifts = np.arange(-1.5, 1.501, 1 / 24)
    best = min(shifts, key=lambda s: rms(np.interp(grid, rt + s, ry), Ty))
    wt, fast = wobble(grid, Ty)
    wr, _ = wobble(grid, np.interp(grid, rt + best, ry), fast)
    walk = {}
    if measure:
        mt, mf, mb = flow_motion(measure)
        qt, qf, qb = flow_motion(result)
        Mf, Mb = np.interp(grid, mt, mf), np.interp(grid, mt, mb)
        Qf, Qb = np.interp(grid, qt + best, qf), np.interp(grid, qt + best, qb)  # same time shift as the turn
        walk = {
            "fwd_take_pct": round(float(Mf[-1]), 1),     # how much closer the take got, as zoom %
            "fwd_result_pct": round(float(Qf[-1]), 1),
            "walk_ratio": round(float(Qf[-1] / Mf[-1]), 2) if abs(Mf[-1]) > 5 else None,  # 1.0 = walked as far
            "walk_corr": round(float(np.corrcoef(Qf, Mf)[0, 1]), 3) if np.std(Mf) > 1 else None,
            # only when the take really goes up/down (crouch) or tilts; otherwise it is just noise
            "updown_corr": round(float(np.corrcoef(Qb, Mb)[0, 1]), 3) if moves_vertically(take, tp) else None,
        }
    return {
        "result": result,
        "length_s": round(dur, 2), "take_length_s": round(float(tt[-1]), 2),
        "turn_rms_deg": round(rms(Ry, Ty), 1),
        "turn_corr": round(float(np.corrcoef(Ry, Ty)[0, 1]), 3) if np.std(Ty) > 0 else None,
        "timing_offset_s": round(float(-best), 2),  # + means the AI is late
        "turn_rms_after_shift_deg": round(rms(np.interp(grid, rt + best, ry), Ty), 1),
        "tilt_rms_deg": round(rms(Rp, Tp), 1),
        "take_wobble_deg": round(wt, 2),    # small shake in the take, outside fast moves
        "result_wobble_deg": round(wr, 2),  # same for the AI video: similar numbers = the shake survived
        **walk,
    }


if __name__ == "__main__":
    import os
    take = json.load(open(sys.argv[1]))
    measure = os.path.join(os.path.dirname(sys.argv[1]), "measure.mp4")
    if not os.path.exists(measure):
        print(f"no {measure}: walking not scored (run node lab/tools/render.mjs on the take folder)", file=sys.stderr)
        measure = None
    for r in sys.argv[2:]:
        print(json.dumps(score(take, r, measure)))
