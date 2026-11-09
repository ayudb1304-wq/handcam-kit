"""Builds CineHand's web/email/video brand assets from the approved logo export (brandkit/logo/export).

Every asset reuses the approved mark's two path elements unchanged: only the frame (viewBox), placement and the
approved on-dark colourway (made by brandkit logo-export) differ. Run: python3 brandkit/build_assets.py <fonts dir>
"""
import os, re, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EXPORT = os.path.join(ROOT, 'brandkit', 'logo', 'export')
ASSETS = os.path.join(ROOT, 'public', 'assets')
FONTS = sys.argv[1]
GABARITO, ARCHIVO = os.path.join(FONTS, 'Gabarito.ttf'), os.path.join(FONTS, 'Archivo.ttf')
GRAPHITE, PAPER, RED, MUTE = '#1C1C1E', '#F6F4EF', '#E5322D', '#5E5B56'
X, Y, W, H = 358, 359, 1332, 1334  # the mark's bounding box (+40 px) inside the 2048 canvas, measured from the export

def paths(name):
    found = re.findall(r'<path transform="translate\(0,0\)" fill="(?:rgb\([^"]+\)|#[0-9a-fA-F]{6})" d="[^"]+"\s*/>', open(os.path.join(EXPORT, name)).read())
    assert len(found) == 2, (name, len(found))
    return ''.join(found)

LIGHT, DARK = paths('cinehand-mark.svg'), paths('cinehand-mark-on-dark.svg')

def mark_svg(ps):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{X} {Y} {W} {H}"><title>CineHand</title>{ps}</svg>\n'

def tile_svg(ps, rx, frac, bg=PAPER, size=1000):
    s = size * frac / max(W, H)
    tx, ty = (size - W * s) / 2 - X * s, (size - H * s) / 2 - Y * s
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}"><title>CineHand</title>'
            f'<rect width="{size}" height="{size}" rx="{rx}" fill="{bg}"/>'
            f'<g transform="translate({tx:.2f} {ty:.2f}) scale({s:.5f})">{ps}</g></svg>\n')

def write(name, text):
    with open(os.path.join(ASSETS, name), 'w') as f: f.write(text)

def raster(svg_name, out, width, height=None):
    subprocess.run(['rsvg-convert', '-w', str(width), '-h', str(height or width), '-o', out, os.path.join(ASSETS, svg_name)], check=True)

def font(path, size, weight):
    f = ImageFont.truetype(path, size)
    f.set_variation_by_axes([weight] if path == GABARITO else [weight, 100])  # Archivo axes: weight, width
    return f

# 1. Vector marks for pages
write('logo.svg', mark_svg(LIGHT))
write('logo-on-dark.svg', mark_svg(DARK))
write('favicon.svg', tile_svg(LIGHT, rx=220, frac=0.66))
tmp = os.path.join(ASSETS, '_tile-square.svg'); open(tmp, 'w').write(tile_svg(LIGHT, rx=0, frac=0.6))

# 2. Raster icons
raster('_tile-square.svg', os.path.join(ASSETS, 'apple-touch-icon.png'), 180)
raster('_tile-square.svg', os.path.join(ASSETS, 'icon-192.png'), 192)
raster('_tile-square.svg', os.path.join(ASSETS, 'icon-512.png'), 512)
for s in (16, 32, 48): raster('favicon.svg', f'/tmp/cinehand-fav-{s}.png', s)
subprocess.run(['magick', '/tmp/cinehand-fav-16.png', '/tmp/cinehand-fav-32.png', '/tmp/cinehand-fav-48.png', os.path.join(ROOT, 'public', 'favicon.ico')], check=True)
os.remove(tmp)

def mark_png(svg_name, height):
    out = f'/tmp/cinehand-{svg_name}-{height}.png'
    w = round(height * W / H)
    subprocess.run(['rsvg-convert', '-w', str(w), '-h', str(height), '-o', out, os.path.join(ASSETS, svg_name)], check=True)
    return Image.open(out).convert('RGBA')

# 3. Link preview (Open Graph / X), 1200x630
og = Image.new('RGB', (1200, 630), PAPER)
d = ImageDraw.Draw(og)
m = mark_png('logo.svg', 230)
og.paste(m, (110, 190), m)
d.text((400, 190), 'CineHand', font=font(GABARITO, 128, 700), fill=GRAPHITE)
d.text((404, 345), 'Your hand is the camera. The AI follows.', font=font(ARCHIVO, 36, 500), fill=MUTE)
d.ellipse((404, 556, 420, 572), fill=RED)
d.text((432, 549), 'cinehand.com', font=font(ARCHIVO, 26, 600), fill=GRAPHITE)
og.save(os.path.join(ASSETS, 'og.png'), optimize=True)

# 4. Email header lockup (2x, shown at 220 px wide), transparent
lock_h = 88
m = mark_png('logo.svg', lock_h)
f = font(GABARITO, 72, 700)
tw = ImageDraw.Draw(Image.new('RGB', (1, 1))).textbbox((0, 0), 'CineHand', font=f)
lock = Image.new('RGBA', (m.width + 26 + tw[2] + 4, lock_h), (0, 0, 0, 0))
lock.paste(m, (0, 0), m)
ImageDraw.Draw(lock).text((m.width + 26, (lock_h - (tw[3] + tw[1])) / 2), 'CineHand', font=f, fill=GRAPHITE)
lock.save(os.path.join(ASSETS, 'email-logo.png'), optimize=True)

# 5. Free-trial video watermark (laid over video by server/watermark.js), on-dark mark + label
wm = Image.new('RGBA', (680, 112), (0, 0, 0, 0))
dw = ImageDraw.Draw(wm)
dw.rounded_rectangle([0, 0, 679, 111], radius=22, fill=(0, 0, 0, 115))
m = mark_png('logo-on-dark.svg', 64)
wm.paste(m, (28, 24), m)
f = font(GABARITO, 50, 700)
b = dw.textbbox((0, 0), 'CineHand · free trial', font=f)
dw.text((28 + m.width + 22, (112 - (b[3] + b[1])) / 2), 'CineHand · free trial', font=f, fill=(255, 255, 255, 230))
wm.save(os.path.join(ROOT, 'server', 'assets', 'watermark.png'), optimize=True)
print('ok')
