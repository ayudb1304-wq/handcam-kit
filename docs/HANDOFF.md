# Handoff note, 10 November 2026

Where the work stopped, so it can be picked up on another computer. Delete this file once it is used up.

## State of the code

- `main` on GitHub is at `151d48a` (the three-line change box). That is what is live on Render.
- Branch `keep-fixes` holds everything since, in four commits, **not merged, not deployed**:
  - `7ff22eb` the recipe's memory (every AI version recorded) and security headers
  - `cec9c3c` videos kept in Supabase, expire by rule, can be deleted
  - `f6392c6` sets and takes saved to the account, your-data controls, privacy page
  - `1d2c41e` five fixes found in a review of the above
- Tests: 98 passing (`npm test`).
- Supabase already has the new tables (`handcam_generations`, `handcam_videos`, `handcam_library`) and the private bucket `handcam-videos`. They are empty and harmless until the branch is deployed.

To continue at home:

```
git fetch
git checkout keep-fixes
npm install
npm test
```

To deploy: merge `keep-fixes` into `main` and push. Read `public/privacy.html` first, because it goes live with it.

## Not tested against the real services

- Uploading a finished video to Supabase storage and bringing it back (the secret key is only on Render).
- Deleting the Supabase sign-in when an account is deleted.
- "Make the look" on the real model through the app (no Higgsfield API key on the work laptop).

Check these three on the live site right after the deploy.

## Billing check

Only one of the two Higgsfield bills could be read: the credit ledger of the subscription used for the lab tests. The live app is billed in dollars through the Higgsfield API console, which was not checked. So the $1.00 per 6 s 480p figure in `docs/PRICING-PLAN.md` still rests on the reading of that bill from 4 November.

Credit ledger, 4 to 10 November (600 granted, 137 left):

| What | Runs | Credits each | Total |
|---|---|---|---|
| Seedance 2.5, 480p, 6 s | 15 | 18 | 270 |
| Recraft (logo candidates) | 16 | 10 | 160 |
| GPT Image (first frames, looks) | 18 | 0.5 to 2.75 | about 22 |
| MiniMax test, upscales | 4 | | about 13 |

Seedance was 18 credits every time.

Still needed: an export or screenshot of the API console's usage page. A small addition not built yet: record what each version cost in the recipe record (`server/learn.js`).

## Pricing: the view so far

The current prices hold together on paper (a video costs about $1 to $1.36 and sells for $3.20 to $3.80, 55 to 60% margin at full use), but the plans are sized for hobby use.

- An agency needs 1080p, which uses 5 videos per version. Creator's 15 videos is three 1080p versions a month for $49.
- Not counted in the plan: Supabase Pro, hosting, building sets with Claude, the set look picture, free retries above the assumed 1 in 4.
- Unknown: how often versions land under 70%. The plan assumes 25%; the lab runs were closer to 1 in 3.
- There are no subscribers yet, so the plans can be restructured freely. (Project rule once there are: add new plan ids, never edit existing ones.)

A sketch for pro-AI agencies and solo AI filmmakers, to react to, not a final list:

| Plan | Price a month | Videos a month | For |
|---|---|---|---|
| Free | $0 | Practice only, or 1 watermarked trial | Trying the studio |
| Solo | $79 | 25 | A solo AI filmmaker: about five 1080p versions, or many 720p |
| Studio | $249 | 90 | Regular client work |
| Agency | $599 | 240, plus seats, priority, saved brand kits | Teams |
| Top-ups | $3.50 to $4 a video | | Overflow |

- Drop or shrink the free AI trial. Each costs about $2 and it is what attracted the abuse. Practice already shows the product.
- Sell the outcome: "one shot = 2 versions at 1080p, retries under 70% free" is easier to buy than "videos".
- Put what agencies pay for in the top tiers: logo lock, the set look, work saved to the account, commercial use, priority.

Confidence in the tier sizes is moderate. They depend on the real API bill and the real under-70% rate.

## Next steps, in order

1. Read the privacy page, then merge `keep-fixes` into `main` and push. Until it is live, nothing is recorded.
2. Upgrade Supabase to Pro before videos start landing in storage.
3. Check the live site: a finished video reaches Supabase storage, and "Make the look" works on the real model.
4. Get the API usage export, so the prices rest on the real bill.
5. Run the recipe test (below).
6. Build the product-first set description (below).
7. Then change the prices, with the bill and the first recipe numbers in hand.

Also on the founder's list:

- Turn off the Email provider in Supabase Auth (the app is Google only now).
- Have a lawyer read the privacy page (GDPR, DPDP Act).
- Check Higgsfield's API terms on what they do with inputs.

## Recipe: what is open

Findings are written up in `lab/recipe.md`, rules 11 and 12, with runs in `lab/experiments.csv` (P1a to P1g, P2a, P2b).

- **The test to run:** three hand-shot product takes, each made two ways: today's recipe (first frame plus set look) against "set look only, no per-take first frame". Seedance does not lock the first frame when references are present, and a first frame and a look made separately make the scene change mid-video (rule 12), so the first frame may be cost with no benefit. About 108 credits for one version each way, 216 for two. Balance is 137. 480p only.
- **Product-first set description** (from the conversation on the night of 9 November): mark which block is the product, pick the shot type, hide helper blocks from the AI, allow small scale (a tabletop, not a room).

## Known gaps, not started

- The phone relay room code has no owner check.
- No content security policy.
- Not synced to the account: sequences, product photos, the logo, the set look, the phone page.
- No list of sets in the studio.

## Windows quirks met on the work laptop

- Set `HANDCAM_PYTHON=python` (the `python3` alias hangs). Scoring needs python with cv2.
- No ffmpeg; `imageio-ffmpeg` was installed instead.
- LF/CRLF warnings from git are harmless.
