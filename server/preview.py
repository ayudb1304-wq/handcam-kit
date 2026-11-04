"""Preview of a free (under the move-match line) version: 4 frames side by side with a watermark, as one JPEG.
Customers see this instead of the video file, so a free version isn't a free AI video (DECISIONS §30).

    python3 server/preview.py video.mp4 out.jpg
"""
import sys
import cv2
import numpy as np


def main(src, dst):
    cap = cv2.VideoCapture(src)
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    frames = []
    for k in (0.1, 0.37, 0.63, 0.9):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(n * k))
        ok, f = cap.read()
        if not ok:
            continue
        h = 320
        frames.append(cv2.resize(f, (int(f.shape[1] * h / f.shape[0]), h)))
    if not frames:
        raise SystemExit("no frames")
    strip = (np.hstack(frames) * 0.55).astype(np.uint8)  # dimmed: a preview, not the shot
    cv2.putText(strip, "Not charged: under 70% move match. Preview only.", (16, strip.shape[0] - 20),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.imwrite(dst, strip, [cv2.IMWRITE_JPEG_QUALITY, 70])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
