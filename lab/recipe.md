# HandCam recipe book (private)

## Current best: v0.1 (2026-11-04, 1 test, synthetic move)
**Model:** Seedance 2.5, mode `omni_reference`, 480p for tests.
**Inputs:** start image = photoreal picture made from the export's first-frame PNG; video reference = HandCam "Export video" MP4 as is (phone look, 24 fps).
**Prompt B1:** "Handheld phone footage at night. The start image sets the look of the scene. The reference video shows only the camera movement: follow the camera movement of the reference video exactly, including its timing, small shakes and corrections. Do not copy the grey look of the reference video; keep the scene photoreal like the start image. The man stands still and keeps looking at the camera. Do not add any camera movement that is not in the reference."
**Result:** timing within ~0.1 s, glance angle exact, whip lands on the right framing.

## Rules learned
1. MiniMax H3 refuses start_image + video reference together; picture must go in as a reference image (first frame then not locked).
2. MiniMax H3 Max ran ~0.6 s late and returned 6.58 s for a 6 s request.
3. Seedance 2.5 accepts start_image + video reference and keeps exact length.

## Not yet known
- Does the small handheld wobble survive? (T1 move had none.)
- Repeatability: same inputs, several runs.
- Hand-shot takes (joystick walk + real hand rotation).
- Grey look vs lighter / grid floor reference.
- Kling / Genjutsu.
