# Handover: cloud session → local Claude Code (2026-11-04)

Paste everything below the line into Claude Code in your local clone, after `git pull`.

---

You're picking up CineHand from a cloud Claude session. Before changing anything, read `CLAUDE.md`, `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`, `docs/DECISIONS.md` (especially §21–28), `lab/README.md` and `lab/recipe.md`. Ask me for phone and laptop test results; don't assume them.

## Where things stand

- **Phases 0–2 are done** (passed on my iPhone 14). **Phase 4a (Export video)** is built but hasn't been tested on my laptop or iPhone yet.
- **Strategy (DECISIONS §22):** be the best at making AI video models *follow* a hand-shot camera move, and prove it with a measured "move match". The recipe (model + inputs + prompt + pass marks) is the moat. It lives in `lab/`, and the app runs it from `recipes/`.
- **Built and pushed, tested only in headless Chromium:**
  - **Make video engine:** `server/make/` (jobs in `data/jobs/`, recipe loader, providers `higgsfield.js` + `mock.js`), `recipes/practice.json` (free) and `recipes/seedance-2.5.json` (draft). The scorer is `server/score.py`: turns, timing, walking (using the speckled "measuring twin" `measure.mp4`), and shake.
  - **Studio redesign:** `public/desk.html` + `public/studio/` (`main.js`, `make.js`, `tour.js`) + `public/shared/ui.css`. There's a demo take with a real Seedance result in `public/demo/`, and a first-run tour.
  - **Phone page polish** (`public/cam.html`), plus a real bug fix: on high-DPI phones the preview canvas showed a 2× zoomed top-left quarter (DECISIONS §24). Takes shot before the fix were framed on a zoomed preview.
  - **Landing page:** `public/index.html` + `public/site/`, GSCdaddy style. The live hero reel and the "Made with CineHand" gallery are driven by `public/showcase/examples.json`.
  - **Lab:** desk **Send to lab** + `npm run lab:push`. `lab/tools/render.mjs` (needs Playwright) renders `reference.mp4` + `measure.mp4` from a lab take. The knowledge bank is `lab/experiments.csv` (9 rows so far) and `lab/recipe.md`.
- **Recipe results so far** (a synthetic move made with code, not by hand): Seedance 2.5 through the Higgsfield *connector's* `omni_reference` mode (start image + grey reference video) followed the move in about 4 of 6 runs. MiniMax H3 was about 0.6 s late. The scorer catches the bad runs.

## Open problems and caveats

1. **The recipe hasn't been tested on the path the app uses.** Higgsfield's public API (`bytedance/seedance-2.5/reference-to-video`) takes `image_urls` + `video_urls`; there's no locked start image. The draft recipe uses this API mode untested. Make video with the Seedance 2.5 recipe runs exactly this, so use it for recipe tests from now on.
2. **Hand-shot takes haven't been tested yet.** Does the hand's micro-shake survive? Compare `take_wobble_deg` and `result_wobble_deg` in `score.py` output.
3. **Pass marks and the 0–100 "move match"** (`judge`, `badness`, `matchPercent` in `server/make/recipe.js`) are first guesses. Calibrate them on real hand-shot takes.
4. **Landing page placeholders:** pricing is marked draft, the Creator/Studio buttons say "Coming soon", and the footer's Privacy/Terms/Contact links go nowhere. The gallery's three examples are the same synthetic move run three times.
5. **No accounts, payments or hosting yet** (Phase 5). `/api/make` and `/api/lab` only answer requests made on the laptop itself (`isLocal`).
6. **Leftover branch:** the remote branch `wip/make-engine` is already merged; delete it on GitHub.
7. **Higgsfield credits:** about 464 left on the Pro monthly plan. The plan's "unlimited" and free generations only work on the website, not through the API.
8. **Exposed key:** a Higgsfield API key was pasted into the cloud chat. Revoke it and use a fresh key, in `.env` only.

## Setup on this laptop

```bash
npm install
pip3 install opencv-python-headless numpy        # move-match scorer; without it videos show "not checked"
printf 'HF_API_KEY_ID=%s\nHF_API_KEY_SECRET=%s\n' "<id>" "<secret>" >> .env   # optional ANTHROPIC_API_KEY too
npm run dev            # then in a second terminal:
npm run tunnel         # restart dev with PUBLIC_URL=https://….trycloudflare.com for the phone
npm test               # 31 tests should pass
```

- `http://localhost:3000/` is the landing page.
- `/desk` is the studio. Use the localhost address: Send to lab and Make video only work there, not through the tunnel.
- `/cam` is the phone page; open it via the QR code.

## Do these in order

1. **Check what was built.** On my laptop and iPhone:
   - The landing hero video plays in the first seconds.
   - The `/desk` tour runs.
   - Demo take → Make video (Practice) → first-frame approval → result with a move-match score.
   - The phone preview shows the full frame now, not a zoomed corner.
   - Phase 4a acceptance: shoot a take with a whip → Export video → the MP4 opens and the whip lands at the right second.
2. **Test the recipe on the real API.**
   - I shoot shots 1 (slow walk) and 4 (whip) by hand: Re-anchor before every take, name each take, Send to lab.
   - Run Make video with Seedance 2.5 (2 versions each). Log every result as a row in `lab/experiments.csv` with the `score.py` numbers, and update `lab/recipe.md`.
   - Compare with lab tests T1–T3. Change one thing at a time.
   - Then shots 2 (walk past), 3 (half circle) and 5 (crouch).
3. **When the recipe works:**
   - Set `"status": "final"` in `recipes/seedance-2.5.json`.
   - Calibrate the pass marks and `matchPercent`.
   - Put the best hand-shot results in `public/showcase/examples.json`, replacing the synthetic hero. The encode command is in the README.
4. **Then** Phase 3 and 3b per `docs/PLAN.md`, and Phase 5 (hosting, accounts, payments) once I've decided pricing and a host.

## Rules that matter

- From `CLAUDE.md`: the camera move is never authored or smoothed. "Keyframe" never appears in the UI. Runtime deps stay `express` + `ws` only. Update `docs/PLAN.md` and `docs/DECISIONS.md` as you go.
- Commit messages start with `phaseN:`. Non-phase work used `lab:`, `make:`, `studio:` and `site:`.
- Never commit keys or `data/`. `lab/` stays private: the repo is private, so move `lab/` out before ever making it public.
- Spending: ask me before using more than about 50 Higgsfield credits in one go. One Seedance 2.5 video at 480p and 6 s costs about 18 credits.
