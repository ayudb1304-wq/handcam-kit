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
