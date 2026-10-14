"""The Kition mark: a K on a 3x3 grid of kit keys (docs/design.md, Brand marks)."""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from raymarch import diagonal_gradient, render_sdf, rounded_box, squircle_mask, top_gloss
from wordmark import outline

PRIMARY = '#5645d4'
TILE_TOP = '#8b7dff'
TILE_BOTTOM = '#3f2fb8'
SLOT = '#1a0e64'
KEYS = [(2, 0), (1, 1), (2, 2)]
SLOTS = [(1, 0), (2, 1), (1, 2)]


def rgb(hex_colour):
    h = hex_colour.lstrip('#')
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))


def grid_cells(cell, gap, origin=None):
    """Stem, keys and slots as (x, y, w, h) on the 256 canvas."""
    span = 3 * cell + 2 * gap
    o = (256 - span) / 2 if origin is None else origin
    stem = (o, o, cell, span)
    keys = [(o + c * (cell + gap), o + r * (cell + gap), cell, cell) for c, r in KEYS]
    slots = [(o + c * (cell + gap), o + r * (cell + gap), cell, cell) for c, r in SLOTS]
    return stem, keys, slots


def _rect(x, y, w, h, r, fill, extra=''):
    return f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="{r:g}" fill="{fill}"{extra}/>'


def grid_svg(cell, gap, radius, fill, origin=None, slot_fill=None):
    stem, keys, slots = grid_cells(cell, gap, origin)
    out = _rect(*stem, radius, fill) + ''.join(_rect(*k, radius, fill) for k in keys)
    if slot_fill:
        colour, opacity = slot_fill
        out += ''.join(_rect(*s, radius, colour, f' fill-opacity="{opacity}"') for s in slots)
    return out


TILE = ('<defs><linearGradient id="kition-tile" x1="0" y1="0" x2=".7" y2="1">'
        f'<stop offset="0" stop-color="{TILE_TOP}"/><stop offset="1" stop-color="{TILE_BOTTOM}"/>'
        '</linearGradient></defs><rect width="256" height="256" rx="58" fill="url(#kition-tile)"/>')


def svg(body, view_box='0 0 256 256', title='Kition'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view_box}" role="img"><title>{title}</title>{body}</svg>\n'


def flat_icon_svg():
    return svg(TILE + grid_svg(46, 11, 13, '#fff', slot_fill=(SLOT, 0.35)))


def small_icon_svg():
    return svg(TILE + grid_svg(54, 16, 12, '#fff'))


def symbol_svg():
    return svg(grid_svg(64, 16, 16, PRIMARY), title='Kition symbol')


def lockup_svg():
    word, end = outline('Kition', x=270, baseline=184, cap_height=112, fill='#17171b')
    return svg(grid_svg(64, 16, 16, PRIMARY, origin=16) + word, view_box=f'0 0 {int(end + 24)} 256')


def _px(value, size):
    return value * size / 256


def _rects_layer(size, rects, radius, rgba):
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    for x, y, w, h in rects:
        draw.rounded_rectangle([_px(x, size), _px(y, size), _px(x + w, size), _px(y + h, size)],
                               radius=_px(radius, size), fill=rgba)
    return layer


def _shadow(layer, size, opacity, dy, blur, colour=(20, 10, 70)):
    shadow = Image.new('RGBA', layer.size, colour + (0,))
    shadow.putalpha(layer.split()[3].point(lambda a: int(a * opacity)))
    shadow = shadow.transform(layer.size, Image.AFFINE, (1, 0, 0, 0, 1, -_px(dy, size)))
    return shadow.filter(ImageFilter.GaussianBlur(_px(blur, size) / 4))


def _masked(tile, size):
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(tile, (0, 0), squircle_mask(size))
    return out


def icon_3d_tile(size):
    """Full-bleed 3D tile: raised soft keys over recessed slots."""
    stem, keys, slots = grid_cells(46, 11)

    def scene(p):
        d = np.full(len(p), 1e9)
        for x, y, w, h in [stem, *keys]:
            centre = ((x + w / 2 - 128) / 128, (128 - (y + h / 2)) / 128, 0)
            d = np.minimum(d, rounded_box(p, centre, (w / 256, h / 256, 0.07), 0.07))
        return d

    keys_image = render_sdf(scene, size, (1, 1, 1), rgb('#e4dfff'))
    tile = diagonal_gradient(size, rgb(TILE_TOP), rgb(TILE_BOTTOM))
    tile.alpha_composite(_rects_layer(size, slots, 13, (26, 14, 100, 90)).filter(ImageFilter.GaussianBlur(2 * size / 1024)))
    tile.alpha_composite(_rects_layer(size, slots, 13, (255, 255, 255, 28)).transform(
        (size, size), Image.AFFINE, (1, 0, 0, 0, 1, -_px(3, size))))
    tile.alpha_composite(_shadow(keys_image, size, 0.45, 12, 18))
    tile.alpha_composite(keys_image)
    tile.alpha_composite(top_gloss(size))
    return _masked(tile, size)


def app_icon(size=1024):
    """macOS icon grid: an 824/1024 tile centred on a transparent canvas with a soft shadow."""
    inner = round(size * 824 / 1024)
    offset = (size - inner) // 2
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    shadow.paste(Image.new('RGBA', (inner, inner), (10, 6, 40, 90)), (offset, offset + size // 64), squircle_mask(inner))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(size / 80)))
    canvas.alpha_composite(icon_3d_tile(inner), (offset, offset))
    return canvas


def small_icon_png(size):
    """Flat small cut for 32 px and below, drawn at 8x and downsampled."""
    big = size * 8
    tile = diagonal_gradient(big, rgb(TILE_TOP), rgb(TILE_BOTTOM))
    stem, keys, _ = grid_cells(54, 16)
    tile.alpha_composite(_rects_layer(big, [stem, *keys], 12, (255, 255, 255, 255)))
    return _masked(tile, big).resize((size, size), Image.LANCZOS)
