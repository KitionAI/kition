"""The Kition mark: a mosaic K on the kit-icon tile (docs/design.md, Brand marks and kit icons).

A K on a 3x3 grid: a full-height stem in Kition purple, three keys in kit hues (Layout pink,
Photo cyan, Slide orange) and the three unused cells as faint purple slots, which make the mosaic.
"""
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFilter

import kit_icons
from wordmark import outline

PRIMARY = '#5645d4'
_KITS = {kit.id: kit for kit in kit_icons.KITS}
# (column, row) of each key and the kit whose hue it wears, top to bottom.
KEYS = [((2, 0), 'layout'), ((1, 1), 'photo'), ((2, 2), 'slide')]
SLOTS = [(1, 0), (2, 1), (1, 2)]

# The 256 master: 44-unit cells with 10-unit gaps. The K sits 6 units right of centre so the
# heavy stem does not pull it left.
CELL, GAP, RADIUS, ORIGIN = 44, 10, 9, (58, 52)


@dataclass(frozen=True)
class Palette:
    stem: str
    keys: tuple
    slot: str
    slot_opacity: float


# On the pastel tile (the app icon).
ICON = Palette(PRIMARY, tuple(_KITS[k].hue for _, k in KEYS), PRIMARY, .16)
# Without a tile on white and light surfaces.
LIGHT = Palette(PRIMARY, ICON.keys, PRIMARY, .14)
# Without a tile on dark surfaces: Kition purple and the kits' dark-theme hues.
DARK = Palette(_KITS['note'].brand_dark, tuple(_KITS[k].brand_dark for _, k in KEYS), _KITS['note'].brand_dark, .2)
TILE = kit_icons.tint(PRIMARY, kit_icons.TILE_TINT)
WORDMARK_LIGHT = '#17171b'
WORDMARK_DARK = '#ffffff'

# Small cut (32 px and below): no slots; stem and keys on whole pixels, per size.
# size -> (cell, gap, x, y)
SMALL = {16: (3, 1, 3, 3), 32: (6, 2, 6, 5)}


def grid_cells(cell=CELL, gap=GAP, origin=ORIGIN):
    """Stem, keys and slots as (x, y, w, h)."""
    ox, oy = origin
    step = cell + gap
    stem = (ox, oy, cell, 3 * cell + 2 * gap)
    keys = [(ox + c * step, oy + r * step, cell, cell) for (c, r), _ in KEYS]
    slots = [(ox + c * step, oy + r * step, cell, cell) for c, r in SLOTS]
    return stem, keys, slots


def _rect(x, y, w, h, r, fill, extra=''):
    return f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{r:g}" fill="{fill}"{extra}/>'


def mosaic_svg(palette, cell=CELL, gap=GAP, radius=RADIUS, origin=ORIGIN):
    stem, keys, slots = grid_cells(cell, gap, origin)
    out = _rect(*stem, radius, palette.stem)
    out += ''.join(_rect(*k, radius, colour) for k, colour in zip(keys, palette.keys))
    out += ''.join(_rect(*s, radius, palette.slot, f' fill-opacity="{palette.slot_opacity:g}"') for s in slots)
    return out


def svg(body, view_box='0 0 256 256', title='Kition'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" role="img"><title>{title}</title>{body}</svg>\n'


def flat_icon_svg():
    return svg(kit_icons.tile_svg(PRIMARY) + mosaic_svg(ICON))


def small_cells(size):
    """Stem and keys on whole pixels of a `size` px grid (the small cut)."""
    cell, gap, x, y = SMALL[size]
    stem, keys, _ = grid_cells(cell, gap, (x, y))
    return stem, keys


def small_icon_svg():
    stem, keys = small_cells(16)
    body = ('<rect width="16" height="16" rx="3.75" fill="{tile}"/>'
            '<rect x=".5" y=".5" width="15" height="15" rx="3.25" fill="none" stroke="{hue}" stroke-opacity=".3"/>'
            ).format(tile=TILE, hue=PRIMARY)
    body += _rect(*stem, .6, ICON.stem) + ''.join(_rect(*k, .6, c) for k, c in zip(keys, ICON.keys))
    return svg(body, view_box='0 0 16 16')


# The mark without a tile fills its 256 box with a 16-unit margin, centred.
MARK = (64, 16, 13, (16, 16))


def symbol_svg():
    return svg(mosaic_svg(LIGHT, *MARK), title='Kition symbol')


def symbol_dark_svg():
    return svg(mosaic_svg(DARK, *MARK), title='Kition symbol')


def _lockup(palette, wordmark):
    word, end = outline('Kition', x=270, baseline=184, cap_height=112, fill=wordmark)
    return svg(mosaic_svg(palette, *MARK) + word, view_box=f'0 0 {int(end + 24)} 256')


def lockup_svg():
    return _lockup(LIGHT, WORDMARK_LIGHT)


def lockup_dark_svg():
    return _lockup(DARK, WORDMARK_DARK)


def _rgba(hex_colour, opacity=1.0):
    h = hex_colour.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (round(opacity * 255),)


def _draw_tile(size, scale, stroke_width=3, stroke_opacity=float(kit_icons.TILE_STROKE_OPACITY)):
    """The pastel tile at `size` px, drawn `scale` times larger for anti-aliasing."""
    big = size * scale
    k = big / 256
    tile = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, big - 1, big - 1], radius=kit_icons.TILE_RADIUS * k, fill=_rgba(TILE))
    rim = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    inset = stroke_width * k / 2
    ImageDraw.Draw(rim).rounded_rectangle(
        [inset, inset, big - 1 - inset, big - 1 - inset], radius=(kit_icons.TILE_RADIUS - stroke_width / 2) * k,
        outline=_rgba(PRIMARY, stroke_opacity), width=max(1, round(stroke_width * k)))
    tile.alpha_composite(rim)
    return tile


def _draw_rects(image, rects, unit):
    """Draw non-overlapping (x, y, w, h, radius, rgba) rects, in `unit` px per grid unit."""
    layer = Image.new('RGBA', image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for x, y, w, h, r, rgba in rects:
        draw.rounded_rectangle([x * unit, y * unit, (x + w) * unit - 1, (y + h) * unit - 1], radius=r * unit, fill=rgba)
    image.alpha_composite(layer)


def icon_tile(size, scale=4, square=False):
    """The full-bleed app tile: pastel tile with the mosaic K, flat like the kit icons.

    `square` fills the whole square with no rim, for platforms that round the corners themselves
    (apple-touch-icon).
    """
    tile = Image.new('RGBA', (size * scale,) * 2, _rgba(TILE)) if square else _draw_tile(size, scale)
    stem, keys, slots = grid_cells()
    rects = [(*stem, RADIUS, _rgba(ICON.stem))]
    rects += [(*k, RADIUS, _rgba(c)) for k, c in zip(keys, ICON.keys)]
    rects += [(*s, RADIUS, _rgba(ICON.slot, ICON.slot_opacity)) for s in slots]
    _draw_rects(tile, rects, size * scale / 256)
    return tile.resize((size, size), Image.LANCZOS)


def app_icon(size=1024):
    """macOS icon grid: an 824/1024 tile centred on a transparent canvas with a soft shadow."""
    inner = round(size * 824 / 1024)
    offset = (size - inner) // 2
    tile = icon_tile(inner)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    shadow = Image.new('RGBA', (size, size), (24, 16, 80, 0))
    alpha = Image.new('L', (size, size), 0)
    alpha.paste(tile.split()[3].point(lambda a: a * 70 // 255), (offset, offset + size // 64))
    shadow.putalpha(alpha.filter(ImageFilter.GaussianBlur(size / 80)))
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(tile, (offset, offset))
    return canvas


def small_icon_png(size):
    """The small cut at 16 or 32 px: tile, stem and keys, every key edge on a whole pixel."""
    scale = 8
    tile = _draw_tile(size, scale, stroke_width=256 / size, stroke_opacity=.3)
    stem, keys = small_cells(size)
    rects = [(*stem, .6 * size / 16, _rgba(ICON.stem))]
    rects += [(*k, .6 * size / 16, _rgba(c)) for k, c in zip(keys, ICON.keys)]
    _draw_rects(tile, rects, scale)
    return tile.resize((size, size), Image.LANCZOS)
