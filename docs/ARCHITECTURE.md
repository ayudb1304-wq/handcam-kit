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
- Draws a small frustum gizmo that follows the live `pose`.
- Drag‑to‑move objects in the overview (Phase 3). Each edit re‑sends `scene`.
- Take list: receives `take` messages, stores in IndexedDB, scrub bar replays the take by driving the gizmo.
- Export (Phase 4): JSON, Blender `.py`, and viewport‑captured MP4 via `MediaRecorder` on the POV canvas.

## Wire protocol (`public/shared/protocol.js` is canonical)

All messages are JSON with a `t` field.

| t | from → to | payload |
|---|---|---|
| `hello` | any → relay | `{ role: 'cam'|'desk', room }` |
| `peer` | relay → any | `{ role, joined: true/false }` |
| `scene` | desk → cam | `{ scene }` (full scene JSON, not a diff) |
| `pose` | cam → desk | `{ ts, q:[x,y,z,w], p:[x,y,z], rec: bool }` |
| `rec` | desk → cam | `{ state: 'start'|'stop' }` (desk can also trigger recording) |
| `take` | cam → desk | `{ take }` (see format below) |
| `anchor` | cam → desk | `{}` informational |

Timestamps are `performance.now()` on the phone, ms, monotonic. The desk never trusts its own clock for take timing.

## Take format (`take.json`)

```json
{
  "id": "2026-11-02T18-04-11Z-a3f9",
  "sceneId": "…",
  "fps_hint": 60,
  "device": { "ua": "...", "source": "gyro+joystick" },
  "samples": [
    { "ts": 0,      "q": [x,y,z,w], "p": [x,y,z] },
    { "ts": 16.6,   "q": [x,y,z,w], "p": [x,y,z] }
  ]
}
```

- `ts` is ms since take start. Irregular spacing is fine and expected.
- `q` is a unit quaternion in three.js convention (Y up, right‑handed, camera looks down −Z).
- `p` is meters, Y up.
- **Samples are raw.** Any smoothing is a property of an *export*, never of the take.

## Scene format (`public/shared/scene-schema.json`)

```json
{
  "id": "…", "units": "m", "prompt": "parking lot…",
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
