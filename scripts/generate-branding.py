#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Generate the Argon branding raster assets and brand kit showcase sheet.

The Argon mark is a flat rounded square in Obsidian (#1E1E1E) carrying a warm
Ivory (#FBF8F4) geometric "A" with:
  - a circularly rounded apex cap,
  - flat horizontal baseline feet,
  - a sharp inner V vertex, and
  - a detached floating trapezoidal crossbar separated from both legs.

Rasters are drawn on a 128-unit coordinate grid at 4x supersampling and
downsampled with Lanczos so 16 px icons stay crisp. SVG files in
browser/branding/argon/content/branding/ and brand-kit/ use the exact same
128-unit coordinates.

Usage:
    python3 scripts/generate-branding.py
"""

from __future__ import annotations

import pathlib
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ModuleNotFoundError:  # pragma: no cover - documents the requirement
    sys.exit("Pillow is required to regenerate assets: pip install Pillow")

ROOT = pathlib.Path(__file__).resolve().parents[1]
BRANDING = ROOT / "browser" / "branding" / "argon"
CONTENT = BRANDING / "content" / "branding"
BRAND_KIT = ROOT / "brand-kit"

# Brand Core palette (derived from the canonical Argon mark).
OBSIDIAN = "#1E1E1E"       # Primary mark container (rgb 30, 30, 30)
IVORY = "#FBF8F4"          # Primary mark glyph (rgb 251, 248, 244)
ACCENT = "#6478F5"         # Interactive UI & private-browsing accent
DARK_CHROME = "#15171B"    # Browser dark chrome surface

# Canonical 128-unit geometry of the Argon mark.
GRID = 128.0
SUPERSAMPLE = 4
CORNER_RADIUS = 20.0       # 15.625% of square width

# Outer legs & flat feet + inner V vertex on the 128x128 grid.
CHEVRON_POINTS = [
    (16.0, 106.0),         # Outer left foot
    (56.4, 27.5),          # Left tangent of the rounded apex
    (71.6, 27.5),          # Right tangent of the rounded apex
    (112.0, 106.0),        # Outer right foot
    (97.0, 106.0),         # Inner right foot
    (64.0, 41.5),          # Sharp inner V vertex
    (31.0, 106.0),         # Inner left foot
]
APEX_CENTER = (64.0, 31.4)
APEX_RADIUS = 8.55         # Top of cap sits at y = 22.85

# Detached floating trapezoidal crossbar (parallel to inner leg slopes).
CROSSBAR_POINTS = [
    (50.5, 78.0),          # Top-left
    (77.5, 78.0),          # Top-right
    (82.0, 87.0),          # Bottom-right
    (46.0, 87.0),          # Bottom-left
]


def _scale_points(
    points: list[tuple[float, float]],
    scale: float,
    offset: tuple[float, float] = (0.0, 0.0),
) -> list[tuple[float, float]]:
    ox, oy = offset
    return [(ox + x * scale, oy + y * scale) for x, y in points]


def draw_mark(
    size: int,
    background: str | None = OBSIDIAN,
    glyph: str = IVORY,
) -> Image.Image:
    """Draw the canonical Argon mark on a transparent rounded square."""
    s = size * SUPERSAMPLE
    scale = s / GRID
    image = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if background is not None:
        radius = round(CORNER_RADIUS * scale)
        draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=background)

    # 1. Chevron legs (flat feet, sharp inner vertex) + rounded apex cap.
    draw.polygon(_scale_points(CHEVRON_POINTS, scale), fill=glyph)
    cx, cy = APEX_CENTER[0] * scale, APEX_CENTER[1] * scale
    r = APEX_RADIUS * scale
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=glyph)

    # 2. Detached floating trapezoidal crossbar.
    draw.polygon(_scale_points(CROSSBAR_POINTS, scale), fill=glyph)

    return image.resize((size, size), Image.Resampling.LANCZOS)


def _load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
        if bold
        else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for candidate in candidates:
        if pathlib.Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def draw_brand_sheet() -> Image.Image:
    """Render the 1600x1100 Argon Brand Kit overview sheet."""
    w, h = 1600, 1100
    sheet = Image.new("RGBA", (w, h), DARK_CHROME)
    draw = ImageDraw.Draw(sheet)

    f_title = _load_font(36, bold=True)
    f_sub = _load_font(18, bold=False)
    f_sec = _load_font(16, bold=True)
    f_label = _load_font(16, bold=True)
    f_meta = _load_font(14, bold=False)
    f_wordmark = _load_font(52, bold=True)

    draw.text((64, 48), "ARGON BROWSER — BRAND KIT", fill=IVORY, font=f_title)
    draw.text(
        (64, 96),
        "Canonical mark geometry (128u grid), lockups, color system & icon scale",
        fill="#A6ADBD",
        font=f_sub,
    )
    draw.line([(64, 136), (w - 64, 136)], fill="#2F333C", width=2)

    draw.text((64, 160), "01 / MARK VARIATIONS", fill=ACCENT, font=f_sec)
    cards = [
        ("Primary Mark", "Obsidian #1E1E1E / Ivory #FBF8F4", "#23262D", draw_mark(168, OBSIDIAN, IVORY)),
        ("Inverted Mark", "Ivory #FBF8F4 / Obsidian #1E1E1E", "#23262D", draw_mark(168, IVORY, OBSIDIAN)),
        ("Private Browsing", "Dark Chrome #15171B / Accent #6478F5", "#23262D", draw_mark(168, DARK_CHROME, ACCENT)),
        ("Standalone Glyph", "Uncontained Ivory #FBF8F4 on Dark", OBSIDIAN, draw_mark(168, None, IVORY)),
    ]
    card_w, card_h = 344, 270
    for idx, (title, subtitle, card_bg, mark_img) in enumerate(cards):
        cx = 64 + idx * (card_w + 32)
        cy = 196
        draw.rounded_rectangle(
            (cx, cy, cx + card_w, cy + card_h),
            radius=16,
            fill=card_bg,
            outline="#2F333C",
            width=2,
        )
        sheet.alpha_composite(mark_img, (cx + (card_w - mark_img.width) // 2, cy + 24))
        draw.text((cx + 20, cy + 208), title, fill=IVORY, font=f_label)
        draw.text((cx + 20, cy + 232), subtitle, fill="#A6ADBD", font=f_meta)

    draw.text((64, 500), "02 / GEOMETRIC CONSTRUCTION (128u GRID)", fill=ACCENT, font=f_sec)
    draw.text((620, 500), "03 / HORIZONTAL WORDMARK LOCKUPS", fill=ACCENT, font=f_sec)

    gx, gy, gw, gh = 64, 536, 512, 260
    draw.rounded_rectangle((gx, gy, gx + gw, gy + gh), radius=16, fill="#23262D", outline="#2F333C", width=2)
    c_mark = draw_mark(192, OBSIDIAN, IVORY)
    cmx, cmy = gx + 28, gy + 34
    sheet.alpha_composite(c_mark, (cmx, cmy))
    s192 = 192.0 / GRID
    for y_u in (22.85, 41.5, 78.0, 87.0, 106.0):
        yy = round(cmy + y_u * s192)
        draw.line([(cmx - 10, yy), (cmx + 202, yy)], fill=ACCENT, width=1)
    for x_u in (16.0, 64.0, 112.0):
        xx = round(cmx + x_u * s192)
        draw.line([(xx, cmy - 10), (xx, cmy + 202)], fill=ACCENT, width=1)

    specs = [
        "Grid: 128 x 128 u",
        "Corner radius: 20 u (15.6%)",
        "Apex arc: r = 8.55 u at (64, 31.4)",
        "Inner vertex: (64, 41.5)",
        "Flat baseline: y = 106 u",
        "Foot width: 15 u (x=16..31, 97..112)",
        "Floating bar: y = 78..87 u",
        "Bar air gap: 6.5 u each side",
    ]
    for i, line in enumerate(specs):
        draw.text((gx + 244, gy + 32 + i * 25), line, fill=IVORY if i == 0 else "#A6ADBD", font=f_meta)

    lx, ly, lw, lh = 620, 536, 916, 122
    draw.rounded_rectangle((lx, ly, lx + lw, ly + lh), radius=16, fill=OBSIDIAN, outline="#2F333C", width=2)
    sheet.alpha_composite(draw_mark(76, IVORY, OBSIDIAN), (lx + 28, ly + 23))
    draw.text((lx + 124, ly + 31), "Argon", fill=IVORY, font=f_wordmark)
    draw.text((lx + lw - 270, ly + 50), "Dark Lockup (#1E1E1E / #FBF8F4)", fill="#A6ADBD", font=f_meta)

    ly2 = ly + lh + 16
    draw.rounded_rectangle((lx, ly2, lx + lw, ly2 + lh), radius=16, fill=IVORY, outline="#DDE1E7", width=2)
    sheet.alpha_composite(draw_mark(76, OBSIDIAN, IVORY), (lx + 28, ly2 + 23))
    draw.text((lx + 124, ly2 + 31), "Argon", fill=OBSIDIAN, font=f_wordmark)
    draw.text((lx + lw - 270, ly2 + 50), "Light Lockup (#FBF8F4 / #1E1E1E)", fill="#5A6070", font=f_meta)

    draw.text((64, 830), "04 / COLOR PALETTE", fill=ACCENT, font=f_sec)
    draw.text((980, 830), "05 / APPLICATION ICON SCALE", fill=ACCENT, font=f_sec)

    swatches = [
        ("Obsidian", OBSIDIAN, IVORY),
        ("Ivory", IVORY, OBSIDIAN),
        ("Accent", ACCENT, IVORY),
        ("Dark BG", DARK_CHROME, IVORY),
        ("Surface", "#23262D", IVORY),
        ("Light BG", "#F7F8FA", DARK_CHROME),
    ]
    sw_w, sw_h = 136, 176
    for idx, (name, hex_val, text_col) in enumerate(swatches):
        sx = 64 + idx * (sw_w + 12)
        sy = 866
        draw.rounded_rectangle((sx, sy, sx + sw_w, sy + sw_h), radius=14, fill=hex_val, outline="#2F333C", width=2)
        draw.text((sx + 14, sy + sw_h - 56), name, fill=text_col, font=f_label)
        draw.text((sx + 14, sy + sw_h - 32), hex_val, fill=text_col, font=f_meta)

    ix, iy, iw, ih = 980, 866, 556, 176
    draw.rounded_rectangle((ix, iy, ix + iw, iy + ih), radius=16, fill="#23262D", outline="#2F333C", width=2)
    cur_x = ix + 28
    for sz in (128, 64, 48, 32, 16):
        ic = draw_mark(sz, OBSIDIAN, IVORY)
        sheet.alpha_composite(ic, (cur_x, iy + 18 + (128 - sz)))
        draw.text((cur_x, iy + 150), f"{sz}px", fill="#A6ADBD", font=f_meta)
        cur_x += sz + 36

    return sheet


def write_png(image: Image.Image, path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def main() -> int:
    CONTENT.mkdir(parents=True, exist_ok=True)
    BRAND_KIT.mkdir(parents=True, exist_ok=True)

    # Application icons: exact sizes Firefox's branding system packages.
    for size in (16, 32, 48, 64, 128, 256):
        write_png(draw_mark(size), BRANDING / f"default{size}.png")

    # About dialog artwork (Primary: Obsidian container + Ivory glyph).
    write_png(draw_mark(256), CONTENT / "about-logo.png")
    write_png(draw_mark(512), CONTENT / "about-logo@2x.png")
    write_png(draw_mark(192), CONTENT / "about.png")

    # Private browsing uses the same geometry with the Argon accent glyph.
    write_png(draw_mark(256, background=DARK_CHROME, glyph=ACCENT), CONTENT / "about-logo-private.png")
    write_png(draw_mark(512, background=DARK_CHROME, glyph=ACCENT), CONTENT / "about-logo-private@2x.png")

    # Brand Kit standalone high-resolution rasters (512 px) and overview sheet.
    write_png(draw_mark(512, background=OBSIDIAN, glyph=IVORY), BRAND_KIT / "mark-primary-512.png")
    write_png(draw_mark(512, background=IVORY, glyph=OBSIDIAN), BRAND_KIT / "mark-inverted-512.png")
    write_png(draw_mark(512, background=DARK_CHROME, glyph=ACCENT), BRAND_KIT / "mark-private-512.png")
    write_png(draw_mark(512, background=None, glyph=IVORY), BRAND_KIT / "glyph-ivory-512.png")
    write_png(draw_mark(512, background=None, glyph=OBSIDIAN), BRAND_KIT / "glyph-obsidian-512.png")
    write_png(draw_brand_sheet(), BRAND_KIT / "argon-brand-sheet.png")

    print(f"Generated Argon branding assets under {BRANDING} and {BRAND_KIT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
