# Build plan

Each phase ends with an **acceptance test you run with your own iPhone**. Do not start the next phase until it passes. Status: `todo | doing | done`.

---

## Phase 0 — Scaffold runs · `done` (shipped in this kit)

Server relays, desk shows QR, phone tilts a camera. No recording yet.

**Accept:** Scan QR → tap *Enable motion* → tilt phone → desk gizmo tilts the same way within ~100 ms.

---

## Phase 1 — Scene from a sentence · `done` (passed on iPhone 14 via cloudflared, 2026-11-02)

- `POST /api/scene` calls Claude (when key present) with `server/scene-prompt.md`; validates against schema; falls back to templates.
- Desk renders objects (plane/box/cylinder/sphere/stickfigure) in overview; sends `scene` to phone; phone renders same.
- Three templates ship: `parking-lot.json`, `empty-room.json`, `street-corner.json`.
- Stick figure builder in `shared/stickfigure.js`, four poses.

**Accept:** Type "parking lot at night, one car, a guy stuck between two cars". A blockout with ground, ≥2 cars, 1 stick figure appears on both screens, scaled so a car is ~4.5 m long. With no API key, the same prompt still gives a sensible parking lot.

---

## Phase 2 — Shoot a take · `done` (passed on iPhone 14 via cloudflared, 2026-11-03)

- Joystick (left thumb: walk/strafe, right thumb: up/down) integrates position at 1.4 m/s, capped. Speed scale setting (1× life‑size, 3×, 10×).
- Re‑anchor button.
- ● / ■ recording with the take format in ARCHITECTURE.md. Local buffer + IndexedDB + single `take` upload on stop.
- Desk receives take, lists it with duration and sample count, can scrub it.
- 1€ filter on the **live display path only**, defaults `mincutoff=1.0, beta=0.01`. Verify by toggling it: with it off you should see sensor jitter at rest; with it on, rest is calm but a quick flick is not delayed.

**Accept:** Shoot a 20‑second handheld walk‑and‑pan. Desk shows a take of ~1200 samples. Scrubbing replays the exact move including the little wobble at the start. Shoot three takes; all three are there after refreshing the desk page.

---

## Phase 3 — Fix the set · `todo`

- Desk overview: click an object to select, drag on ground plane to move, `R` + drag to rotate about Y, `Delete` deletes. Every change re‑sends `scene` (phone updates live).
- "Edit with words" box: sends `{ prompt, current }` to `/api/scene` so the LLM edits instead of regenerating.
- Undo (10 levels, in memory).

**Accept:** Drag the car 2 m to the left; it moves on the phone within a second. Type "turn the guy to face the camera"; only the stick figure's rotation changes.

---

## Phase 3b — Actors move · `todo`

People in the set can walk, turn and change pose during a take, so you can plan "follow him to the car" shots. The **camera** is still never authored; this only moves the actors.

- Scene format: a stick figure can have `moves`, an ordered list of simple actions, e.g. `{ "do": "walk", "to": [x, z], "speed": 1.4 }`, `{ "do": "turn", "yaw": 1.57 }`, `{ "do": "pose", "pose": "sitting" }`, `{ "do": "wait", "s": 2 }`. Each starts when the previous one ends. No timeline, no keyframes, no curves: actions are described in words and Claude writes them (Phase 3's edit box: "the guy walks to the red car, then sits down").
- Clock: actors stand at their start position until ● is pressed; the take's own `ts` is the actors' clock, so the motion is a pure function of (scene, ts). Takes store nothing new; replay and export recompute it from the scene the take was shot in.
- Phone: actors play live while recording; a **Rehearse** button plays the actions once without recording, then resets.
- Desk: actors move during live view of a recording and during take playback, in sync with the scrub bar.
- Walk looks like walking: a simple procedural leg/arm swing tied to distance covered (not a mocap clip). Constant speed, straight lines between points, turning to face the direction of travel.
- Validator + scene-prompt updated; template scenes stay static.

**Accept:** Type "the guy walks to the red car, then crouches". Press ● on the phone: he starts walking from his spot at a normal pace, reaches the car, crouches. Follow him with the phone. On the laptop, scrub the take: he walks in exact sync with the camera move. Shoot again: he starts over from the beginning. Rehearse plays the same thing without creating a take.

---

## Phase 4 — Export · `todo`

- **JSON**: take + scene in one file.
- **Blender**: `exporters/blender_import.py`, builds scene primitives, creates a camera with a keyframe per sample (converted axes), sets scene FPS to 60 and frame range. Actors with `moves` (Phase 3b) are baked into the same frames from the same shared motion function, so they stay in sync with the camera. The desk's *Blender* button downloads a zip: `take.json`, `scene.json`, `import.py`, `README.txt` with the one command to run.
- **Smoothing on export only**: slider 0–1 maps to 1€ `mincutoff` from 1.0 Hz (raw) down to 0.05 Hz. Default 0. Raw samples untouched in the file.
- **Video reference**: `MediaRecorder` on the POV canvas during playback → `.webm` (Safari: `.mp4` if available). 1080p, 30 fps.

**Accept:** Run the printed Blender command on a fresh Blender 4.x. Press play. The camera moves exactly like the phone did, Z‑up, correct handedness (pan right in reality = pan right in Blender). Export the same take at smoothing 0.8 and confirm the raw JSON is byte‑identical to the 0.0 export's `take.json`.

---

## Phase 5 — Stranger test · `todo`

- Empty‑state copy, onboarding hints on both pages (max three sentences each).
- Error states: no HTTPS (explain, link to tunnel), motion permission denied, phone disconnected (reconnect with backoff, resume room).
- Phone‑only mode: `/cam` without a room shows the prompt box too.
- Deploy to a URL (Vercel for static + a small WS host, or one Fly/Railway box). Update README.

**Accept:** Hand the URL to someone who has never seen it. They finish SPEC flow steps 1–6 in under 5 minutes with no help. Record what confused them into `DECISIONS.md`.

---

## Phase 6 — True walking (optional, later) · `todo`

- Thin Swift app: `WKWebView` loading `/cam` + ARKit session posting `p` and `q` into the page via `window.webkit.messageHandlers`. Same JS, real 6DoF.
- Also: Android Chrome WebXR path in the browser (no app), feature‑detected.

**Accept:** Walk 5 m across a room; the camera moves 5 m in the scene without touching the joystick.
