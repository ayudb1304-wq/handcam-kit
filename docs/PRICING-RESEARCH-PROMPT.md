# Pricing research prompt

Paste everything below the line into a deep-research tool. Bring the answer back so we can turn it into the pricing decision (DECISIONS §29–30, PLAN Phase 5) and update the landing page's draft prices.

Numbers in it are as of 2026-11-05; update them if the API bill or pass rates change.

---

I'm the solo founder of CineHand, an AI video product launching soon. I want to understand how AI video companies price their products, how they make a profit, and then design the best-margin pricing for my product. Please research thoroughly, cite every number with a source and date, and flag anything you couldn't verify.

## My product (context)
CineHand lets someone with no 3D or film skills plan a shot by holding their phone as a camera. They type one sentence ("dead forest at night, a man standing by a tree"), get a grey 3D blockout of the set, walk through it with their phone to record a real handheld camera move, then press "Make video". We send that move to an AI video model (currently ByteDance Seedance 2.5 through the Higgsfield API), and our server automatically checks that the AI video actually follows the hand-shot move, with a 0–100 "move match" score. That guaranteed camera move is our edge: other tools only let you describe camera moves in words.
- Target users: indie filmmakers, YouTubers, ad and music-video creators, small agencies. They only know phone camera apps.
- Each "Make video" makes 1–4 versions (the user chooses); we keep the best one.
- Policy: any version under 70% move match is free (we don't charge for it), and we offer "Try again".
- Quality options: 480p, 720p, 1080p. Takes are 4–15 seconds, typically 6.

## My real costs (measured on my API bill)
- Seedance 2.5 via Higgsfield API, 480p: ~$0.17 per second (~$1.00 per 6 s video). 720p ≈ $0.39/s and 1080p ≈ $0.89/s (estimated from Higgsfield's price ratios). Photoreal first frame: $0.04 per video.
- Higgsfield offers temporary discounts of up to 75% on Seedance for top-ups of $200+ (7 days) or $1,000+ (30 days), plus volume cashback from $5,000/month.
- About 2 in 3 to 9 in 10 versions pass the 70% bar, so the cost per *charged* video is cost ÷ pass rate.
- Other costs: hosting (one always-on Node server plus storage), a small Claude API cost per scene (~1 call per set), payment processing fees.

## What I want researched
1. **Competitor pricing, current as of late 2026**, in a table for: Runway, Kling, Pika, Luma Dream Machine, Higgsfield (consumer app), Hailuo/MiniMax, Google Veo (Flow), OpenAI Sora, LTX Studio, Krea, invideo AI, Hedra, and any previs or "camera control" AI tools (e.g. Intangible, Jetset, Cuebric). For each: plan names and prices (monthly and annual), what a plan includes (credits, seconds, videos), credits per second per model and resolution, effective $ per second of finished video on each plan, free tier, top-up packs, whether credits roll over or expire, watermark and commercial-use rules, and API pricing if separate.
2. **How they make money on it:**
   - Estimated gross margins of AI video and AI image companies, and how they relate to underlying model or GPU costs.
   - How they profit from unused credits (breakage), expiring credits, annual prepay, and tier anchoring ("Most popular").
   - Introductory pricing that rises on renewal.
   - Fair-use "unlimited" plans and how they cap them (relaxed mode, slow queue, concurrency limits).
   - Reselling third-party models such as Seedance or Kling at a markup.

   Include any public statements, investor reports, leaks or analyst estimates (Sacra, The Information, etc.).
3. **How they show cost to users:** credits versus seconds versus "videos", how cost appears before generating, balance display, and what users complain about (Reddit, Trustpilot, X) regarding confusing credits, failed generations they still paid for, and refunds. Which display is most trusted?
4. **Failed or bad generations:** which companies refund credits for failed, NSFW-blocked or unusable outputs, and how. Is anyone charging only for successful or "usable" outputs, like our under-70%-is-free rule? Risks of abuse and how to prevent it (watermarking or preview-only for free versions, caps on free retries).
5. **Pricing models compared for my case:** subscriptions with a credit allowance, prepaid video packs, pay-per-video, hybrid (base plan plus top-ups), and per-seat for teams. Pros and cons for margin, cash flow, predictability, and a non-technical user.
6. **Payments for a solo founder outside the US** (I'm in India): merchant-of-record options (Paddle, Lemon Squeezy, Polar, Dodo Payments, Stripe) — availability for Indian businesses, fees, sales tax/VAT handling, payout, credits/usage-billing support.

## What I want back
- A competitor pricing table (sourced), plus a short summary of the patterns.
- A unit-economics model for CineHand: a spreadsheet-style table of cost per charged video at 480p, 720p and 1080p for pass rates of 60%, 75% and 90%, with and without a 50% Higgsfield discount, and the price needed for 50%, 60% and 70% gross margin.
- 2–3 recommended pricing structures for launch (plan names, prices, what's included, top-ups, free tier), each with expected gross margin and the reasoning, and which one you'd pick and why.
- How to display price to users (units, wording) without revealing our costs.
- A list of risks (model price changes, abuse of free versions, heavy users) and how each structure handles them.
