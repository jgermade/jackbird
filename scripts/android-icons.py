#!/usr/bin/env python3
"""
The Android launcher icon's layers (src-tauri/icons/android), from the logo (src-tauri/icons/icon.png):

- ic_launcher_foreground.png: the bird, centred inside the adaptive icon's safe zone. A launcher
  masks the 108dp layer to a shape that shows at least a circle 66dp across (61%) in its middle;
  the bird is scaled so that its furthest point from the centre is inside 58% of the layer, so no
  launcher's shape cuts it.
- ic_launcher_monochrome.png: the same bird in one colour, for Android 13's themed icons, which tint
  it with the wallpaper's colours, light or dark as the system is.

Both at each density (108dp: 108, 162, 216, 324 and 432 pixels). Needs Pillow:

    python3 -I scripts/android-icons.py

See RECORD/2026-11-03.deck-design-system.WIP.md (2026-11-12 23:10 UTC).
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LOGO = ROOT / "src-tauri/icons/icon.png"
OUT = ROOT / "src-tauri/icons/android"
DENSITIES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
# The circle the bird must fit in, as a share of the layer, inside the 61% every mask keeps.
FIT = 0.58


def bird() -> Image.Image:
    logo = Image.open(LOGO).convert("RGBA")
    return logo.crop(logo.getchannel("A").getbbox())


def reach(art: Image.Image) -> float:
    """The furthest drawn pixel from the art's centre, in its pixels."""
    alpha = art.getchannel("A")
    width, height = art.size
    cx, cy = width / 2, height / 2
    pixels = alpha.load()
    far = 0.0
    for y in range(height):
        for x in range(width):
            if pixels[x, y] > 16:
                far = max(far, ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) ** 0.5)
    return far


def layer(art: Image.Image, size: int, far: float) -> Image.Image:
    scale = (size * FIT / 2) / far
    scaled = art.resize((max(1, round(art.width * scale)), max(1, round(art.height * scale))), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2), scaled)
    return canvas


def monochrome(art: Image.Image) -> Image.Image:
    # White where the bird is, its own alpha: the system tints it.
    white = Image.new("RGBA", art.size, (255, 255, 255, 255))
    white.putalpha(art.getchannel("A"))
    return white


def main() -> None:
    art = bird()
    mono = monochrome(art)
    far = reach(art)
    for density, size in DENSITIES.items():
        folder = OUT / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        layer(art, size, far).save(folder / "ic_launcher_foreground.png", optimize=True)
        layer(mono, size, far).save(folder / "ic_launcher_monochrome.png", optimize=True)
        print(f"{density}: {size}px")


if __name__ == "__main__":
    main()
