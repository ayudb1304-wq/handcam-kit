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
- **One sample per sensor reading, not per rendered frame** (revised 2026-11-09). It used to be one per frame, assuming 60 frames a second. A real iPhone 14 take (21 s, 626 samples) showed the phone drew only 30 frames a second (Low Power Mode or a heavy set), with stalls up to 176 ms, so half the motion readings of a fast whip were thrown away. Now every `deviceorientation` reading is a sample at its own timestamp (about 60 a second); the joystick walk is integrated up to that moment (`advance`, shared with frames so nothing is counted twice). Frames still record when a tracker (ARKit/WebXR) or a ride drives the camera, or when the sensor goes quiet for 40 ms. Each take stores `device.rates` (sensorHz, frameHz, samplesHz) so the next phone test shows the real numbers. Nothing is filtered: samples are exactly what the view used. `SAMPLE_MS` now only paces the live pose sent to the desk.
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

## 34. Accounts and money without a database or an SDK
Phase 5 needed accounts and payments for a friend test, with `express` + `ws` still the only runtime dependencies. Accounts are one JSON file under `DATA_DIR`, written atomically and kept in memory (fine for one server and hundreds of users; move to a database when that stops being true). Passwords use `crypto.scrypt`; sessions are an HMAC-signed HttpOnly cookie (`userId.expiry.mac`), no session table. Balances are in **videos**; prices are placeholders in `config/pricing.json` (480p = 1, 720p = 2, 1080p = 5, doubled over 8 s; packs 10 for $29, 30 for $79; 1 free on sign-up). Make video reserves `versions × unit` on approval and refunds free (< 70% move match) and failed versions when the job settles, so a customer never pays for a video that didn't follow their move. Dodo Payments through `fetch`: checkout sessions; the return page confirms with `GET /payments/{id}` (never the URL's `status`), and an optional Standard Webhooks endpoint does the same; both credit once per payment id. Real AI for customers is off unless `REAL_AI=on`, because each real video spends the founder's Higgsfield API dollars. The laptop running HandCam (`isLocal`) is the founder: no account, real AI, dollars shown. `LOCAL_IS_CUSTOMER` and `PRACTICE_CHARGES` exist to test the customer path for free.

## 35. Free versions are previews, not files
A version under the move-match line costs the customer nothing, so it must not be a free AI video: customers get a dimmed four-frame strip with a "not charged" watermark (`server/preview.py`, OpenCV), and the media route refuses the MP4. The founder still sees everything.

## 36. Shot lists in their own IndexedDB database
Adding a store to the `handcam` database needs a version upgrade, and an upgrade waits until every open tab on the old version lets go. While testing, a frozen phone tab and an old desk tab blocked it, so nothing loaded. Sequences now live in a separate `handcam-sequences` database (no upgrade ever needed), and every page now closes its connection when a newer page asks for an upgrade.

## 37. True walking is a bridge, not a second app
Phase 6 adds `window.handcamPose(p, q)` to the phone page. The iPhone wrapper (`ios/`, ARKit, a WKWebView on the same page) and Android Chrome's WebXR both feed it; the page keeps rendering the set itself, re-anchors heading and position as before, applies the speed scale and rigs, and lets the sticks add on top. So there's one camera path to keep right, and the page works unchanged without a tracker.

## 38. Plans: subscriptions with monthly videos, re-costed from the strategy doc
**Context.** The founder chose the structure in the "SaaS Pricing Strategy for HandCam Kit" doc: Free / Indie / Creator / Studio, Lifetime, top-ups, gates on Blender export, a watermarked trial, own-key AI. That doc assumed an AI render costs $0.25–0.35; our bill says ~$1.36 per charged video (§29–30), so its allowances (15 / 60 / 200) would lose money.
**Decision.** Prices and plan names as in the doc; monthly videos scaled to 5 / 15 / 40 so each plan earns 55–61% at full use and ~71–75% at typical use. Full table and every lifecycle rule: `docs/PRICING-PLAN.md`. Things that look odd:
- **The unit stays "videos"**, not credits (§30, PLAN Phase 5). One video = a 480p version up to 8 s.
- **Plan videos reset from the subscription's start day, computed on each request** (`plans.cycleOf`), not by a renewal webhook or a timer. Yearly plans reset monthly the same way; a missed webhook can't freeze or gift a month. Dodo's billing dates only decide the paid-through date.
- **An upgrade keeps this month's used videos**, so the difference is available at once; a downgrade is scheduled with Dodo's `effective_at: next_billing_date`; cancelling keeps the plan to the paid-through date.
- **Videos come back to where they came from** (trial, top-up or plan, last taken first). If that month is over they come back as top-ups, so nobody loses a video they didn't get.
- **Top-ups stay usable after a plan ends** (the doc said subscribers only). Buying them needs a plan or Lifetime; spending them doesn't. Forfeiting paid videos invites chargebacks. Old pack balances (Phase 5) became top-ups.
- **A job paid partly with trial videos is watermarked as a whole** and must be 480p. The watermark is burnt into a copy by ffmpeg on first request (`server/watermark.js`); the clean file stays for scoring and the founder.
- **JSON export is gated in the studio only**: takes live in the browser, so a server can't withhold them. Blender export is gated for real by withholding the importer script. The grey video export stays free on every plan: it's how the SPEC's five-minute stranger test ends.
- **Own key (BYOK) is Higgsfield only** (the doc mentioned Replicate/Fal/Runway; our recipes run on Higgsfield). Keys are AES-256-GCM encrypted with a key derived from `SESSION_SECRET`; own-key jobs use no videos, work while `REAL_AI` is off, skip our queue slots, and every version is a full download.
- **Studio's 4K upscale, ProRes and team workspace are shown as "soon"**, not sold as included: none is built (teams are a SPEC non-goal for v1).
- **Commercial use is listed for Creator and Studio only**, as in the doc. It is display text until the Terms say it.
- **Dodo's API shapes were read from its SDK's type definitions** (dodopayments 2.61.1) because the docs site is blocked from the cloud session. The flow is tested against a fake Dodo, not yet against Dodo's test mode.

## 39. Plans wired to Dodo test mode, and what testing changed
`npm run dodo:setup` created the 9 catalogue products in Dodo test mode (Indie, Creator, Studio × monthly/yearly, two top-ups, Lifetime); the two Phase 5 packs were archived. Plans need the webhook (renewals, failed cards, cancellations only arrive that way), and the free tunnel link changes on every start, so `npm run dodo:webhook -- <link>` creates HandCam's webhook once (tagged `metadata.handcam = "1"`), saves its signing secret straight into `.env` (never printed), and re-points it at the current link; `npm run share` calls it before starting the server. Tested end to end with Dodo's test card on 2026-11-08: subscribe (Indie), upgrade now with proration (Creator), schedule a downgrade and keep, cancel and resume, a top-up, the billing portal session, the Free gates (2 trial videos, 480p, watermark, JSON/Blender locked, no top-ups). Fixed while testing: the upgrade asked with the browser's `confirm()` and then closed silently while Dodo was still taking the prorated payment, so the plan looked unchanged for ~30 s; it now confirms inside the window and shows "Upgrading…" until the plan switches. Cancel sent free text as `cancellation_feedback`, which Dodo only accepts from its own list (422); the server now drops anything else. The watermark used ffmpeg's `drawtext`, which Homebrew's ffmpeg lacks; it is now a label image (`server/assets/watermark.png`) overlaid at 30% of the width, which works with any ffmpeg.

## 40. Supabase for sign-in and the accounts database
Accounts move from a JSON file to Supabase Postgres (project `handcam`, us-west-1, next to Render's Oregon region), and sign-in moves to Supabase Auth: Google, plus email + password with Supabase's confirmation and reset emails. The server stays dependency-free: it asks Supabase `GET /auth/v1/user` whether a browser's access token is real (works whatever key type signs the tokens), then issues HandCam's own session cookie, so every other route is unchanged. Accounts load into memory at start (one server) and only changed rows are upserted (`handcam_accounts`, `handcam_payments`, refunds as `refund:<id>` rows) through PostgREST with the secret key on the `apikey` header; the file under DATA_DIR stays as a mirror, and the first start with Supabase imports it. Tables have RLS on and no policies: the publishable key (public, in render.yaml) can't read them. An account found by email gets linked to its Supabase user, but an account already linked to another Supabase user can't be taken over by email. Without Supabase env vars the old built-in email + password sign-in still works (local dev). Email: Supabase's built-in sender and Resend without a verified domain both only reach the project owner, so until a domain is bought Google is the way in for testers; then Resend becomes Supabase's SMTP (smtp.resend.com) and confirmation stays on.

## 41. The product is CineHand; the code still says handcam inside
Renamed on 2026-11-09 after a keyword and trademark check (no USPTO or WIPO record for "CineHand"; cinehand.com bought). Everything a person sees says CineHand: pages, legal pages, the trial watermark (`server/assets/watermark.png`, redrawn), download file names (`cinehand-…`), the Blender camera and the Dodo product names (`npm run dodo:setup` now renames existing products in place, same ids, same prices). On purpose unchanged, because changing them loses data or breaks links: browser storage (`handcam` and `handcam-sequences` IndexedDB, `handcam.*` localStorage keys), the Supabase tables (`handcam_accounts`, `handcam_payments`), the Dodo tags (`metadata.handcam_item`, `metadata.handcam`), the own-key encryption salt (`handcam-byok-v1`), the phone bridge (`window.handcamPose`, the `handcam` message handler) and the iOS project (`ios/HandCamAR`), the Render service and the repo name. Email goes out from `mail.cinehand.com` through Resend so it never collides with the GoDaddy mailbox on the root domain.

## 42. The CineHand identity: Rec Signal palette and the Framing hands mark
Chosen by the founder on 2026-11-09 from 16 Higgsfield (Recraft V4.1 vector) candidates. Palette: Graphite #1C1C1E, Bright Paper #F6F4EF, Rec Red #E5322D, Fog #D9D5CC; the old terracotta accent is gone from the site, studio and phone. The mark's masters are the exact brand-kit exports (`brandkit/logo/export`); every web/email/video asset is built from them by `brandkit/build_assets.py` without redrawing (the cropped web SVG was checked pixel-for-pixel against the export). The landing-page screenshots were recoloured in place by `brandkit/recolor_shots.py` (video frames masked so lamp light stays orange) and the studio shot's brand corner re-lettered, instead of re-shooting them. The Google consent screen gets no logo on purpose: uploading one makes Google require app verification. Details and usage rules: `docs/BRAND.md`.

## 43. SEO aims at AI filmmakers, not film students
OpenSEO research (2026-11-09, US): camera-shot glossary terms have big, easy volume ("dutch angle" 33k, "dolly zoom" 5.4k, KD 0) but the searchers are learning film grammar, not buying an AI tool, so we skipped them at the founder's request ("only high-intent users"). The pages target people already making AI video: "ai filmmaking" (2.9k, KD 8), the motion-control cluster ("kling motion control" 3.6k, "motion control ai" 1k, "ai motion control" 590, KD 2–14; every result there is character motion transfer, nobody covers the camera), and camera-prompt searches where Luma, Runway, Kling and Higgsfield rank with 2026 guides. "ai trailer" (SERP is Spielberg's film) and "ai commercial" (template ad generators) were dropped as intent mismatches. Pages: `/ai-camera-movement-prompts`, `/camera-motion-control`, `/ai-filmmaking`, `/guides`; the home title now says "Camera Control for AI Video". Every page carries schema.org data (Organization, SoftwareApplication with price range, Article, BreadcrumbList, FAQPage); FAQ JSON-LD must match the visible text word for word (checked when written). `/llms.txt` summarises the product for AI assistants and robots.txt names the AI crawlers explicitly. The private recipe prompt (lab/recipe.md) is not published; the guides quote only aggregate test results.

## 44. Visitors never spend Claude credits by just looking
Building a set calls Claude. Three automatic builds used to run for every visitor: the demo, the studio's first open (no saved set) and the phone page's first open in phone-only mode. All three now load the ready-made demo set (`public/demo/scene.json`), so trying CineHand costs nothing. Sets are also remembered by their words (`makeSceneCache`, `DATA_DIR/scene-cache.json`, 400 newest): the suggestion buttons and any repeated prompt cost one Claude call ever. Typing a new set still calls Claude (rate-limited: 15/hour per anonymous visitor). AI video was already safe: the server refuses Make video without an account; signed-up users get the 2 trial videos by design.
