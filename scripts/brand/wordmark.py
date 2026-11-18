"""Outline Inter text to SVG paths so logo files never depend on an installed font."""
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

REPO_ROOT = Path(__file__).resolve().parents[2]
INTER = REPO_ROOT / 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'
_fonts = {}


def _font(weight):
    if weight not in _fonts:
        font = instantiateVariableFont(TTFont(INTER), {'wght': weight})
        _fonts[weight] = (font.getGlyphSet(), font.getBestCmap(), font['head'].unitsPerEm, font['OS/2'].sCapHeight)
    return _fonts[weight]


def outline(text, x, baseline, cap_height, fill, weight=600, tracking=-0.01):
    """Return (`<path>` element, end x) for `text` whose capitals are `cap_height` tall."""
    glyphs, cmap, upm, cap = _font(weight)
    scale = cap_height / cap
    pen = SVGPathPen(glyphs)
    cursor = 0.0
    for char in text:
        name = cmap[ord(char)]
        glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x + cursor * scale, baseline)))
        cursor += glyphs[name].width + tracking * upm
    return f'<path fill="{fill}" d="{pen.getCommands()}"/>', x + cursor * scale
