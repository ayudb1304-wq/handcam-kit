# Build plan

Each phase ends with an **acceptance test you run with your own iPhone**. Do not start the next phase until it passes. Status: `todo | doing | done`.

Order: 0 → 1 → 2 → **4a** → 3 → 3b → 4 → 4b → 5 → 5b → 6 → 7. Why the later phases look the way they do: `docs/COMPETITORS.md`.

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

## Phase 3 — Fix the set · `built` (2026-11-05, checked in Chrome with a simulated phone; waiting for your laptop + iPhone test)

- Desk overview: click an object to select, drag on ground plane to move, `R` + drag to rotate about Y, `Delete` deletes. Every change re‑sends `scene` (phone updates live).
- "Edit with words" box: sends `{ prompt, current }` to `/api/scene` so the LLM edits instead of regenerating.
- Undo (10 levels, in memory).

**Accept:** Drag the car 2 m to the left; it moves on the phone within a second. Type "turn the guy to face the camera"; only the stick figure's rotation changes.

---

## Phase 3b — Things move · `built` (2026-11-05, checked in Chrome with a simulated phone; waiting for your iPhone test)

People walk, cars drive, someone rides in the car, and the camera can ride along, so you can plan "follow him to the car" and "frame the driver through the windscreen" shots. The **camera** is still never authored: your hand records it; this phase only moves the set (DECISIONS §17).

- **Moves on any object.** Optional `moves` on any object: an ordered list of simple actions, each starting when the previous ends: `{ "do": "go", "to": [x, z], "speed": 1.4 }` (walk/drive in a straight line, turning to face the way it travels), `{ "do": "turn", "yaw": 1.57 }`, `{ "do": "pose", "pose": "sitting" }` (stick figures only), `{ "do": "wait", "s": 2 }`. Several `go` steps make a curve. No timeline, no keyframes, no draggable times: Claude writes the actions from words ("the car drives to the corner at 30 km/h, then stops").
- **Riding.** Optional `on: "<object id>"`: the object is carried by another, using its offset at rest (a driver in a car, a passenger on a bus). One level deep is enough.
- **Ride-along camera.** On the phone, *Ride with…* picks a moving object. Your hand and the joysticks then move the camera relative to it while it travels. The take still stores the final world position per sample, so replay and export need nothing special.
- **Clock.** Everything waits at its start until ● is pressed; the take's `ts` is the set's clock. Motion is a pure function of (scene, ts) in one shared module, so takes stay camera-only and the desk/exporter recompute the set.
- **Rehearse** on the phone plays the set's motion once without recording, then resets.
- **Desk** shows set motion live during a recording and during take playback, in sync with the scrub bar.
- Walking stick figures swing legs/arms by distance covered; vehicles just glide (no wheels, no physics).
- Claude lays out longer roads/paths when the prompt involves travel. Templates stay static.

**Accept:** Type "a guy drives a car down the street past two parked cars". Choose *Ride with: car*, press ●, frame the driver through the windscreen while the street slides past; stop. On the laptop, scrub: car, driver and camera move in exact sync. Then type "the guy walks to the red car, then crouches", press ●, follow him on foot; he starts over on every take. Rehearse plays without creating a take.

---

## Phase 4a — Export video (pulled forward) · `doing` (built 2026-11-04; waiting for the iPhone test)

Pulled out of Phase 4 so the AI-video tests can start: every recipe test needs a grey video of a take, and nothing else in Phases 3–4 blocks that. Why: DECISIONS §21–22.

- Desk: **Export video** under the take player. Renders the take frame by frame (24 fps), in the phone's look, at 1080×1920 if the phone was upright or 1920×1080 if sideways. Never crops what was framed; may show a little extra at the edges until Phase 4 adds the frame picker.
- Downloads the MP4 and a PNG of its first frame. Notes when a take is under 3 s (Kling's minimum) or over 10 s.

**Accept:** Shoot a ~6 s take with one fast whip-turn. Export it. The MP4 opens in QuickTime, lasts as long as the take, and the whip lands at the same second it did when you shot it. The PNG matches the video's first frame. Upload both to Seedance or Kling: the files are accepted.

---

## Make video + studio · `doing` (built 2026-11-04; waiting for the recipe and the laptop test)

Built ahead of the recipe so it's plug and play when the recipe is final (DECISIONS §25-26).
- Engine: recipes as server-side files, job runner (first frame → your OK → versions → move check → best), Higgsfield API adapter, practice mode, scorer in the app.
- Studio redesign (Set → Shoot → Takes → Make video), result screen (your move and the AI video side by side, move match), demo take with a real example result, first-run tour.
- Phone camera screen polish. Landing page.

**Accept:** On the laptop, open `/desk`, take the tour, load the demo take, Make video in Practice: you approve the first frame and get the result with a move-match score (needs `pip3 install opencv-python-headless numpy`, otherwise "not checked"). Then shoot a real take with the phone and do the same. With `HF_API_KEY_ID/SECRET` in `.env`, choose Seedance 2.5 and get a real video.
**Still needs you:** the final recipe (then set `"status": "final"` in `recipes/seedance-2.5.json`), pricing, and hosting/accounts for a public launch (Phase 5).

---

## Phase 4 — Frame, lens and export · `built` (2026-11-05, checked in Chrome; the Blender import is untested because Blender isn't installed on the laptop)

Two parts: shoot in the shape and lens the final video needs, then export it in forms AI video tools and Blender take directly.

**Frame and lens (phone)**
- Choose the output frame before shooting: **16:9, 9:16, 2.39:1** (default 16:9). The phone shows exactly that frame (bars outside it); the desk frustum and inset match.
- **Zoom slider** labelled in full-frame lens sizes (16–135 mm, default 24 mm). The value is recorded **per sample** like position and rotation: a zoom is performed by hand, never added later.
- Take format gains `frame` (aspect) and per-sample focal length; ARCHITECTURE.md updated.

**Export (desk)**
- **Video reference for AI video**: renders the take's camera view of the grey set (no outlines/labels), at the take's frame, in sizes the major models accept (1920×1080 / 1080×1920 / 1920×804), 24 or 30 fps, as `.mp4` (`.webm` fallback). Also a **first-frame PNG** for image-to-video, and a short **ready-to-paste prompt** describing the move and set ("handheld, slow push-in toward a man between two cars at night…").
- **JSON**: take + scene in one file.
- **Blender**: `exporters/blender_import.py` builds scene primitives, creates a camera with a key per sample (converted axes) including focal length, sets FPS and frame range. Set motion from Phase 3b is baked from the same shared function. The desk's *Blender* button downloads a zip: `take.json`, `scene.json`, `import.py`, `README.txt` with the one command to run.
- **Smoothing on export only**: slider 0–1 maps to 1€ `mincutoff` from 1.0 Hz (raw) down to 0.05 Hz. Default 0. Raw samples untouched in the file.

**Accept:** Shoot a 16:9 take with a zoom from 24 to 50 mm. The phone showed a 16:9 frame; the exported MP4 matches what you framed, frame for frame, including the zoom. Upload the MP4 (and first-frame PNG) to Seedance or Kling as a motion reference; the generated shot follows your move. Run the printed Blender command on a fresh Blender 4.x and press play: same move, Z-up, pan right stays pan right, the lens changes on the same frames. Export at smoothing 0.8 and confirm `take.json` is byte-identical to the 0.0 export's.

---

## Phase 4b — Rigs and take review · `todo`

Steadier shots without smoothing, and the tools directors use to pick the take.

- **Rigs** on the phone: **Handheld** (everything free, default), **Gimbal** (roll held level), **Tripod** (position locked; pan, tilt, zoom only), **Dolly** (position moves only along the line you're facing when ● is pressed). A rig is a limit applied *while shooting*, like a real rig, and saved with the take (`rig`). The recorded samples are still exactly what the camera did. It is not smoothing (DECISIONS §18).
- **Star** a take (the "circled take"); starred first in the list. Rename takes.
- **Compare** two takes side by side on the desk, scrubbing together.
- **Ghost**: while shooting, optionally show the previous take's camera as a faint outline on the desk and a faint path on the phone, to beat or match it.

**Accept:** Shoot the same push-in handheld, on gimbal and on tripod. Gimbal take: horizon never rolls but tilt/pan wobble remains. Tripod take: position never changes. Star the best one; compare it with the handheld take side by side; the ghost of the last take is visible while shooting the next.

---

## Phase 5 — Stranger test, phone-only, deploy · `todo`

- **Phone-only mode is a headline feature**, not a fallback: `/cam` without a room shows the prompt box, builds the set, shoots, lists takes and exports, all on the phone. No laptop, no 3D software. (Every competitor needs a desktop or Blender; see COMPETITORS.md.)
- Empty-state copy, onboarding hints on both pages (max three sentences each).
- Error states: no HTTPS (explain, link to tunnel), motion permission denied, phone/desk disconnected (reconnect with backoff, rejoin the room, resend takes the desk never got).
- **Before going live: never show customers our AI cost.** The studio's Make video cost line and result line show the real Higgsfield dollar cost (`costLine()` and `billLine` in `public/studio/make.js`; `job.billing.apiUsd`). That is for the founder only. For customers, show the price in our own unit (videos or credits from their plan, DECISIONS §30), never `$` of AI cost; keep `apiUsd` server-side for our own margin tracking.
- Before charging: fix the walk-only false fail (lab/recipe.md rule 10) and make free (under 70%) versions preview-only or watermarked (DECISIONS §30).
- Deploy to a URL. Constraints from DECISIONS §15: one always-on host for the WebSocket relay (or an external room store), and `/api/scene` protected (rate limit + per-browser quota or a passcode) before the URL is public. Update README.

**Accept:** Hand the URL to someone who has never seen it, phone only. They describe a set, shoot a take and export the video in under 5 minutes with no help. Then repeat with phone + laptop (SPEC flow steps 1–6). Record what confused them in `DECISIONS.md`.

---

## Phase 5b — Shots and sequences · `todo`

Plan a whole scene, not just one move.

- A set can hold several **shots**: each is a take (or empty slot) with a name and an order ("1 wide", "2 push-in", "3 OTS").
- **Sequence view** on the desk: shots play back to back, cut at chosen in/out points within each take (trimming, not editing the move), forming an animatic.
- Export the sequence as one video reference plus one JSON, and to Blender as one camera per shot with markers to cut between them.

**Accept:** Shoot three takes in one set, assign them to shots 1–3, trim each, play the sequence: it cuts between your three hand-shot moves in order. The exported video plays the same cut.

---

## Phase 6 — True walking · `todo`

Raised from "optional": every hand-held competitor has positional tracking (VirtuCamera, Jetset, VRL Cam, Unreal VCam), so it matters more than first planned.

- Thin Swift app: `WKWebView` loading `/cam` + ARKit session posting `p` and `q` into the page via `window.webkit.messageHandlers`. Same JS, real 6DoF. Joystick and walk scale (1×/3×/10×) still apply on top.
- Also: Android Chrome WebXR path in the browser (no app), feature-detected.

**Accept:** Walk 5 m across a room; the camera moves 5 m in the scene without touching the joystick. At 10× scale, the same walk moves 50 m.

---

## Phase 7 — Send to an AI video service (optional) · `todo`

- From the export panel, optionally send the video reference + first frame + prompt (+ the user's own reference images) to a video model service, e.g. Higgsfield / Seedance or Kling, and show the result next to the take.
- Strictly optional: plain file export (Phase 4) stays the default, nothing requires an account with any vendor, and the app works the same without it.

**Accept:** One click from a starred take produces a generated video that follows the hand-shot move; with the integration switched off, nothing else in the app changes.
