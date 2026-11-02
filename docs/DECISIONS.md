# Decisions (ADR‑style, short)

Add to this file whenever a choice would look strange to a newcomer.

## 1. Record raw, never author curves
**Context.** Every existing vcam tool eventually grows a curve editor and "steadicam" smoothing, and takes start looking like dollies.
**Decision.** Takes store unfiltered samples. Smoothing exists only as a per‑export parameter. There is no keyframe editing UI and there will not be one.
**Consequence.** Bad take → re‑shoot. That's intended; it keeps the hand in the loop.

## 2. 1€ filter, live path only
**Context.** Raw gyro has ~0.1° jitter at rest that looks like a vibrating camera on the desk gizmo.
**Decision.** Apply a 1€ filter (`mincutoff 1 Hz, beta 0.01`) only to what is *displayed live*. It adds near‑zero lag on fast moves and calms rest. Recorded data bypasses it.
**Why 1€ and not EMA.** EMA either lags fast moves or lets jitter through; 1€ adapts cutoff to speed.

## 3. iPhone (Safari) gets rotation only, in the browser
**Context.** Safari on iOS has no WebXR and no ARKit access from a web page (still true as of 2026). Only `DeviceOrientationEvent` is exposed, and only over HTTPS after a tap‑to‑permission.
**Decision.** v1 = gyro for rotation + on‑screen joystick for position. True walking is Phase 6 via a thin native wrapper (ARKit → WKWebView bridge) or Android Chrome WebXR.
**Rejected.** Browser visual odometry from the rear camera (what PocketCam does). Weeks of work, drifts, and the joystick covers 90% of real shots which are wrist‑driven anyway.

## 4. Primitives only, no GLB
**Context.** The user never sees Blender, so asset fidelity doesn't help them; the scene is a *blockout* for camera planning.
**Decision.** plane/box/cylinder/sphere/stickfigure. Keeps the LLM output small and reliable and the phone page fast.
**Consequence.** Cars are boxes with four cylinders. That's fine; label them.

## 5. LLM is optional at runtime
**Context.** A product that dies without an API key can't be demoed on a plane or by a friend.
**Decision.** `/api/scene` falls back to keyword‑matched template scenes. The UI labels the result "template" vs "ai".

## 6. No build step, CDN three.js, two HTML files
**Context.** Audience is non‑developers who will run `npm run dev` once. Claude Code iterates faster on plain files.
**Decision.** Vanilla ESM + import map. Revisit only if the phone page exceeds ~150 KB of our own JS.

## 7. Relay is dumb
**Context.** Any server‑side processing adds latency and a second place for bugs.
**Decision.** The WebSocket relay only forwards messages by room. All state lives in the two browsers (IndexedDB) and in downloaded files.

## 8. HTTPS via cloudflared for local testing
**Context.** iOS refuses motion data on http://192.168.x.x.
**Decision.** `npm run tunnel` wraps `cloudflared tunnel --url`. Alternative: mkcert + trust the cert on the phone (more steps). Production is just a normal HTTPS host.

## 9. Coordinate conversion lives in exactly one function
**Context.** Three.js is Y‑up, Blender Z‑up; handedness bugs are the #1 way vcam exports go wrong.
**Decision.** `three_to_blender()` in `exporters/blender_import.py`, with a self‑test asserting "pan right stays pan right". Nothing else converts axes.

## 10. Words
We say: set, shoot, take, re‑anchor, export, blockout.
We don't say: keyframe, F‑curve, armature, viewport, transform, NLA, rig.

## 11. Cars are one box, not a box plus four wheels
**Context.** SPEC says "cars are boxes with wheels", but the scene format has no grouping. Five loose objects per car means dragging the car in Phase 3 leaves its wheels behind.
**Decision.** A car is one labelled box (1.8 × 1.4 × 4.5 m). Revisit only if the scene format gets groups.

## 12. Claude call: raw fetch, structured output, Sonnet, low effort
**Context.** No new deps allowed, and the user is waiting on the build button (SPEC: ~5 s).
**Decision.** `server/scene.js` calls the Messages API with `fetch`, model `claude-sonnet-5-5` (override with `ANTHROPIC_MODEL`), effort `low` (~5 s). The schema is pasted into the system prompt; we do **not** use the API's `json_schema` structured output. Measured on the Phase 1 prompt: with structured output Claude returned 1–3 objects (just ground planes); without it, 12 objects. The result is checked by `server/validate-scene.js`, which also enforces what the schema can't (unique ids, size length per type); fields that don't apply to a type (e.g. `pose` on a box) are dropped first rather than failing the scene. Any failure (refusal, timeout, bad JSON, invalid scene) falls back to a template; the reason goes back as `note` and shows as a tooltip on the desk label.

## 13. The phone gets its set only from the desk
The Phase 0 phone page fetched a parking-lot template on its own, which flashed the wrong set before the desk's arrived. Removed: the desk sends `scene` on every build and whenever the phone joins. Phone-only mode (Phase 5) will add a prompt box to the phone instead.

## 14. API key from env or a local `.env`
`server/index.js` loads `.env` (gitignored) with Node's built-in `process.loadEnvFile` if the file exists. No dotenv dependency. On Node < 20.12 use `export ANTHROPIC_API_KEY=…`.

## 15. Not on Vercel (yet)
**Context.** Vercel Functions do support WebSockets, but with no instance affinity: the desk and phone can land on different instances, so the in-memory room map in the relay silently fails to pair them. Connections also close at the function's max duration (300 s on Hobby).
**Decision.** Test over the cloudflared tunnel. Pick the Phase 5 host knowing this: Vercel needs an external store (e.g. Redis) for rooms plus client reconnect, which breaks §7 "relay is dumb" and the no-new-deps rule; a single always-on Node host (Fly/Railway/Render) runs the relay unchanged. Either way `/api/scene` needs protecting before a public URL exists, or anyone with the link spends the API key.

## 16. Phase 2 details that look odd
- **One sample per rendered frame, not per sensor event.** Position comes from the joystick integrated per frame, so a frame is the natural unit; rotation is the latest sensor reading at that frame. The cap is 60 Hz with 4 ms slack (`SAMPLE_MS`), because rAF timestamps jitter around 16.67 ms and a strict `>= 16.67` silently dropped about half the frames.
- **The phone view is not filtered at all.** The 1€ filter runs only on the desk's live gizmo. The phone screen is what the operator frames with; any lag there would change the hand's behaviour.
- **The 1€ filter on rotation is a slerp with angular speed in degrees/s** (`shared/one-euro.js`), so `beta = 0.01` has a useful effect. Position is not filtered (joystick, no sensor noise).
- **Joystick movement ignores tilt.** Walking follows the camera's heading (yaw from a YXZ Euler), so looking down while walking doesn't drive you into the floor. Height has a 0.1 m floor.
- **Re-anchor happens automatically** on the first motion reading and whenever a new set arrives, so you start facing the set; the button does the same on demand.
- **Desk playback shows samples exactly, no blending between them** (last sample at or before the playhead). The inset renders the take's own camera with its recorded fov/aspect.
- **A take that finishes while the desk is disconnected stays only on the phone** (IndexedDB). Resending is left for Phase 5's reconnect work.
