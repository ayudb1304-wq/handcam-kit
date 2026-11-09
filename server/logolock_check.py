"""Ground-truth check for logolock.py: a synthetic product shot where we know where the label is in every frame.

    python3 server/logolock_check.py OUT_DIR

The shot: a bottle-like surface with a plain label and a fake "AI logo" that wobbles every frame (like a model's
morphing), turning in perspective (yaw ±20°, pitch, roll), moving closer, handheld shake, a textured background moving
differently (parallax), the light dimming by 15%, sensor noise and H.264 compression.
Logo lock gets only the first frame's corners. Checks: the logo's corners vs the truth in every frame, and the drawn logo's
pixels vs the supplied logo (unwarped with the true geometry). Prints JSON; exits 1 when a check fails.
"""
import json, math, os, subprocess, sys
import cv2
import numpy as np

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import logolock  # noqa: E402

W, H, N, FPS = 1280, 720, 96, 24
rng = np.random.default_rng(7)

# the product surface (canvas px): blue body, cream label, the AI's logo on it
CW, CH = 900, 700
LABEL = (180, 150, 720, 550)
LOGO_RECT = np.float64([[300, 260], [600, 260], [600, 420], [300, 420]])  # where the true logo goes (TL, TR, BR, BL)
CREAM = np.array([200, 225, 238], np.float64)  # BGR


def surface(t):
    c = np.zeros((CH, CW, 3), np.float64)
    c[:] = (150, 80, 30)  # blue body
    x0, y0, x1, y1 = LABEL
    yy = np.linspace(0, 1, y1 - y0)[:, None, None]
    c[y0:y1, x0:x1] = CREAM * (0.97 + 0.06 * yy)  # a slight shading on the label
    # the AI's logo: text that wobbles every frame
    txt = np.zeros((CH, CW), np.uint8)
    cv2.putText(txt, 'AQVA', (318, 380), cv2.FONT_HERSHEY_DUPLEX, 3.2, 255, 9, cv2.LINE_AA)
    dx = cv2.GaussianBlur(rng.normal(0, 1, (CH, CW)).astype(np.float32), (0, 0), 25) * 120
    dy = cv2.GaussianBlur(rng.normal(0, 1, (CH, CW)).astype(np.float32), (0, 0), 25) * 120
    gx, gy = np.meshgrid(np.arange(CW, dtype=np.float32), np.arange(CH, dtype=np.float32))
    txt = cv2.remap(txt, gx + dx, gy + dy, cv2.INTER_LINEAR).astype(np.float64)[..., None] / 255
    c = c * (1 - txt) + np.array([40, 40, 200]) * txt
    # a little print texture on the body so it can be tracked like a real product
    for i in range(40):
        p = (int(20 + (i * 97) % (CW - 40)), int(20 + (i * 53) % (CH - 40)))
        if not (x0 - 10 < p[0] < x1 + 10 and y0 - 10 < p[1] < y1 + 10):
            cv2.circle(c, p, 6 + i % 9, (230, 230, 230), -1, cv2.LINE_AA)
    cv2.rectangle(c, (x0, y0), (x1, y1), (60, 60, 60), 3, cv2.LINE_AA)
    return c


def background():
    b = np.full((1600, 2600, 3), 90.0)
    for _ in range(500):
        col = rng.integers(20, 235, 3).tolist()
        p = (int(rng.integers(0, 2600)), int(rng.integers(0, 1600)))
        if rng.random() < 0.5:
            cv2.circle(b, p, int(rng.integers(4, 40)), col, -1, cv2.LINE_AA)
        else:
            cv2.line(b, p, (p[0] + int(rng.integers(-150, 150)), p[1] + int(rng.integers(-150, 150))), col, int(rng.integers(1, 6)), cv2.LINE_AA)
    return b


def rot(yaw, pitch, roll):
    cy, sy, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return Ry @ Rx @ Rz


def plane_h(t):
    """Canvas px -> frame px for the product surface at frame t."""
    u = t / (N - 1)
    shake = np.array([math.sin(t * 1.7) + 0.6 * math.sin(t * 4.1 + 1), math.cos(t * 1.3) + 0.5 * math.sin(t * 3.3)]) * 2.2
    yaw = math.radians(-20 + 40 * u + 1.2 * math.sin(t * 0.9))
    pitch = math.radians(8 * math.sin(u * math.pi) + 0.8 * math.sin(t * 1.1))
    roll = math.radians(5 * math.sin(u * 2.4) + 0.6 * math.sin(t * 1.9))
    dist = 1.6 - 0.45 * u
    f = 1000.0
    K = np.array([[f, 0, W / 2 + 120 * math.sin(u * 3) + shake[0]], [0, f, H / 2 + 40 * math.cos(u * 2) + shake[1]], [0, 0, 1]])
    R = rot(yaw, pitch, roll)
    k = 0.001  # canvas px -> metres
    A = np.array([[k, 0, -k * CW / 2], [0, k, -k * CH / 2], [0, 0, 1]])
    Hm = K @ np.column_stack([R[:, 0], R[:, 1], np.array([0, 0, dist])]) @ A
    return Hm / Hm[2, 2]


def bg_h(t):
    u = t / (N - 1)
    a = math.radians(2 * math.sin(u * 2))
    return np.array([[math.cos(a), -math.sin(a), -500 - 260 * u], [math.sin(a), math.cos(a), -300 - 60 * math.sin(u * 3)], [0, 0, 1]])


def light(t):
    return 1.0 - 0.15 * t / (N - 1)


def make_logo(path):
    """The brand's logo: transparent PNG, a green ring and 'CINE' (deliberately unlike the AI's logo)."""
    L = np.zeros((640, 1200, 4), np.uint8)
    cv2.circle(L, (190, 320), 150, (60, 170, 40, 255), 40, cv2.LINE_AA)
    cv2.putText(L, 'CINE', (380, 420), cv2.FONT_HERSHEY_DUPLEX, 7, (20, 20, 20, 255), 22, cv2.LINE_AA)
    cv2.imwrite(path, L)
    return L


def render(path):
    bg = background()
    enc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(FPS), '-i', '-',
                            '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', path], stdin=subprocess.PIPE)
    truth = []
    for t in range(N):
        G = plane_h(t)
        frame = cv2.warpPerspective(bg, bg_h(t), (W, H), flags=cv2.INTER_LINEAR)
        s = surface(t) * light(t)
        m = cv2.warpPerspective(np.ones((CH, CW), np.float64), G, (W, H), flags=cv2.INTER_LINEAR)[..., None]
        frame = frame * (1 - m) + cv2.warpPerspective(s, G, (W, H), flags=cv2.INTER_LINEAR) * m
        frame = cv2.GaussianBlur(frame, (0, 0), 0.7) + rng.normal(0, 2.0, frame.shape)
        enc.stdin.write(np.clip(frame, 0, 255).astype(np.uint8).tobytes())
        truth.append(logolock.apply_h(G, LOGO_RECT))
    enc.stdin.close()
    enc.wait()
    return truth


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    src, logo_png, out = (os.path.join(out_dir, n) for n in ('synthetic.mp4', 'logo.png', 'locked.mp4'))
    truth = render(src)
    L = make_logo(logo_png)
    quad0 = json.dumps(np.round(truth[0], 3).tolist())
    rep = logolock.lock(src, logo_png, quad0, out, cover='auto')
    err = np.array([np.linalg.norm(np.array(c) - tr, axis=1).max() for c, tr in zip(rep['corners'], truth)])

    # the drawn logo vs the real one: unwarp each output frame with the TRUE geometry into the logo's own pixels
    lw, lh = 300, 160
    Lsmall = cv2.resize(L, (lw, lh), interpolation=cv2.INTER_AREA).astype(np.float64)
    a = Lsmall[..., 3:4] / 255
    solid = cv2.erode((a[..., 0] > 0.98).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    clear = cv2.erode((a[..., 0] < 0.02).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    cap = cv2.VideoCapture(out)
    logo_err, cover_err, t = [], [], 0
    dst = np.float32([[0, 0], [lw, 0], [lw, lh], [0, lh]])
    while True:
        ok, f = cap.read()
        if not ok:
            break
        M = cv2.getPerspectiveTransform(truth[t].astype(np.float32), dst)
        un = cv2.warpPerspective(f, M, (lw, lh), flags=cv2.INTER_LINEAR).astype(np.float64)
        expect_logo = Lsmall[..., :3] * light(t)
        logo_err.append(float(np.abs(un - expect_logo)[solid].mean()))
        cover_err.append(float(np.abs(un - CREAM * light(t) * 0.995)[clear].mean()))  # where the logo is see-through: label, no AI logo
        t += 1
    cap.release()
    res = {
        'frames': len(err), 'locked': rep['locked'], 'cover': rep['cover'],
        'corner_err_px': {'mean': round(float(err.mean()), 3), 'p95': round(float(np.percentile(err, 95)), 3), 'max': round(float(err.max()), 3)},
        'logo_pixel_err': {'mean': round(float(np.mean(logo_err)), 2), 'max': round(float(np.max(logo_err)), 2)},
        'cover_err': {'mean': round(float(np.mean(cover_err)), 2), 'max': round(float(np.max(cover_err)), 2)},
        'light_gain': rep['light_gain'],
    }
    res['pass'] = bool(res['corner_err_px']['mean'] < 0.5 and res['corner_err_px']['p95'] < 1.0 and res['corner_err_px']['max'] < 2.0
                       and res['logo_pixel_err']['mean'] < 12 and res['cover_err']['mean'] < 12 and res['locked'] > 0.95)
    print(json.dumps(res))
    return 0 if res['pass'] else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'logolock-check'))
