# HandCam Kit — a Claude Code starter for "text builds the set, your hand shoots it"

This folder is a **kit for Claude Code**, not a finished app. It contains:

| Path | What it is |
|---|---|
| `CLAUDE.md` | Project rules Claude Code reads automatically every session |
| `docs/SPEC.md` | What the product is, who it's for, what it must *not* become |
| `docs/ARCHITECTURE.md` | The three pieces (desk / cam / relay), the wire protocol, data formats |
| `docs/PLAN.md` | Six build phases, each with an acceptance test you can run with your own phone |
| `docs/PROMPTS.md` | Copy‑paste prompts to give Claude Code, one per phase |
| `docs/DECISIONS.md` | Why gyro‑first, why no smoothing, why iPhone can't walk in Safari, etc. |
| `docs/COMPETITORS.md` | Who else does this, what they have, and what HandCam adds to be better |
| `server/`, `public/`, `exporters/` | A **running** starter scaffold so Phase 0 is already done |

## How to use it

1. Unzip this folder somewhere, e.g. `~/handcam`.
2. Open a terminal in it and run Claude Code:
   ```bash
   cd ~/handcam
   claude
   ```
3. Paste the **Phase 1 prompt** from `docs/PROMPTS.md`. Claude Code will read `CLAUDE.md` and the docs on its own.
4. When Phase 1's acceptance test passes on your phone, paste the Phase 2 prompt. And so on.

You never have to write code. You hold the phone, run the test, and say "pass" or describe what felt wrong.

## Run the scaffold right now (before Claude Code touches it)

```bash
npm install
npm run dev
```

Optional, for AI-built sets: copy your Anthropic API key, then run this once in the project folder. It writes the key from your clipboard into `.env`, which is gitignored and never committed:

```bash
printf 'ANTHROPIC_API_KEY=%s\n' "$(pbpaste)" > .env
```

Without a key, the app uses three built-in sets (parking lot, room, street corner).

**Make video** works out of the box in *Practice* mode (no AI, no credits). For real videos with Seedance 2.5 through Higgsfield, add your Higgsfield API key ID and secret (from console.higgsfield.ai) to the same `.env`, and install the move-match scorer's two Python packages once:

```bash
printf 'HF_API_KEY_ID=%s\nHF_API_KEY_SECRET=%s\n' "your-key-id" "your-key-secret" >> .env
pip3 install opencv-python-headless numpy
```

Open `http://localhost:3000/` for the landing page, `/desk` for the studio (first visit shows a short tour; **Try the demo take** works without a phone).

**Landing page examples** (the live hero and the "Made with HandCam" gallery) come from `public/showcase/examples.json`. To add one (a horror hallway, a rooftop chase…): put the AI video and its grey move in `public/showcase/media/` as 720×1280 H.264 MP4s without audio, plus a `.webp` of each first frame, and add an entry with its real move-match numbers from `server/score.py`. Encode with:

```bash
ffmpeg -i in.mp4 -an -vf "scale=720:1280:flags=lanczos,setsar=1,format=yuv420p" -c:v libx264 -preset slow -crf 22 -movflags +faststart -r 24 out.mp4
```

Open `http://localhost:3000/desk` on your laptop. It shows a QR code.
Your phone needs **HTTPS** to read the gyro (iOS rule). Easiest path, in a second terminal:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

Copy the `https://….trycloudflare.com` URL it prints, restart the server with it:

```bash
PUBLIC_URL=https://xxxx.trycloudflare.com npm run dev
```

Reload `/desk`, scan the QR with your iPhone 14, tap **Enable motion**, and tilt the phone. The camera in the desk view should tilt with it. That is the whole product in miniature; everything else is making it good.

## Your phone: iPhone 14

- Safari gives **rotation only** (gyro). Walking = on‑screen joystick for v1. See `docs/DECISIONS.md` §3.
- You must tap a button before iOS hands over motion data. The scaffold does this.
- Requires HTTPS. Use the cloudflared tunnel above, or deploy the server to Vercel/Fly/Railway later.

## Let a friend try it (free, from this laptop)

```bash
npm run share
```

This starts a free Cloudflare tunnel and the server, then prints the links to send:

- **`…/cam`** on their phone: phone-only mode (describe a set, shoot, export a video, no laptop needed).
- **`…/desk`** on their laptop, then scan its QR code with the phone.

Keep the window open and the laptop awake while they test; Ctrl+C stops it. The link changes each time.

Your friend is a **customer**: they create an account (their first two real videos are free), see prices in **videos**, and never see what the AI costs you. You, on this laptop at `http://localhost:3000/desk`, are the **founder**: no account needed, real AI, real costs in dollars.

## Accounts, plans and payments (Phase 5, 5c)

- Plans: **Free, Indie, Creator, Studio** (monthly or yearly), **Lifetime**, and **top-ups**. What each includes, and what happens on upgrade, downgrade, cancellation, renewal, a failed card or a refund: [`docs/PRICING-PLAN.md`](docs/PRICING-PLAN.md). Every price and allowance is in `config/pricing.json`.
- Accounts live in `data/accounts.json` (gitignored).
- Payments use **Dodo Payments**. In `.env`: `DODO_PAYMENTS_API_KEY=dodo_test_…` (Dodo dashboard → Test Mode → Developer → API Keys), then `npm run dodo:setup` once: it creates each plan (monthly and yearly subscriptions), the top-ups and Lifetime as Dodo products. Test card: `4242 4242 4242 4242`, any future date, CVC `123`.
- **Webhook (needed for plans):** `npm run share` sets it up and keeps it pointed at the current link (`npm run dodo:webhook -- https://<link>` does it by hand; it saves the signing secret into `.env` for you). Manually: Dodo → Developer → Webhooks, endpoint `https://<your link>/api/pay/webhook`, events `subscription.*`, `payment.succeeded`, `refund.succeeded`, `dispute.*`; put its secret in `DODO_WEBHOOK_SECRET`. Renewals, failed cards and cancellations only reach HandCam this way. Customers manage their card and invoices in Dodo's customer portal (Account → Manage billing).
- Free trial videos are watermarked with `ffmpeg` (installed in the Dockerfile; on a Mac: `brew install ffmpeg`).
- `MAKE_SLOTS` (default 6): AI versions running at once on your Higgsfield key; when it's full, Creator and Studio go first. `SIGNUP_LIMIT` (default 5): new accounts per hour per IP.
- `REAL_AI=on` lets customers make real AI videos (spends your Higgsfield API money). Off by default: customers get Practice.
- `ADMIN_EMAILS=you@example.com` makes that account a founder account on a hosted server.
- Testing switches: `LOCAL_IS_CUSTOMER=1` (see localhost as a customer), `PRACTICE_CHARGES=1` (Practice uses videos like real ones).

## Hosting later (always on, ~$7/month)

`render.yaml` + `Dockerfile` run HandCam on [Render](https://render.com): a **Hobby** workspace ($0, not Pro) with a **Starter** instance and a 1 GB disk for accounts and videos. New → Blueprint → this repo, fill in the secret env vars, deploy, then set `PUBLIC_URL` to the service's https address. Any host that runs one always-on Docker container with a disk works the same (DECISIONS §15).
