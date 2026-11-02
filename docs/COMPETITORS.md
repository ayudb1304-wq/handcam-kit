# Competitors (researched 2026-11-03)

What else exists for "plan a camera move without being a 3D artist", what each does well, and what HandCam does about it. Most sources are vendor pages or vendor-written roundups, so treat feature claims as claims. Re-check before relying on any single detail.

## The landscape

### 1. Phone as a camera controller for 3D software
VirtuCamera 2, Unreal VCam, Unity Virtual Camera, VRL Cam, Lightcraft Jetset.

- **Have:**
  - Real positional tracking (ARKit, native apps).
  - Focal length control, per-axis locks, movement scaling, stabilizers.
  - Live view streaming.
  - VirtuCamera 2 (Apr 2026) covers Blender, Maya, 3ds Max, Houdini and Cinema 4D, adds Android, and plans joystick support.
  - Jetset adds live compositing, Gaussian splats and "Superdailies". Tiers: free / $20 / $80 a month (2025 pricing).
- **Lack:** all of them require a DCC (Blender, Maya, Unreal…) and someone who can run it. Nothing builds the set.

### 2. AI that builds the 3D scene
Higgsfield 3D Jutsu + Higgsfield Blender plugin, Intangible.

- **Have:**
  - Prompt (+ references) → editable 3D scene.
  - Curated GLB asset library and **animated Mixamo characters**.
  - Camera presets and trajectory editing.
  - Aspect ratios 16:9, 9:16, 1:1, 4:3, 3:4, 21:9; scenes up to 60 s.
  - MP4 / frame / GLB export.
  - Revision history and collaboration.
  - Render to AI video from the same chat.
  - Intangible: start/end cameras, shot sequencing, Build / Compose / Visualize modes.
  - Higgsfield has also announced **live phone camera control, but inside Blender**.
- **Lack:** a hand-made camera move. Paths are presets or drawn trajectories, which is the "on rails" look HandCam exists to avoid. The handheld phone path needs Blender.

### 3. AI video with motion reference
Kling Motion Control, invideo, Runway.

- **Have:**
  - Kling (also hosted on Higgsfield) copies camera motion from an uploaded reference video.
  - invideo recommends recording the move on your phone in any room and uploading it.
  - Runway retired its camera sliders in July 2026 for a camera-terminology prompt library.
- **Lack:** a matching set. A phone clip of your living room puts a sofa where the car should be. The model has to guess scale and subject placement. A blockout gets both right.

### 4. Classic previs and storyboarding
Previs Pro, Shot Designer, Shot Lister, Katalist, LTX Studio.

- **Have:**
  - Real sensors and lenses, character posing (Previs Pro 3.1).
  - Storyboard PDFs, shot lists, script import.
  - Script → storyboard → animatic (Katalist, LTX).
- **Lack:** any hand-held camera.

## Where HandCam wins today
1. **No 3D software at all:** browser + phone. Every hand-held competitor needs a DCC.
2. **The camera is genuinely hand-shot,** and the raw samples are kept (DECISIONS §1).
3. **Open and cheap:** no account, works offline on templates, exports you own, no vendor lock-in.

## The risk
If Higgsfield brings its phone camera into 3D Jutsu (no Blender), it matches HandCam's core loop. It already has assets, animated characters and rendering on top. Our defence:
- be clearly the best at the *hand* part;
- work on a phone alone;
- stay open to every video model.

## What we add (now in PLAN.md)

| Gap or opportunity | Who has it | HandCam answer | Phase |
|---|---|---|---|
| Output aspect ratio | 3D Jutsu, AI video tools | Pick 16:9 / 9:16 / 2.39 before shooting; shown on the phone; stored with the take | 4 |
| Lens / zoom | VirtuCamera, Previs Pro, Jutsu | Zoom slider in mm, recorded per sample (a zoom is hand-performed) | 4 |
| Export made for AI video | Jutsu (MP4), Kling (motion ref) | Grey render at model-friendly sizes + first-frame PNG + ready prompt | 4 |
| Moving characters and vehicles | Jutsu (Mixamo, GLB animation) | `moves` on any object, riders, ride-along camera, from words | 3b |
| Stabilizer | VirtuCamera, Jetset | **Rigs** (gimbal / tripod / dolly) as capture-time limits, not smoothing | 4b |
| Take review | Shot Lister (circled takes) | Star, rename, side-by-side compare, ghost of previous take | 4b |
| Phone-only | nobody | Describe, shoot, export on the phone alone | 5 |
| Multi-shot / animatic | Intangible, Kling 3.0, Katalist, LTX | Shots per set, trim, sequence playback and export | 5b |
| Positional tracking | VirtuCamera, Jetset, VRL Cam, Unreal VCam | Native ARKit wrapper + Android WebXR (priority raised) | 6 |
| One-click render | Jutsu, Intangible | Optional send to Higgsfield / Seedance / Kling; file export stays default | 7 |

## What we keep saying no to
- **Keyframe or camera-path editing.** It would make HandCam another on-rails tool (DECISIONS §1).
- **A GLB/asset library in v1.** It bloats the phone page and isn't needed for a blockout; better primitive-built figures and vehicles first (DECISIONS §4).
- **Smoothing that rewrites a take.** Rigs and export-time smoothing on a copy cover the need.

## Sources
- VirtuCamera 2: [Digital Production](https://digitalproduction.com/2026/05/01/virtucamera-2-the-weird-byte-goes-android/), [80.lv](https://80.lv/articles/virtucamera-2-is-finally-here), [BlenderNation (v1)](https://www.blendernation.com/2021/03/13/virtucamera-capture-camera-motion-with-your-ios-device/)
- [VRL Cam](https://mwm.ai/apps/vrl-cam/6781006858), [Unity Virtual Camera](https://apps.apple.com/pe/app/unity-virtual-camera/id1478175507)
- Lightcraft Jetset: [Digital Production](https://digitalproduction.com/2025/04/03/lightcraft-jetset-update-virtual-production-goes-pocket-sized/), [Liaison PR](https://liaisonpr.com/news/lightcraft-jetset-expands-iphone-virtual-production-tool-with-a-dozen-new-features/)
- Higgsfield: [3D Jutsu](https://higgsfield.ai/blog/higgsfield-3d-jutsu), [Blender plugin](https://higgsfield.ai/blog/higgsfield-blender-plugin), [phone camera announcement (LinkedIn)](https://co.linkedin.com/in/carlosaugustoduque), [AI previs roundup](https://higgsfield.ai/blog/ai-previsualization-tools)
- Intangible: [help](https://help.intangible.ai/), [previs answer page](https://www.intangible.ai/answers/ai-storyboarding-previsualization), [TechCrunch](https://techcrunch.com/2025/03/06/intangible-ai-a-no-code-3d-creation-tool-for-filmmakers-and-game-designers-raises-4m/?rand=23331)
- Motion reference: [invideo](https://invideo.io/faq/using-your-phone-to-capture-camera-motion-vs-blender/), [atlabs comparison](https://www.atlabs.ai/blog/5-best-ai-video-models-for-motion-control-(2026-comparison)), [Kling motion control guide](https://youmind.com/ar/landing/x-viral-articles/kling-motion-control-user-guide)
- Previs/storyboard: [Storyflow roundup](https://storyflow.so/blog/best-previs-tools-2026), [Previs Pro 3.1 (CG Channel)](https://www.cgchannel.com/tag/celtx/), [Shot Lister review](https://filmlifestyle.com/shot-lister-app-review/)
