# Lab: cracking the recipe (private)

Goal: find the exact way to hand each AI video model a HandCam take so it **copies the camera move**, and prove it with numbers. What we learn here is the product's edge. **Keep this folder private**: if this repo is ever made public, move `lab/` out first.

## Files
- `experiments.csv`: one row per AI generation. Never delete rows; add a new row when you retry.
- `recipe.md`: the current best recipe per model, plus rules learned. Update it when a test beats it.
- `testpacks/<name>/`: everything a test needs, so any test can be re-run in a new session:
  `take.json` (raw HandCam take), `reference.mp4` + `first-frame.png` (from the desk's Export video), `start-image.jpg` (the photoreal picture), and a note of the prompt in `experiments.csv`.
- `results/<test>/`: small comparison images. Full result videos stay on Higgsfield (job ids are in the CSV).
- `takes/<id>/`: takes sent from the desk (`take.json`, `scene.json`; `reference.mp4` + `first-frame.png` after rendering).
- `tools/score.py`: "move match" v0. Compares a result video with the take's raw samples.
- `tools/render.mjs`: renders a lab take into the reference video with the app's own exporter (headless Chromium), plus `measure.mp4`, a speckled twin used only for scoring walking (gitignored, re-render any time).

## Run a score
```
pip install opencv-python-headless numpy
python3 lab/tools/score.py lab/testpacks/whip-synthetic/take.json result.mp4
```
Reads: `timing_offset_s` (+ = AI late), `turn_rms_deg` / `turn_corr` (left/right), `tilt_rms_deg` (up/down), `take_wobble_deg` vs `result_wobble_deg` (does the small shake survive?), and with `measure.mp4` present: `walk_ratio` (1.0 = walked as far as the take), `walk_corr` (walked at the same moments), `updown_corr` (crouch/tilt shots only).
Known limits: fast whips with motion blur read smaller than they are (by ~20 to 30 degrees on a 75 degree whip); frames inside fast turns are skipped for walking; sideways walking (orbits) shows up in the turn numbers, not on its own; ~1 degree of noise on the grey reference itself.

## Tonight's loop (laptop + phone)
1. `git pull`, `npm run dev`, `npm run tunnel` (as always). Open the desk at **http://localhost:3000/desk** on the laptop (Send to lab only works there).
2. Build the set (`empty parking lot at night, one parked car, a man standing beside the driver's door facing the camera`), scan the QR, enable motion.
3. Shoot. **Re-anchor before every take.** Start with shots 1 and 4. 2 or 3 takes each.
4. On the desk: pick each take, name it in the dropdown, press **Send to lab** on the good ones.
5. `npm run lab:push`. Tell Claude "pushed".
6. Claude (cloud): `git pull`, `node lab/tools/render.mjs lab/takes/<id>` makes `reference.mp4` + `first-frame.png`, then runs the models, scores with `tools/score.py` (turn, tilt, walk, shake), adds rows to `experiments.csv`.

## Rules for a fair test
Same set, same start image, same prompt; change **one** thing per round, across all shots. Repeat a result before believing it.
