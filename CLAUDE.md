# HandCam — project instructions for Claude Code

Read `docs/SPEC.md`, `docs/ARCHITECTURE.md` and `docs/PLAN.md` before changing anything. `docs/DECISIONS.md` explains constraints that look odd; do not "fix" them.

## The one rule that defines this product

**The camera move comes from the human hand. We record it, we never author it.**

- Never add easing, splines, keyframe editing, or "cinematic smoothing" to the camera path.
- Only filter sensor noise (1€ filter, `mincutoff ≤ 1 Hz`, `beta ≈ 0.01`) and only on the *raw‑to‑live* path. The recorded take always stores the **unfiltered** samples; smoothing is applied on export, as a user‑controlled 0–1 slider, and never destroys the raw data.
- Micro‑motion is a feature: breathing sway, overshoot‑and‑correct, step bounce. If a change makes a take look like a dolly, revert it.
- If the user wants a different move they re‑shoot, like a real operator. "Takes, not edits."

## Who this is for

Someone who has **never opened Blender** and does not want to. Every UI decision is judged by: *would a person who only knows a phone camera app understand this?* No timeline, no graph editor, no node tree, no "transform" panel. Words we use: shoot, take, set, re‑anchor, export. Words we do not use: keyframe, F‑curve, armature, NLA.

## Stack (do not change without a note in DECISIONS.md)

- Node 18+, plain JavaScript (ESM), no TypeScript, no bundler. `express` + `ws`. That's the whole backend.
- Frontend: vanilla JS + **three.js from a CDN import map** (`public/shared/three.js` re‑exports it). No React, no build step. Pages are `public/index.html` (landing, `public/site/`), `public/desk.html` (the studio, `public/studio/`) and `public/cam.html` (phone). App styling comes from `public/shared/ui.css`.
- Shared code goes in `public/shared/`. Protocol constants live in `public/shared/protocol.js` and are the only source of truth for message shapes.
- Scene description is the JSON in `public/shared/scene-schema.json`. The LLM emits it; both pages render it; the exporter consumes it. Primitives only (box, cylinder, sphere, plane, stickfigure). No GLB loading in v1.
- Exporters are standalone scripts in `exporters/`. Blender exporter must run with `blender --background --python exporters/blender_import.py -- take.json scene.json`.

## Phone facts (iPhone 14, Safari)

- `DeviceOrientationEvent.requestPermission()` must be called from a tap. The page must be served over **HTTPS** or the API is silently unavailable.
- Safari has **no WebXR**, so no positional tracking in the browser. Position comes from the on‑screen joystick (Phase 2) or, later, a native ARKit wrapper (Phase 6, optional). Do not spend time on browser‑based visual odometry unless the user explicitly asks.
- Keep the phone page under ~150 KB of our own JS. It must load on mobile data.

## Working style

- One phase at a time, in `docs/PLAN.md` order. Finish the acceptance test before starting the next phase. The user runs the phone test; ask them for the result rather than assuming.
- Prefer deleting code over adding it. The phone page should be readable top to bottom.
- After each phase: update `docs/PLAN.md` status, add anything surprising to `docs/DECISIONS.md`, commit with a message starting `phaseN:`.
- Don't add dependencies without saying why in the commit message. Current allowed runtime deps: `express`, `ws`. Dev: none required.
- Never commit API keys. `ANTHROPIC_API_KEY` is read from env only; without it, `/api/scene` must still work using the built‑in template scenes.

## Commands

```
npm run dev        # start server on :3000 with auto‑reload
npm test           # run server/*.test.js (node --test). Test files must end in .test.js or node will execute index.js
npm run tunnel     # cloudflared HTTPS tunnel for phone testing
```
