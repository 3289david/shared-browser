"""Generate all brand assets for Shared Browser — extension icons + docs favicons."""
import math
import os
import struct
import subprocess
import zlib

try:
    from PIL import Image, ImageDraw, ImageFilter
    HAS_PIL = True
except ImportError:
    HAS_PIL = False
    print("Pillow not found — run: pip3 install Pillow")
    exit(1)

ROOT   = os.path.join(os.path.dirname(__file__), '..')
ICONS  = os.path.join(ROOT, 'extension', 'icons')
DOCS   = os.path.join(ROOT, 'docs')

os.makedirs(ICONS, exist_ok=True)

# ── Brand colors ──────────────────────────────────────────────────────────────
BG_TOP   = (99,  102, 241)   # #6366f1 indigo
BG_BOT   = (139, 92,  246)   # #8b5cf6 violet
WHITE    = (255, 255, 255, 255)
WHITE_60 = (255, 255, 255, 153)


def lerp_color(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def make_icon(size: int) -> Image.Image:
    """Draw the Shared Browser icon at the given pixel size."""
    S = size
    # Work at 4x for anti-aliasing then downsample
    scale = 4
    R = S * scale

    img = Image.new('RGBA', (R, R), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ── Gradient rounded-rect background ──────────────────────────────────────
    radius = R // 5   # ~20% corner radius
    for y in range(R):
        t = y / R
        color = lerp_color(BG_TOP, BG_BOT, t) + (255,)
        draw.line([(0, y), (R - 1, y)], fill=color)

    # Clip to rounded rect via mask
    mask = Image.new('L', (R, R), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([0, 0, R - 1, R - 1], radius=radius, fill=255)
    img.putalpha(mask)

    draw = ImageDraw.Draw(img)

    cx, cy = R // 2, R // 2

    if S >= 48:
        # ── Full design: circle + two eyes + smile ─────────────────────────
        ring_r   = int(R * 0.38)
        ring_w   = max(3, int(R * 0.055))

        # Outer ring
        draw.ellipse(
            [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
            outline=(255, 255, 255, 220), width=ring_w
        )

        # Left eye
        eye_r = int(R * 0.09)
        ex, ey = int(cx - R * 0.19), int(cy - R * 0.09)
        draw.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r],
                     fill=(255, 255, 255, 240))

        # Right eye
        ex2, ey2 = int(cx + R * 0.19), ey
        draw.ellipse([ex2 - eye_r, ey2 - eye_r, ex2 + eye_r, ey2 + eye_r],
                     fill=(255, 255, 255, 240))

        # Smile — drawn as an arc
        smile_r   = int(R * 0.22)
        smile_w   = max(2, int(R * 0.05))
        sx, sy    = cx, int(cy + R * 0.04)
        box = [sx - smile_r, sy - smile_r, sx + smile_r, sy + smile_r]
        draw.arc(box, start=20, end=160, fill=(255, 255, 255, 220), width=smile_w)

    elif S >= 32:
        # ── Simplified: filled circle with two dots ───────────────────────
        ring_r = int(R * 0.36)
        ring_w = max(3, int(R * 0.06))
        draw.ellipse(
            [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
            outline=(255, 255, 255, 220), width=ring_w
        )
        eye_r = int(R * 0.09)
        ex, ey = int(cx - R * 0.17), int(cy - R * 0.08)
        draw.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r], fill=WHITE)
        ex2 = int(cx + R * 0.17)
        draw.ellipse([ex2 - eye_r, ey - eye_r, ex2 + eye_r, ey + eye_r], fill=WHITE)
        # Small smile
        smile_r = int(R * 0.18)
        smile_w = max(2, int(R * 0.05))
        box = [cx - smile_r, cy - smile_r + int(R*0.06), cx + smile_r, cy + smile_r + int(R*0.06)]
        draw.arc(box, start=20, end=160, fill=WHITE, width=smile_w)

    else:
        # ── 16px: just a white circle outline ────────────────────────────
        ring_r = int(R * 0.34)
        ring_w = max(3, int(R * 0.08))
        draw.ellipse(
            [cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
            outline=WHITE, width=ring_w
        )
        eye_r = max(2, int(R * 0.08))
        ex, ey = int(cx - R * 0.16), int(cy - R * 0.06)
        draw.ellipse([ex - eye_r, ey - eye_r, ex + eye_r, ey + eye_r], fill=WHITE)
        ex2 = int(cx + R * 0.16)
        draw.ellipse([ex2 - eye_r, ey - eye_r, ex2 + eye_r, ey + eye_r], fill=WHITE)

    # Downsample with high-quality Lanczos
    img = img.resize((S, S), Image.LANCZOS)
    return img


def save_png(img: Image.Image, path: str):
    img.save(path, 'PNG', optimize=True)
    print(f'  {path}')


# ── Extension icons ───────────────────────────────────────────────────────────
print('Generating extension icons...')
for size in [16, 32, 48, 128]:
    img = make_icon(size)
    save_png(img, os.path.join(ICONS, f'icon{size}.png'))


# ── Docs favicons ─────────────────────────────────────────────────────────────
print('Generating docs favicons...')
for size in [16, 32, 48]:
    img = make_icon(size)
    save_png(img, os.path.join(DOCS, f'favicon-{size}.png'))

# Use ImageMagick to build favicon.ico (16+32+48 embedded)
ico_path = os.path.join(DOCS, 'favicon.ico')
result = subprocess.run([
    'convert',
    os.path.join(DOCS, 'favicon-16.png'),
    os.path.join(DOCS, 'favicon-32.png'),
    os.path.join(DOCS, 'favicon-48.png'),
    ico_path,
], capture_output=True)
if result.returncode == 0:
    print(f'  {ico_path}')
else:
    print(f'  favicon.ico skipped (convert error): {result.stderr.decode()}')

# High-res PNG for og:image / apple-touch-icon
img128 = make_icon(128)
save_png(img128, os.path.join(DOCS, 'icon.png'))

print('Done.')
