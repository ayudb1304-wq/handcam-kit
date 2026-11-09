# CineHand — Product Spec (v1)

## One line

Describe a scene in words, pick up your phone, and shoot a camera move through it with your own hand. Export the move.

## The problem

Previz / animatic camera moves are either (a) hand‑keyed in Blender, which takes weeks to learn and comes out "on rails", or (b) shot with a virtual‑camera app that still assumes you build the set in Blender first. People who think in shots, not in 3D software, have no tool.

## The insight

The phone already *is* a handheld camera. Its gyro gives the exact texture — overshoot, breathing, a slight tilt when you step — that animators spend hours faking. Our job is to **not get in the way of that data**, and to remove the "build the set" step by having an LLM block it out from a sentence.

## Users

1. **Solo filmmakers / content creators** planning a shot before filming it for real.
2. **Storyboard / previz people** who need an animatic camera fast.
3. **AI‑video users** who want a camera‑motion reference to feed Veo / Kling / Runway.

None of them should need to know what Blender is.

## Core flow (must feel like this, in this order)

1. **Describe.** Laptop (or phone alone): type "parking lot at night, one car, a guy wedged between two parked cars". ~5 seconds later a grey‑box set appears. Stick figures are stick figures. Cars are boxes with wheels. It's a *blockout*, and we say so.
2. **Fix.** Drag an object on the laptop if the LLM put the car in the wrong place. Or type "move the car closer to the wall". That's the whole editor.
3. **Connect.** Scan the QR on the laptop with the phone. The phone shows the set from the camera's point of view.
4. **Shoot.** Tap ●. Move the phone. Walk with the joystick. Tap ■. That's a take. Shoot more.
5. **Pick.** On the laptop, scrub each take, pick one.
6. **Export.** Buttons: *Blender*, *JSON*, *Video reference (MP4)*. No settings dialog on the first click.

## Non‑goals for v1 (write these down so nobody builds them)

- No keyframe editing of any kind. No curve editor. No "smooth this take" that alters the stored data.
- No asset marketplace / GLB import. Primitives + stick figures only.
- No multi‑user. One desk, one phone.
- No accounts, no cloud storage. Takes live in the browser (IndexedDB) and as downloaded files.
- No native iOS app in v1. (Phase 6 is optional and only for true positional tracking.)
- No Blender add‑on. We export *to* Blender; we never ask the user to open it unless they want to.

## Quality bar

- Phone → laptop latency under 80 ms on the same Wi‑Fi. Rotation should feel 1:1.
- A 60‑second take must never drop samples; the phone buffers locally and uploads on stop.
- Someone who has never seen the app completes flow steps 1–6 in under 5 minutes with no instructions beyond what's on screen. This is the real acceptance test for v1.

## Success looks like

A user types a sentence, walks around their living room holding a phone, and ten minutes later has a Blender camera that moves like a human shot it — and they never saw Blender.
