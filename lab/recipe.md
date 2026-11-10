# CineHand recipe book (private)

## Current best: v0.2 (2026-11-11, built, not yet run on real generations)
With a set look: **no first frame.** Seedance 2.5 reference-to-video gets the look, the product photo and the logo as reference pictures, each named in the prompt for what it is, and the grey move as the video reference. The prompt is a **shot brief** written from the set and the take (`server/make/brief.js`, wording in `recipes/seedance-2.5.json` → `video.brief`):
"Handheld phone footage, one continuous shot with no cuts. [what each picture is] The reference video is a grey 3D blockout of this exact set… Do not copy its grey look… [the set at real size: near things with heights, far things by name] Look: [look words]. Camera: [the move in stages, with times and distances] [travel the full distance — when it travels] [don't turn back to the subject — when the take ends away from it] Keep following the reference to the very last frame. Follow the camera movement of the reference video exactly… Do not add any camera movement, zoom or cut that is not in the reference."
Without a look: v0.1 below. Test plan: the same take on v0.1 and v0.2, 480p, 2 versions each.

## Previous: v0.1 (2026-11-04, 1 test, synthetic move)
**Model:** Seedance 2.5, mode `omni_reference`, 480p for tests.
**Inputs:** start image = photoreal picture made from the export's first-frame PNG; video reference = CineHand "Export video" MP4 as is (phone look, 24 fps).
**Prompt B1:** "Handheld phone footage at night. The start image sets the look of the scene. The reference video shows only the camera movement: follow the camera movement of the reference video exactly, including its timing, small shakes and corrections. Do not copy the grey look of the reference video; keep the scene photoreal like the start image. The man stands still and keeps looking at the camera. Do not add any camera movement that is not in the reference."
**Result:** 3 runs (T1a, T2a, T2b): 2 followed exactly (timing within 0.05 s), 1 added an unrequested move back to the subject at the end. **Reliability ~2 in 3** (4 good of 6 runs incl. T3). Generate 2, keep the one score.py rates best.

## Rules learned
1. MiniMax H3 refuses start_image + video reference together; picture must go in as a reference image (first frame then not locked).
2. MiniMax H3 Max ran ~0.6 s late and returned 6.58 s for a 6 s request.
3. Seedance 2.5 accepts start_image + video reference and keeps exact length.
4. Seedance tends to pull the camera back to the main subject when the reference turns away from it (T2b). Next to try: say in the prompt that the camera ends pointing away from the man and he leaves the frame.
5. Prompt B2 (subject may leave frame) vs B1, 3 runs each: B2 had no swing-backs but one run ignored the start image entirely (T3a). Too few runs to pick a winner; **B1 stays the default**. Across all 6 Seedance runs: 4 followed well, 1 swung back, 1 failed completely.
6. Walking (score.py walk_ratio vs the speckled twin): good Seedance runs walked 0.81 to 0.93 of the take's distance, so Seedance slightly under-walks; the failed run 0.13; MiniMax 1.04 (but late).
7. score.py separates good from bad runs: corr ~0.99 when followed, 0.82 when a move was invented. Usable as an automatic keep/redo check.

8. **App path works (2026-11-05, H1/H4, first hand-shot takes, horror set).** Higgsfield public API `bytedance/seedance-2.5/reference-to-video` with the start image in `image_urls` (not a locked first frame) still followed the move. Whip (H4): 2 of 2 passed, timing +0.04 s, turn corr 0.997–0.998, no swing back, landed on the shed it had to invent. Walk (H1): all 3 walked in at the right moments (walk_corr 0.96–0.996), slightly short (walk_ratio 0.75–0.86), same under-walk as rule 6.
9. **Hand shake survives** (H4): take wobble 0.32 deg, results 0.38–0.39 deg.
10. **Scorer false fail on walk-only takes** (H1): with almost no turning (~10 deg drift), turn_corr is noise and the timing search pins at its ±1.5 s limit, so `judge` fails good videos and Make video spends an extra try (≈18 credits). **Fixed 2026-11-05:** a take "turns" only with ≥15° total yaw or ≥30°/s; otherwise turn_corr is null and timing comes from the walking (or up/down) speed curve (`timing_from` in score.py output). Re-scored H1: 58/58/89 → 83/79/81 (all above the 70% free line); timing −0.17 to −0.33 s, so Seedance starts walking slightly early (the speckled twin scored against itself gives 0.00 s, so it's not a bias). H4 whip unchanged (97/98).

11. **Product pull-out (2026-11-10, P1a to P1g, synthetic move, `lab/testpacks/bottle-pullout`, strip in `lab/results/P1/`).** 7 runs, 480p, 18 credits each, judged by eye (no speckled twin was rendered, so no move-match numbers).
    - Seedance 2.5 `omni_reference` **accepts `start_image` + `end_image` + a video reference together** (P1b). The end frame steers the reveal; it is not hit pixel for pixel.
    - **A first frame that shows no background makes the model invent the place** (P1f: asked for a Himalayan valley, got rock spires and a glacier lake). With the **master look** (one wide picture of the whole set) as an image reference, the reveal matches the set (P1g, P1c). Giving it as `end_image` (P1b) or as a reference (P1c) looked the same.
    - With image references next to it, `start_image` is **not a locked first frame**: P1g opened on a wider, recomposed frame, not the macro picture.
    - **Reverse trick works** (P1e): start on the wide master look, reverse the move into a push-in, play the result backwards. The world is exact because it is the first frame. Moving water would run backwards.
    - **A face printed on the product is not rejected** (P1d, an invented face), but it turns into a different person within a second. Not tested with a real or famous face. Small label text is garbled at 480p in every run; the brand name held.
    - The start picture came from GPT Image 2.6 here (the connector has no Qwen edit): it kept the place and product but **not the blockout's framing** (bottle smaller and off centre). The app's Qwen edit step was not part of this test.
12. **Real product photo (2026-11-10, P2a/P2b, the founder's Toit glass, strip in `lab/results/P2/`).** The photo was cropped to the glass before upload (people in the pub left out). First frame + master look + the photo as references (P2a) gave the best result so far: right set, glass and beer held, logo readable while close. The reverse route (P2b) was worse here: the boulder smeared mid-move and the close-up logo was garbled, so **reverse is not a safe default**; forward with the master look as a reference is. A transparent product shows whatever was behind it in the photo: the first-frame prompt had to say "ignore what is seen through the glass".
13. **Mug pull-back (2026-11-10, app, live, 480p, 10 s, with set look + product photo).** Opens 26 cm from the mug, pulls back ~2.8 m, holds ~4 s, moves back in ~2.6 m, turns right. Seedance followed all of it by eye (strip: macro mug → wide on the rock with the Alps → back near the rock); timing −0.13 s, turn_corr 0.94. Scored 56% only because walk_ratio was read off the last frame (0.03); fitted over the whole move it is **0.70** (74%). Seedance walked ~70% of the distance: the under-walk of rule 6, a bit stronger. The tea tag's text came out readable ("GREEN TEA") from the product photo.
14. **Measuring walking on near parts only** (a distance map rendered from the set) barely changes it here (curve match 0.86 → 0.89): the measuring twin has the same far backdrop as the real video, so both are diluted alike. Not used.

## Not yet known
- Hand-shot shots 2 (walk past), 3 (half circle), 5 (crouch/lower).
- Grey look vs lighter / grid floor reference (could help the under-walk of rules 6 and 13).
- v0.2 against v0.1 on real generations.
- Kling / Genjutsu.
