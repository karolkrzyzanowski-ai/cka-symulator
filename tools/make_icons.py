# Generuje ikony aplikacji (oryginalny znak: znak zachęty powłoki na tle „głębokiej wody”).
import os
from PIL import Image, ImageDraw

SEA = (15, 34, 48, 255)
BUOY = (240, 178, 58, 255)
SPRAY = (213, 225, 232, 255)
RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')

def mark(size, scale=1.0, bg=None):
    """Rysuje znak w kwadracie size x size; scale = jaka część płótna zajmuje znak."""
    S = size * 4  # nadpróbkowanie dla gładkich krawędzi
    im = Image.new('RGBA', (S, S), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    box = S * scale
    ox = (S - box) / 2
    oy = (S - box) / 2
    u = box / 10.0
    w = int(u * 1.15)
    # szewron „>”
    pts = [(ox + 2.2 * u, oy + 2.6 * u), (ox + 5.0 * u, oy + 5.0 * u), (ox + 2.2 * u, oy + 7.4 * u)]
    d.line(pts, fill=BUOY, width=w, joint='curve')
    for x, y in (pts[0], pts[2]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=BUOY)
    # kursor „_”
    d.rounded_rectangle([ox + 5.6 * u, oy + 6.8 * u, ox + 8.2 * u, oy + 6.8 * u + w], radius=w / 2, fill=SPRAY)
    return im.resize((size, size), Image.LANCZOS)

def circle(im):
    m = Image.new('L', (im.width * 4, im.height * 4), 0)
    ImageDraw.Draw(m).ellipse([0, 0, m.width - 1, m.height - 1], fill=255)
    m = m.resize(im.size, Image.LANCZOS)
    out = Image.new('RGBA', im.size, (0, 0, 0, 0))
    out.paste(im, (0, 0), m)
    return out

def rounded(im, r):
    m = Image.new('L', (im.width * 4, im.height * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, m.width - 1, m.height - 1], radius=r * 4, fill=255)
    m = m.resize(im.size, Image.LANCZOS)
    out = Image.new('RGBA', im.size, (0, 0, 0, 0))
    out.paste(im, (0, 0), m)
    return out

DENS = {'mdpi': 1, 'hdpi': 1.5, 'xhdpi': 2, 'xxhdpi': 3, 'xxxhdpi': 4}
for name, f in DENS.items():
    d = os.path.join(RES, f'mipmap-{name}')
    os.makedirs(d, exist_ok=True)
    legacy = int(48 * f)
    sq = mark(legacy, 0.78, SEA)
    rounded(sq, legacy * 0.18).save(os.path.join(d, 'ic_launcher.png'))
    circle(mark(legacy, 0.70, SEA)).save(os.path.join(d, 'ic_launcher_round.png'))
    fg = int(108 * f)
    mark(fg, 0.56).save(os.path.join(d, 'ic_launcher_foreground.png'))

# ikona do README / sklepu
os.makedirs(os.path.join(os.path.dirname(__file__), '..', 'docs'), exist_ok=True)
rounded(mark(512, 0.78, SEA), 92).save(os.path.join(os.path.dirname(__file__), '..', 'docs', 'icon.png'))
print('ikony gotowe')
