# Plans and paywalls (Phase 5c)

This is how CineHand charges. It is built from the "SaaS Pricing Strategy for CineHand Kit" doc (Drive, 2026-11-05),
with its numbers re-costed against our real API bill (DECISIONS §29). Every number below lives in
`config/pricing.json`; change it there, never in code.

## What "a video" is

- **A video** is the unit customers see and pay with: one Make video *version* at 480p, up to 8 s.
  720p uses 2, 1080p uses 5; a take over 8 s uses double. Every version made counts, whatever its move
  match; a version that fails to generate uses nothing (DECISIONS §56, which replaced the under-70% rule of §30). The doc called these "AI render takes" or "credits"; we keep the word *video*.
- **Not a video** (free, unlimited, runs in the browser): the grey blockout, shooting takes, the grey reference
  video export, Practice mode. The first-frame picture is part of Make video and is never charged on its own.

## Why the doc's allowances were changed

The doc assumed an AI render costs us $0.25–0.35. Our bill says a 6 s 480p version costs **$1.00**, plus $0.04
for the first frame. Until 11 Nov 2026 about 1 in 4 versions was free (under 70%), so a charged video cost us about **$1.36**;
with every version charged (DECISIONS §56) it is about $1.04 (more for 8 to 10 s takes). At the doc's numbers Creator (60 renders for $49) would cost
~$82 a month to serve. Prices and plan names are kept; the monthly videos are scaled to what the margin allows.

| | Price (monthly / yearly per month) | Videos a month | Our AI cost at full use | Gross margin at full use · at 65% use |
|---|---|---|---|---|
| Free | $0 | 2 to try (once, not monthly) | ≤ $2.72 once | marketing cost |
| Indie | $19 / $15 | 5 | $6.80 | 61% · 75% |
| Creator | $49 / $39 | 15 | $20.40 | 56% · 71% |
| Studio | $129 / $103 | 40 | $54.40 | 55% · 71% |
| Lifetime Tracker | $129 once (first 200) | 0, bring your own key | $0 | ~95% |
| Top-up 5 / 15 videos | $15 / $42 (paid plans only) | +5 / +15, never expire | $6.80 / $20.40 | 51% / 48% |

Assumptions: $1.36 per charged video (480p, 6 s, 75% pass), Dodo ≈ 5% + $0.40 per charge. Yearly plans earn
about 8–10 points less at full use, and are paid up front. Higgsfield's top-up discounts (up to 75% off for
7–30 days) would raise every margin; none are counted.

## What each plan includes

| | Free | Indie | Creator | Studio | Lifetime |
|---|---|---|---|---|---|
| Sets from a sentence, fix the set, things move | ✓ | ✓ | ✓ | ✓ | ✓ |
| Shoot takes (phone or phone + laptop, rigs, lens, ghost, true walking) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Grey video export + first frame + ready-to-paste prompt | ✓ | ✓ | ✓ | ✓ | ✓ |
| Shots and sequences, sequence video | ✓ | ✓ | ✓ | ✓ | ✓ |
| Practice Make video | unlimited | unlimited | unlimited | unlimited | unlimited |
| **JSON and Blender export** (takes and sequences) | – | ✓ | ✓ | ✓ | ✓ |
| Real AI videos | 2 to try, once | 5 a month | 15 a month | 40 a month | – |
| Quality | trial videos: 480p | 480p–1080p | 480p–1080p | 480p–1080p | 480p–1080p |
| Watermark | trial videos: yes | no | no | no | no |
| Use your own Higgsfield key (uses no videos) | – | ✓ | ✓ | ✓ | ✓ |
| Buy top-ups | – | ✓ | ✓ | ✓ | ✓ |
| Queue when busy | normal | normal | priority | first | normal |
| Commercial use of AI videos | – | – | ✓ | ✓ | – |
| Coming soon (shown as "soon", not sold as included) | | | | 4K upscale, ProRes, team workspace | |

Rules that cut across plans:
- **What you pay with decides the quality and the watermark**, not the plan name. Trial videos are 480p and
  watermarked; plan videos and top-ups are any quality, no watermark. A Free account that still has top-ups
  (bought while on a plan) can spend them at any quality.
- **Spend order:** this month's plan videos first (they reset), then top-ups (they never expire), then trial videos.
  Videos that come back (failed versions) return to where they came from, last-taken first. If that month
  is already over, they come back as top-ups, so nobody loses a video they didn't get.
- **Your own Higgsfield key (BYOK):** the job runs on the customer's Higgsfield account. It uses no videos, has no
  watermark, every quality, and every version is a full download.
  It works even when real AI is switched off for customers (`REAL_AI`), because it doesn't spend our money.
  The key is stored encrypted on the server and never sent back to the browser (only its last 4 characters).
- **Grey video export stays free** on every plan: it is what the five-minute stranger test (SPEC) ends with.
- **The founder** (the laptop running CineHand) and `ADMIN_EMAILS` accounts: no gates, no charges, real AI cost in $.

## Where each gate is enforced

| Gate | Server | Studio |
|---|---|---|
| Real AI videos (allowance, top-ups, trial) | `POST /api/make` checks, approve / "Try again" reserves (402 `balance`) | cost line, "Upgrade" / "Buy videos" |
| Trial = 480p | approve refuses another quality (402 `quality`) | quality list notes "Free trial: 480p" |
| Watermark | media route serves `wm-N.mp4` (ffmpeg, made on first request), never `video-N.mp4` | — |
| JSON / Blender export | `/exporters/blender_import.py` refuses without the plan (403 `plan`) | JSON / Blender buttons show a lock and open the plans |
| BYOK | `POST /api/account/byok` and `byok` jobs need the plan | key form in the account panel, toggle on Make video |
| Top-ups | checkout refuses them on Free (403 `plan`) | top-ups hidden on Free |
| Priority | job queue (`MAKE_SLOTS`) orders by plan | — |

JSON export runs entirely in the browser (takes live in IndexedDB), so its gate is a studio gate only.
Blender export needs the importer script from the server, so it is enforced there.

## What happens when…

| Event | What the customer gets | How |
|---|---|---|
| **Sign up** (Google only) | Free plan, 2 trial videos, once per device and network | `accounts.fromAuth` (DECISIONS §49) |
| **Subscribe** (Free → any plan, monthly or yearly) | The plan at once; this month's videos start at the full amount; the month starts today | Dodo checkout → return page and/or `subscription.active` → `accounts.syncSubscription` |
| **Monthly reset** | Plan videos go back to the full amount on the same day each month; unused ones don't roll over. Yearly plans reset monthly too | worked out on each request from the start date (`plans.cycleStart`), no timer |
| **Renewal** | Nothing changes for the customer; the paid-through date moves on | `subscription.renewed` → sync |
| **Upgrade** (higher plan, or monthly → yearly of the same plan) | Now. Dodo charges the prorated difference today. Videos used this month still count, so the difference is added at once (Creator → Studio with 4 used: 36 left) | `change-plan`, `prorated_immediately`, `effective_at: immediately`, `on_payment_failure: prevent_change` |
| **Downgrade** (lower plan, or yearly → monthly) | Keeps the current plan until the end of what they paid for, then switches; shown as "Changes to Indie on 3 Dec" | `change-plan`, `effective_at: next_billing_date` |
| **Change your mind** about a downgrade | "Keep Creator" removes the scheduled change | `change-plan` to the same plan with `cancel_scheduled_change_plan` |
| **Upgrade after a scheduled downgrade** | The upgrade replaces the schedule | `cancel_scheduled_change_plan: true` |
| **Cancel** | Keeps the plan and this month's videos until the paid-through date, then Free. Top-ups stay. No refund for the rest of the period | `PATCH cancel_at_next_billing_date: true` |
| **Undo cancel** before the date | "Keep my plan" | `PATCH cancel_at_next_billing_date: false` |
| **Card fails at renewal** (`on_hold`, `past_due`) | Plan videos pause; exports, BYOK and top-ups keep working; a banner links to update the card. When the payment goes through, everything is back | `subscription.on_hold` → status `on_hold`; `subscription.active` restores |
| **Subscription ends** (`cancelled` after the period, `expired`, `failed`) | Free plan. Top-ups stay usable. Trial videos are not given again | sync → plan `free` |
| **Resubscribe later** | A new month starts that day | new subscription id → new start date |
| **Buy top-ups** | +5 or +15 videos at once, never expire | one-time checkout, credited once per payment id |
| **Buy Lifetime** | Lifetime features forever; can still subscribe for monthly videos | one-time checkout, `kind: lifetime` |
| **Refund of a top-up or Lifetime** (`refund.succeeded`) | The unspent part of that top-up is removed (never below 0); a refunded Lifetime is removed | by payment id, once per refund id |
| **Chargeback opened** (`dispute.opened`) | Real AI videos are paused on the account until it's settled; `dispute.lost` also removes that payment's videos | `account.hold` |
| **Plan videos refund** from a job that settles after the month ended | Comes back as top-ups | `accounts.refund` |
| **Prices change later** | Existing subscribers keep their price (Dodo keeps the product they bought). To change what a plan *includes*, add a new plan id rather than editing the old one | — |

Things deliberately not built: free trial periods on paid plans (the 2 trial videos do that job), pausing a plan,
seats/teams, coupons (Dodo discount codes can be added later without code), and email receipts (Dodo sends them).

## Risks and what handles them

- **Trial farming** (many accounts, 2 free videos each): it happened on 10 Nov 2026 with throwaway emails. Now
  sign-in is Google only, the trial is given once per device and network, every version counts (on the trial and, since
  DECISIONS §56, everywhere), and first frames and versions on our key are capped per account per day (DECISIONS §49).
  Watermark + 480p still make trial videos poor value; `REAL_AI` stays the kill switch.
- **Heavy users at full use**: worst case (8 s takes, 60% pass, ~$2.23 a video) Studio's margin drops to ~27%. Watch `apiUsd`
  per account; the answer is a new plan id with fewer videos, not editing an existing one.
- **Model price changes**: the unit is ours (videos), so a price change is a config change for new plans.
- **BYOK keys**: stored encrypted with a key derived from `SESSION_SECRET`; changing that secret means
  customers re-enter their key.
