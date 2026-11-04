# Lab: cracking the recipe (private)

Goal: find the exact way to hand each AI video model a HandCam take so it **copies the camera move**, and prove it with numbers. What we learn here is the product's edge. **Keep this folder private**: if this repo is ever made public, move `lab/` out first.

## Files
- `experiments.csv`: one row per AI generation. Never delete rows; add a new row when you retry.
- `recipe.md`: the current best recipe per model, plus rules learned. Update it when a test beats it.
- `testpacks/<name>/`: everything a test needs, so any test can be re-run in a new session:
  `take.json` (raw HandCam take), `reference.mp4` + `first-frame.png` (from the desk's Export video), `start-image.jpg` (the photoreal picture), and a note of the prompt in `experiments.csv`.
- `results/<test>/`: small comparison images. Full result videos stay on Higgsfield (job ids are in the CSV).
- `tools/score.py`: "move match" v0. Compares a result video with the take's raw samples.

## Run a score
```
pip install opencv-python-headless numpy
python3 lab/tools/score.py lab/testpacks/whip-synthetic/take.json result.mp4
```
Reads: `timing_offset_s` (+ = AI late), `turn_rms_deg` (left/right error), `tilt_rms_deg` (up/down error), `take_wobble_deg` vs `result_wobble_deg` (does the small shake survive?).
Known limits: walking isn't measured yet; fast whips with motion blur read smaller than they are (by ~20 to 30 degrees on a 75 degree whip); ~1 degree of noise on the grey reference itself.

## Rules for a fair test
Same set, same start image, same prompt; change **one** thing per round, across all shots. Repeat a result before believing it.
