# Architecture

```
 ┌────────────────┐    ws (pose 60Hz)     ┌─────────────┐     ws      ┌────────────────┐
 │  PHONE (cam)   │ ───────────────────▶  │   RELAY     │ ─────────▶  │  LAPTOP (desk) │
 │ public/cam.html│ ◀───────────────────  │ server/     │ ◀─────────  │public/desk.html│
 │ gyro, joystick │   scene, rec cmds     │ express+ws  │  scene,rec  │ prompt, overview│
 │ three.js POV   │                       │ rooms by code│            │ takes, export   │
 └────────────────┘                       └──────┬──────┘            └────────────────┘
                                                 │ POST /api/scene (optional LLM)
                                                 ▼
                                          Anthropic API  (or built‑in templates)
```

Three pieces, one repo, one `npm run dev`.

## 1. Relay (`server/index.js`)

- Serves `public/` statically.
- `GET /api/info` → `{ publicUrl, lanUrl, room }` so the desk can draw a QR.
- `POST /api/scene { prompt, current? }` → scene JSON. If `ANTHROPIC_API_KEY` is set, calls Claude with `server/scene-prompt.md` as the system prompt and validates the result against `public/shared/scene-schema.json`. If not set, or on any failure, returns the closest **template scene** from `server/templates/*.json` (keyword match) so the app always works offline.
- WebSocket at `/ws`. First message must be `hello`. Rooms are 4‑letter codes. The relay does no processing: it forwards every message from `cam` to all `desk` sockets in the room and vice versa. Stateless on purpose.

## 2. Phone page (`public/cam.html`)

- Joins room from `?room=XXXX`.
- **Enable motion** button → `DeviceOrientationEvent.requestPermission()` → `deviceorientation` listener → quaternion (see `shared/orientation.js`). Fuse with `screen.orientation.angle`.
- Renders the scene from the camera POV with three.js. Camera quaternion = phone quaternion. Camera position = joystick‑integrated position (Phase 2) at eye height from `scene.spawn`.
- **Re‑anchor** button: sets current heading as "forward" (yaw offset) and snaps position to `scene.spawn`. This is how drift is handled. There is no other drift correction in v1.
- **Record** ●/■: while recording, every `pose` sample is pushed to a local array **and** sent live. On stop, the full take is sent once as `take` (so a dropped packet never loses data) and also saved to IndexedDB.
- Sends `pose` at the sensor rate (~60 Hz) throttled to 60.

## 3. Desk page (`public/desk.html`)

- Prompt box → `/api/scene` → renders the blockout in an overview (OrbitControls) and sends `scene` to the room.
- Draws a small frustum gizmo that follows the live `pose`, shaped by the phone's `fov`/`aspect`.
- `/desk?room=XXXX` reuses a room code (default: the server's room).
- **Fix the set** (Phase 3, `studio/editor.js`): click an object (not floors) to select it, drag to move it on the ground, hold R + drag to turn it, Delete removes it, ⌘Z / Undo (10 levels). "Change" sends `POST /api/scene { prompt, current }` and Claude edits that set. Every change is a new **version** of the set: new `id`, same `setId`, saved in IndexedDB, so older takes replay in the version they were shot in. The phone re-anchors only when `setId` changes, so an edit never moves the person shooting. While dragging, drafts are sent ~10×/s so the phone follows live. The desk reopens the last set from IndexedDB instead of rebuilding it (no AI call per reload).
- Take list: receives `take` messages, stores in IndexedDB, scrub bar replays the take by driving the gizmo.
- **Export video** (Phase 4a, `shared/export-video.js`): renders the selected take frame by frame on its own canvas in the phone's look (`povStage`), encodes H.264 with WebCodecs and wraps it as MP4 with `mp4-muxer` (CDN, loaded on first export). Downloads `handcam-<take id>.mp4` and `…-first-frame.png`. Frame/time math is in `shared/frames.js` (tested in `server/frames.test.js`).
- **Lab** (recipe tests, not a product feature): each take can be named with one of the test shots (`SHOTS` in `protocol.js`, stored as `take.label`) and **Send to lab** posts `{ take, scene }` to `POST /api/lab/take`, which writes `lab/takes/<take id>/take.json` + `scene.json`. Accepted only from the laptop itself (`server/lab.js` `isLocal`), never through the tunnel. `npm run lab:push` commits and pushes `lab/takes/`. In the cloud, `lab/tools/render.mjs` re-renders any lab take with the same exporter.
- Still to come (Phase 4): JSON and Blender buttons.

## 4. Make video (`server/make/`, `recipes/`)

The one place the server does real work (DECISIONS §25). The studio renders the take's grey reference + first frame and its speckled measuring twin in the browser, uploads them, and polls a job:

```
POST /api/make {take, scene, look, recipeId, demo}   → job (status uploading)
PUT  /api/make/:id/files/{reference.mp4|measure.mp4|first-frame.png}
POST /api/make/:id/start      → upload to the provider, make the start image → needs_approval
POST /api/make/:id/approve {n} → make `candidates` versions → score each (server/score.py) → keep the best; one extra try if none passes
POST /api/make/:id/redo-start {look} · POST /api/make/:id/more · GET /api/make/:id · GET /api/make/:id/media/:file
```

- **Recipes** (`recipes/*.json`, server-only): provider, endpoints, input templates (`{{look}}`, `{{startImageUrl}}`, `{{referenceUrl}}`, `{{firstFrameUrl}}`, `{{durationS}}`, `{{aspect}}`, `{{demo}}`), where the output URL is, versions to make, pass marks, cost estimate. `practice.json` (mock provider) and `seedance-2.5.json` (Higgsfield, draft).
- **Providers**: `higgsfield.js` (docs.higgsfield.ai: `Authorization: Key id:secret`, presigned uploads, `Idempotency-Key` per generation, polling with backoff), `mock.js` (practice; for the demo take it returns the real example result in `public/demo/`).
- **Jobs** live in `data/jobs/<id>/` (gitignored): `job.json` (written atomically) + files. Interrupted jobs resume after a restart (practice jobs fail instead).
- Laptop-only (`isLocal`), like Send to lab, until there are accounts. Provider URLs and request ids never reach the browser.

## 5. Pages

- `/` → `public/index.html` + `site/`: the landing page (light, tiled). Product shots in `assets/shots/` are real screenshots of the studio.
- `/desk` → `desk.html` + `studio/` (main, make, tour) + `shared/ui.css` (design system).
- `/cam` → `cam.html` (phone).
- Brand assets in `assets/` were generated with Higgsfield (GPT Image 2.5).

## Wire protocol (`public/shared/protocol.js` is canonical)

All messages are JSON with a `t` field.

| t | from → to | payload |
|---|---|---|
| `hello` | any → relay | `{ role: 'cam'|'desk', room }` |
| `peer` | relay → any | `{ role, joined: true/false }` |
| `scene` | desk → cam | `{ scene }` (full scene JSON, not a diff) |
| `pose` | cam → desk | `{ ts, q:[x,y,z,w], p:[x,y,z], rec: bool, fov, aspect }` (fov/aspect = the phone's view, so the desk frustum matches what the phone shows; not stored in takes) |
| `rec` | desk → cam | `{ state: 'start'|'stop' }` (desk can also trigger recording) |
| `take` | cam → desk | `{ take }` (see format below) |
| `anchor` | cam → desk | `{}` informational |

`pose.ts` is always `performance.now()` on the phone (ms, monotonic), recording or not; only samples inside a take are relative to take start. The desk never trusts its own clock for take timing.

## Take format (`take.json`)

```json
{
  "id": "2026-11-02T18-04-11Z-a3f9",
  "sceneId": "…",
  "fps_hint": 60,
  "view": { "fov": 60, "aspect": 0.59 },
  "device": { "ua": "...", "source": "gyro+joystick" },
  "samples": [
    { "ts": 0,      "q": [x,y,z,w], "p": [x,y,z] },
    { "ts": 16.6,   "q": [x,y,z,w], "p": [x,y,z] }
  ]
}
```

- `label` (optional, desk only): which lab test shot this is, one of `SHOTS` in `protocol.js`.
- `ts` is ms since take start. Irregular spacing is fine and expected. One sample per rendered frame, capped at 60 Hz.
- `view` is the phone camera's vertical fov (degrees) and aspect (w/h) while shooting. Exporters use it for the lens.
- `q` is a unit quaternion in three.js convention (Y up, right‑handed, camera looks down −Z).
- `p` is meters, Y up.
- **Samples are raw.** Any smoothing is a property of an *export*, never of the take.

## Scene format (`public/shared/scene-schema.json`)

```json
{
  "id": "scene-…", "setId": "scene-…", "units": "m", "prompt": "parking lot…",
  "spawn": { "p": [0, 1.6, 6], "yaw": 0 },
  "objects": [
    { "id": "ground", "type": "plane", "size": [40, 40], "color": "#2b2b2b" },
    { "id": "car1", "type": "box", "p": [2,0.7,0], "rot": [0,0.1,0], "size": [1.8,1.4,4.4], "color": "#6b7a8f", "label": "car" },
    { "id": "guy",  "type": "stickfigure", "p": [1,0,0], "rot": [0,1.57,0], "height": 1.75, "pose": "standing" }
  ]
}
```

Types: `plane`, `box`, `cylinder`, `sphere`, `stickfigure`. `stickfigure.pose ∈ {standing, sitting, lying, crouching}`; it is built from capsules/cylinders in `shared/stickfigure.js` and the same builder is mirrored in the Blender exporter.

## Coordinate conventions (write them once, here)

- Web: three.js default. Y up. 1 unit = 1 m. Camera looks −Z.
- Blender: Z up, camera looks −Z in its local frame. Exporter converts: `(x, y, z)_three → (x, −z, y)_blender`, quaternion rotated by a fixed 90° about X. See `exporters/blender_import.py` `three_to_blender()`.

## Latency budget

gyro event (≈16 ms) → quaternion math (<1 ms) → ws send → relay forward → desk render next frame (≤16 ms). Same‑Wi‑Fi total ≈ 35–50 ms. Over a cloudflared tunnel expect 80–150 ms; fine for shooting (the phone POV is local and has zero latency), slightly laggy for the desk gizmo, acceptable.
