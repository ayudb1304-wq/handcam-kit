# Prompts for Claude Code

Paste these one at a time into Claude Code, in the project folder. Each assumes the previous phase's acceptance test passed. If a test fails, don't paste the next prompt; instead describe what you saw ("the camera tilts the wrong way when I roll the phone left") and let it fix that first.

---

## Start of every session

```
Read CLAUDE.md, docs/SPEC.md, docs/ARCHITECTURE.md, docs/PLAN.md and docs/DECISIONS.md. Tell me in three lines which phase we're on and what the acceptance test is. Don't change anything yet.
```

---

## Phase 1 — Scene from a sentence

```
Implement Phase 1 from docs/PLAN.md.

1. Write server/scene-prompt.md: a system prompt that makes Claude output ONLY JSON matching public/shared/scene-schema.json. Include real-world sizes (car 4.5×1.8×1.4 m, person 1.75 m, parking bay 2.5×5 m, ceiling 2.7 m), tell it to always include a ground plane and a spawn point ~5 m from the main subject at eye height 1.6 m, and to prefer few large objects over many small ones. Give it two few-shot examples.
2. Implement POST /api/scene in server/index.js using fetch to the Anthropic Messages API (model from env ANTHROPIC_MODEL, default claude-sonnet-4-5). Validate with a tiny hand-written validator in server/validate-scene.js (no new deps). On missing key or any error, fall back to server/templates/ by keyword match and say so in the response as { scene, source: 'llm'|'template' }.
3. Create server/templates/parking-lot.json, empty-room.json, street-corner.json by hand.
4. Write public/shared/stickfigure.js exporting buildStickFigure(THREE, {height, pose}) → Group, built from cylinders and spheres. Poses: standing, sitting, lying, crouching.
5. Write public/shared/scene-render.js exporting renderScene(THREE, scene) → Group used by BOTH desk.html and cam.html. Boxes get a thin dark edge outline so blockouts read clearly.
6. Wire the desk prompt box, show "blockout · template" or "blockout · ai" as a small label, and broadcast the scene to the phone.
7. Add node --test tests for the validator and for the template matcher.

Stop when the Phase 1 acceptance test is ready for me to run and tell me exactly what to type and what I should see.
```

---

## Phase 2 — Shoot a take

```
Implement Phase 2 from docs/PLAN.md.

Constraints to honour from CLAUDE.md: recorded samples are raw, the 1€ filter touches only the live display, no easing anywhere.

1. public/shared/one-euro.js: a standard 1€ filter for scalars and a quaternion wrapper that filters in log-space or via slerp toward the filtered target (document which and why in a comment). Defaults mincutoff=1.0 Hz, beta=0.01, dcutoff=1.0.
2. public/shared/joystick.js: two thumb zones built with pointer events, no library. Left = walk/strafe relative to current yaw, right = vertical. Dead zone 10%. Returns a normalized vector each frame.
3. cam.html: integrate position at 1.4 m/s × speedScale (1/3/10 toggle), start at scene.spawn. Re-anchor button resets yaw offset and position. Record button toggles ●/■, big and thumb-reachable at the bottom centre. While recording: push {ts,q,p} to an array AND send pose with rec:true. On stop: build the take object per ARCHITECTURE.md, save to IndexedDB (public/shared/store.js, plain IDB, no deps), send one `take` message.
4. desk.html: on `take`, save to IndexedDB and add to a list on the right: name, duration, samples. Clicking a take scrubs it with a range input that drives the gizmo; space plays it back at real time using the sample timestamps.
5. A "filter" toggle on the desk gizmo so I can see raw vs filtered live. Default on.

Then tell me how to run the acceptance test.
```

---

## Phase 3 — Fix the set

```
Implement Phase 3 from docs/PLAN.md: select/drag/rotate/delete objects in the desk overview with raycasting against the ground plane, undo stack of 10, every change re-broadcasts the full scene. Add the "edit with words" box that POSTs { prompt, current } so the model edits the existing scene; extend server/scene-prompt.md with an "edit mode" section that says to change only what was asked and keep all ids. Keep the UI to: a prompt box, an edit box, the overview, the take list. No panels.
```

---

## Phase 4 — Export

```
Implement Phase 4 from docs/PLAN.md.

1. exporters/blender_import.py — pure bpy, Blender 4.x. Usage in the file header:
   blender --background --python exporters/blender_import.py -- take.json scene.json out.blend
   Build scene primitives (mirror shared/scene-render.js including the stick figure), create camera "HandCam", insert location+rotation_quaternion keyframes per sample at 60 fps using ts, set frame range, save out.blend. Implement three_to_blender() exactly as described in ARCHITECTURE.md and add a self-test at the bottom that round-trips a known pan-right rotation.
2. Desk "Export" with three buttons: JSON, Blender (zip via a tiny no-dep zip writer in public/shared/zip.js using stored/uncompressed entries), Video reference (MediaRecorder on an offscreen 1920×1080 POV render of the take).
3. Smoothing slider 0–1 in the export panel, default 0, applied to a COPY of the samples at export time via one-euro.js; raw take.json is always written unchanged alongside.

Tell me the exact Blender command to run and what to look for.
```

---

## Phase 5 — Stranger test

```
Implement Phase 5 from docs/PLAN.md. Write the on-screen copy for someone who has only used a phone camera app. Add reconnect with exponential backoff that rejoins the same room. Add phone-only mode. Then give me a deployment recipe for a single small host that serves static files and WebSockets (your pick, justify it in DECISIONS.md), and update README.md.
```

---

## When something feels wrong in the hand

Use this template. Specific beats polite.

```
Phone test result for Phase N: FAIL.
What I did: [tilted phone forward / rolled left / spun 360 / walked with joystick]
What I expected: [camera tilts down]
What happened: [camera tilted up and also rolled]
Device: iPhone 14, Safari, portrait, served via cloudflared.
Fix this before anything else. Explain the cause in one sentence first.
```
