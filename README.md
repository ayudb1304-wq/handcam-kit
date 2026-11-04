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
