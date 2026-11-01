"""Generate the FocusFlow extension icons with Pillow."""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "icons"
OUT.mkdir(parents=True, exist_ok=True)

SIZE = 512
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gradient = Image.new("RGBA", (SIZE, SIZE))
pixels = gradient.load()
for y in range(SIZE):
    for x in range(SIZE):
        t = (x + y) / (2 * (SIZE - 1))
        r = int(14 + (124 - 14) * t)
        g = int(165 + (58 - 165) * t)
        b = int(233 + (237 - 233) * t)
        pixels[x, y] = (r, g, b, 255)

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=116, fill=255)
img.alpha_composite(Image.composite(gradient, Image.new("RGBA", (SIZE, SIZE)), mask))

draw = ImageDraw.Draw(img, "RGBA")

# Soft top-left sheen.
sheen = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
ImageDraw.Draw(sheen).ellipse((-150, -210, 410, 350), fill=(255, 255, 255, 34))
img.alpha_composite(Image.composite(sheen, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), mask))

# Play triangle with a subtly rounded silhouette.
play = [(188, 138), (386, 256), (188, 374)]
draw.polygon(play, fill=(255, 255, 255, 246))
draw.line(play + [play[0]], fill=(255, 255, 255, 246), width=18, joint="curve")

# Spark: four-point star in the upper-right.
cx, cy, outer, inner = 386, 120, 42, 13
points = []
for i in range(8):
    angle = -1.57079632679 + i * 0.785398163397
    radius = outer if i % 2 == 0 else inner
    import math
    points.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
draw.polygon(points, fill=(255, 255, 255, 232))

# Rounded border highlight.
draw.rounded_rectangle((5, 5, SIZE - 6, SIZE - 6), radius=112, outline=(255, 255, 255, 46), width=4)

for size in (16, 32, 48, 128):
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(OUT / f"icon{size}.png", "PNG")

print(f"Wrote icons to {OUT}")
