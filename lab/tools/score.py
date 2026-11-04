"""Move match v0: how closely does an AI video follow the camera move of a HandCam take?

    python3 lab/tools/score.py TAKE.json RESULT.mp4 [RESULT2.mp4 ...]

Truth comes from the take's raw samples (yaw = turn left/right, pitch = tilt up/down, degrees).
The result's turn and tilt are estimated by phase correlation between consecutive frames.
Walking (position) is not measured yet. Known limit: fast whips with motion blur read smaller than they are.
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


def score(take, result):
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
    }


if __name__ == "__main__":
    take = json.load(open(sys.argv[1]))
    for r in sys.argv[2:]:
        print(json.dumps(score(take, r)))
