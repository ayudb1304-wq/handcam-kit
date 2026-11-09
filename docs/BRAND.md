# CineHand brand

## The mark: "Framing hands"
Two thick rounded L-shapes, graphite and Rec Red, framing a shot the way a director frames one with both hands.
Made with Higgsfield (Recraft V4.1 vector), approved 2026-11-09. Masters live in `brandkit/logo/export/`:

| File | Use |
|---|---|
| `cinehand-mark.svg` / `-2048.png` | The approved mark on light backgrounds (exact export, never redraw it) |
| `cinehand-mark-on-dark.svg` / `-2048.png` | Same geometry, graphite swapped for Bright Paper: dark backgrounds |

Web copies in `public/assets/` are built from the masters by `python3 brandkit/build_assets.py <fonts dir>` (the two
path elements are copied unchanged; only the frame and placement differ; pixel-checked against the export):
`logo.svg`, `logo-on-dark.svg`, `favicon.svg`, `/favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`,
`og.png` (link previews), `email-logo.png` (sign-in emails) and `server/assets/watermark.png` (free-trial videos).

Rules: never recolour, stretch, rotate, outline or add effects to the mark. On light backgrounds use `logo.svg`; on
dark ones `logo-on-dark.svg`; as an app/tab icon use the Bright Paper tile (`favicon.svg`, `icon-*.png`).
Keep clear space of at least one L-stroke width around it. Smallest size: 16 px (favicon).

## Palette: Rec Signal

| Name | Hex | Role |
|---|---|---|
| Graphite | `#1C1C1E` | Text, the mark's first L, dark surfaces |
| Bright Paper | `#F6F4EF` | Light backgrounds, the on-dark mark |
| Rec Red | `#E5322D` | The one accent: primary buttons, links, the mark's second L. Red means "rolling" |
| Fog | `#D9D5CC` | Lines and quiet fills |

In code: `--accent` in `public/shared/ui.css` (dark studio and phone) and `public/site/site.css` / `public/legal/legal.css`
(light pages). The studio keeps its own recording red (`--rec`) for the live recording dot.

## Type
Gabarito (bold) for the wordmark and headlines, Archivo for body, JetBrains Mono for labels. All from Google Fonts.
The wordmark is "CineHand" in Gabarito 700 next to the mark, never the mark alone with a different face.

## Voice
Shoot, take, set, re-anchor, export. "Your hand is the camera. The AI follows." See `CLAUDE.md` for words we don't use.
