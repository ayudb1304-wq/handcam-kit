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

## 17. The set may move; the camera still may not
**Context.** Planning a shot often means following someone. A static set can't rehearse that.
**Decision.** Phase 3b lets objects in the set move (people walk, cars drive, riders are carried, and the camera may *ride along* with one) via a short list of actions written from a sentence. This does not break §1: the rule is about the *camera*, which stays 100 % hand-recorded; riding along only changes what the hand's motion is relative to. To keep the "no keyframes" promise, actions have no times you can drag: each starts when the previous ends, at a real-world speed. Actor motion is recomputed from (scene, take ts) by one shared function, so takes stay raw camera data only.

## 18. Rigs limit the camera while shooting; they are not smoothing
**Context.** People want steadier shots, and the obvious answer (a smoothing slider on the take) breaks §1.
**Decision.** Rigs (handheld, gimbal, tripod, dolly; Phase 4b) constrain which axes the phone may move *at capture time*, exactly like putting a real camera on a real rig. The samples are still the raw, unfiltered result of what the hand did within that limit. Want a different feel? Pick a rig and re-shoot.

## 19. Frame shape and lens are chosen before shooting and recorded with the take
**Context.** AI video tools want 16:9 or 9:16; the phone screen is ~0.46. Exporting a different shape than the operator saw changes the composition after the fact.
**Decision.** The frame (16:9 / 9:16 / 2.39) is picked on the phone before ●, shown while shooting, and stored with the take. Focal length is recorded per sample, so a zoom is a hand-performed move like any other (Phase 4).

## 20. Competitive position (Nov 2026)
Closest competitor is Higgsfield (3D Jutsu: prompt → 3D scene with characters, preset/drawn camera paths, render to AI video; phone camera control only inside Blender). Our edge: the camera is genuinely hand-shot with raw data kept, no 3D software at all, phone-only possible, open exports, works without any vendor. Plan changes that follow from this are in PLAN.md (3b, 4, 4b, 5, 5b, 6, 7); details in `docs/COMPETITORS.md`.

## 21. Export video is rendered frame by frame, not screen-recorded
**Context.** A reference video is only useful if frame *n* shows exactly the camera at time *n*/fps. `MediaRecorder` timestamps frames by the wall clock, so a slow laptop drops or stretches frames.
**Decision.** `shared/export-video.js` renders each frame on its own canvas (sample at or before the frame time, no blending, same as the desk player), encodes it with WebCodecs `VideoEncoder` (H.264 High) at an exact timestamp, and wraps the stream with **`mp4-muxer` 5.2.2 from jsdelivr**, imported only when Export is pressed. It is the first library loaded on demand outside three.js/qrcode: browsers have no built-in MP4 writer, and a hand-written one would be ~150 lines of box layout to maintain. mp4-muxer is marked "superseded by Mediabunny"; it is frozen, MIT and ~70 KB, which suits us better than Mediabunny's larger, fast-moving API. Desk only, so the phone budget is untouched.
- **No WebM / MediaRecorder fallback** (PLAN had one). Chrome, Edge and Safari 16.4+ all encode H.264 with WebCodecs; a fallback would bring back the timing problem above. Unsupported browsers get a plain message.
- **24 fps**, 8 Mbit/s. **1080×1920 or 1920×1080**, picked by how the phone was held. The phone view (~0.46) is not 9:16, so the export keeps whichever fov axis avoids cropping (`exportFov`): it may show a little more at the edges than the phone did, never less. Phase 4's frame picker makes this exact.
- **The video uses the phone's look** (`povStage`: dark background, fog, same lights), not the desk overview's grid. The reference should be what the operator saw. Other looks (floor grid, flat colours) are recipe experiments, not defaults.

## 22. Why export came before Phases 3 and 3b (Nov 2026)
Several products now turn a phone move into an AI-video camera move (Higgsfield's Blender plugin, film-space, GREYSET). The open problem, and the thing we aim to be best at, is getting AI video models to actually *follow* the move. That needs many controlled tests (same set, same start image, same prompt, five standard moves, change one thing at a time), and every test needs a grey video. So Phase 4a goes first; Phases 3 and 3b wait. Test results and the recipe live in `lab/` (this repo is private; move `lab/` out before ever making it public).

## 23. Send to lab writes files only from the laptop, and git does the transport
**Context.** Recipe tests run in a cloud Claude session; takes live in the laptop browser. The server is also reachable through the cloudflared tunnel, so an endpoint that writes files must not be open to anyone with the tunnel link.
**Decision.** `POST /api/lab/take` only accepts loopback requests without proxy headers (`cf-connecting-ip`, `cf-ray`, `x-forwarded-*`; cloudflared connects from localhost too, so the headers are what give it away). It writes plain JSON into `lab/takes/<id>/`, the id restricted to `[A-Za-z0-9._-]`. Pushing is a separate, visible step the user runs (`npm run lab:push`); the server never runs git. `.gitignore`'s old `takes/` rule gets a `!lab/takes/` exception.

## 24. The phone canvas must be sized with width/height, not just inset
**Found (Nov 2026).** `#view { position: fixed; inset: 0 }` does not stretch a `<canvas>`: it is a replaced element, so it keeps its intrinsic size. With `setPixelRatio(2)` on a 2x/3x phone that intrinsic size is twice the screen, so the phone showed the top-left quarter of the view, zoomed 2x. Takes were still recorded correctly (the camera's real fov/aspect), so the desk replay, the export and the scorer were right; only what the operator framed with was wrong. Takes shot before this fix were framed on a zoomed preview.
**Decision.** `width: 100%; height: 100%` on the canvas, with a comment. Any new full-screen canvas needs the same.

## 25. The server now runs AI jobs (an exception to §7)
**Context.** §7 keeps the relay dumb. Making a video needs secrets (the Higgsfield key), long polling, downloads and the scorer, none of which may run in the browser.
**Decision.** `server/make/` runs Make video jobs; the relay itself stays dumb. Jobs are folders on disk (`data/jobs/`), not a database: one laptop, few jobs, and a folder is easy to inspect and delete. When HandCam is hosted for other people this becomes a queue plus storage plus accounts (Phase 5), behind the same routes.

## 26. Recipes are data, on the server only
**Context.** The recipe (model, settings, prompt wording, pass marks) is the product's edge and changes whenever a model updates.
**Decision.** One JSON file per model in `recipes/`, never served to the browser (`publicJob` strips provider URLs and request ids too). Swapping or tuning a recipe needs no code change. Each recipe has `status: draft|final`; the studio labels drafts. Practice mode is just another recipe with the mock provider, so the whole flow is tested without credits.
- The public Higgsfield API's Seedance 2.5 `reference-to-video` takes the picture as a reference image, not a locked first frame (the lab tested the connector's `omni_reference` with `start_image`). The draft recipe uses the API; re-test it there before calling it final.
- Pass marks (turn match, timing, walking) and the 0-100 "move match" are a readable summary of `server/score.py`, not a new measurement. Calibrate on real hand-shot takes.

## 27. Look: a dark studio, a light landing page, one brand
The studio is dark (it's where you look at a lit set and video); the landing page is light and tiled, following the founder's GSCdaddy site (layout, pacing, motion), with HandCam's own copy. Both use Gabarito / Archivo / JetBrains Mono and the terracotta of the Higgsfield-made brand objects. The demo's AI clip is a real Seedance 2.5 result from the lab and is labelled "Example result" in practice mode. Landing pricing is marked draft.

## 28. The landing page shows the product live, in the first seconds
The hero is a live pair: the grey move and the AI video playing in lockstep (the AI video leads; the move follows within 80 ms), with the move-match ring and both camera curves under a moving playhead. On phones it comes straight after the headline, so it is on the first screen. The "Made with HandCam" gallery is data (`public/showcase/examples.json`): each card wipes between the move and the AI video, plays only while visible, and shows the real score. The three current examples are the same lab move run three times (honest: it shows repeatability); they were upscaled 480p → 1080p with Higgsfield's upscaler for display, then encoded at 720×1280. Scores are measured on the original AI output, not the upscale. Autoplay can be blocked (iPhone Low Power Mode): the hero then shows a Play button.


## 29. The Higgsfield API bills dollars, not plan credits
Found 2026-11-05: Make video uses Higgsfield's API platform (open.higgsfield.ai), a separate pay-as-you-go balance in USD. The Pro plan's monthly credits are never touched (the CLI's `account status` shows plan credits, not the API balance). Measured on the API bill: Seedance 2.5 reference-to-video at 480p is $0.88 for 5 s and $1.00 for 6 s (~$0.17/s); the first-frame image is $0.04. 720p/1080p are scaled by Higgsfield's own credit ratios (42/18, 96/18) until measured. `recipes/*.json` `qualities` hold USD per second, and the studio shows the real dollar cost before Make video.

## 30. You choose the number of versions; under 70% move match is free
Make video no longer decides on its own to make an extra version: you pick 1 to 4 versions (default 2), and that is exactly what is made and paid for. Each version under 70% move match (`FREE_BELOW_MATCH` in `server/make/recipe.js`) is marked free, meaning a customer is not charged for it; if the kept version is under 70% the studio says so and offers "Try again" (one more version). Each job records `billing` (versions made, charged, free, AI cost). No payments exist yet; this is the rule they will use. Two things must hold before charging anyone: the score must be trustworthy (walk-only takes currently score ~58% when they followed, see lab/recipe.md rule 10), and a free version must not be downloadable in full, or free videos become a way to get AI video for nothing.

## 31. A set edit is a new version, not an overwrite
Phase 3 edits (drag, turn, delete, words) never change a saved set in place: each one is saved as a new scene `id` with the same `setId`. A take records the `sceneId` it was shot in, so replay, export and Make video always show the set exactly as it was when the take was shot, even after later edits. The phone keys re-anchoring on `setId`, so laptop edits during a shoot don't teleport the camera. "Edit with words" sends the whole current set to Claude and asks for only that change; without an API key it returns the set unchanged with a note (a template would throw the user's set away).

## 32. Set motion is data plus one pure function
Phase 3b moves the set, never the camera. Motion lives in the scene as simple actions Claude writes from words (no timeline, no keyframes), and `shared/motion.js` turns (scene, ms) into positions with no three.js, so it is unit-tested and the same numbers drive the phone, desk, exporter and Blender. Learned while testing: Claude sometimes forgot `moves` on the vehicle (only gave the driver `on`) and swapped a car's size to lay it along x instead of rotating it; the prompt now says every described mover must have moves and vehicles are always length-along-z, pointed with `rot`. Claude also once wrote prose after the JSON, so the reply parser now reads the first balanced JSON object instead of first-`{`-to-last-`}`. Riding with a vehicle you're far from (> 6 m) starts you just ahead of it, facing it, which is the "driver through the windscreen" shot.

## 33. Lens, frame and the Blender bundle
The zoom is a full-frame lens size recorded per sample (`f`), with the frame's long side = 36 mm, so "24 mm" means the same in HandCam, Blender (`sensor_width 36`, `sensor_fit AUTO`) and on a real camera. The phone draws exactly the chosen frame with bars, so what you frame is what exports. The Blender export is a folder (zip) rather than a .blend: the desk can't run Blender, so it ships the data and `import.py`; the set's motion is baked by the desk from `shared/motion.js` into `motion.json` (one source of truth), and stick-figure joints come from `shared/stickfigure.js` via `figures.json`. In Blender, moving figures glide and switch pose (one child group per pose, visibility keyed); the leg swing is not baked (previs only needs where they are). Smoothing never touches `take.json`: a smoothed export adds `camera.json`. The JS module-scope name `frame` was already the phone's draw loop: a `let frame` setting broke the whole page with a SyntaxError, caught in Chrome; the setting is `shotFrame`.
