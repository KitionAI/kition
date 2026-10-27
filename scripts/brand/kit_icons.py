"""The kit palette and icons: a soft tile in the kit's hue with one glyph (docs/design.md, Kit colors)."""
import json
from dataclasses import dataclass

from wordmark import outline


@dataclass(frozen=True)
class Kit:
    id: str
    name: str
    # The icon's color.
    hue: str
    # The primary color in each scheme: `ui.brand` in kit.json (white text on light, black on dark).
    brand_light: str
    brand_dark: str


KITS = [
    Kit('note', 'Note', '#5645d4', '#5645d4', '#8b7cf0'),
    Kit('doc', 'Doc', '#2b5cd9', '#2b5cd9', '#6b9bff'),
    Kit('table', 'Table', '#0e9a8a', '#0c8375', '#3fd1bf'),
    Kit('sheet', 'Sheet', '#1f9d4c', '#1a8641', '#4fd17b'),
    Kit('board', 'Board', '#f2b200', '#966e00', '#ffd04d'),
    Kit('slide', 'Slide', '#f0701a', '#c0550d', '#ff9a55'),
    Kit('design', 'Design Studio', '#e5486a', '#e0244d', '#ff7d97'),
    Kit('layout', 'Design', '#d63e95', '#d32f8d', '#f57bbd'),
    Kit('vector', 'Vector', '#6fa313', '#58810f', '#a6d64a'),
    Kit('photo', 'Photo', '#0aa3cf', '#087fa1', '#4ccbf0'),
    Kit('effect', 'Effect', '#b03fd6', '#b03fd6', '#d27cf0'),
    Kit('film', 'Film', '#2d2f3a', '#2d2f3a', '#a3a7b8'),
    Kit('pdf', 'PDF', '#dc3b2e', '#db3527', '#ff7a6b'),
    Kit('cad', 'CAD', '#4f6d8a', '#4f6d8a', '#8eabc8'),
    Kit('html', 'HTML', '#c65b32', '#b64b22', '#ff986b'),
    Kit('cube', 'Cube', '#c47a32', '#9a5a22', '#e3a46b'),
]

# The kit that declares each palette entry as its `ui.brand`; Design Studio is Kition's own.
KIT_IDS = {kit.id: f'kit.{kit.id}' for kit in KITS} | {'layout': 'kit.design', 'design': None}

_WHITE = '#fff'


def tint(colour, amount):
    """`colour` mixed with white; `amount` is the color's share, 0 to 1."""
    r, g, b = (int(colour[i:i + 2], 16) for i in (1, 3, 5))
    return '#%02x%02x%02x' % tuple(round(255 - (255 - c) * amount) for c in (r, g, b))


def _line(d, colour, width, opacity=1):
    return (f'<path d="{d}" fill="none" stroke="{colour}" stroke-width="{width}" '
            f'stroke-linecap="round" stroke-linejoin="round" opacity="{opacity}"/>')


def _page(fg):
    return (f'<path d="M84 40H148L184 76V200Q184 216 168 216H84Q68 216 68 200V56Q68 40 84 40Z" fill="{fg}"/>'
            '<path d="M148 40V64Q148 76 160 76H184Z" fill="#000" opacity=".15"/>')


def glyph(kit):
    """The kit's glyph in its hue, with white details, for the soft tile."""
    fg, ac = kit.hue, _WHITE
    full = f'fill="{fg}"'
    back = f'fill="{fg}" fill-opacity=".4"'
    if kit.id == 'note':
        return _page(fg) + _line('M92 104H134', ac, 16) + _line('M92 140H160M92 168H160M92 196H132', ac, 10, .6)
    if kit.id == 'doc':
        letters, _ = outline('Aa', 90, 140, 46, ac, tracking=-0.02)
        return _page(fg) + letters + _line('M92 168H164M92 192H148', ac, 10, .6)
    if kit.id == 'table':
        g = f'<rect x="44" y="56" width="168" height="144" rx="20" {full}/>'
        g += f'<path d="M44 76Q44 56 64 56H192Q212 56 212 76V92H44Z" fill="{ac}" opacity=".35"/>'
        for j, y in enumerate([118, 146, 174]):
            g += (f'<circle cx="68" cy="{y}" r="8" fill="{ac}" opacity=".85"/>' + _line(f'M88 {y}H140', ac, 10, .55)
                  + f'<rect x="156" y="{y - 9}" width="36" height="18" rx="9" fill="{ac}" opacity="{.35 + .2 * j:.2f}"/>')
        return g
    if kit.id == 'sheet':
        return (f'<rect x="48" y="52" width="160" height="152" rx="18" {full}/>'
                + _line('M48 102H208M48 152H208M101 52V204M155 52V204', ac, 5, .5)
                + f'<rect x="101" y="102" width="54" height="50" fill="none" stroke="{ac}" stroke-width="9"/>'
                + f'<rect x="147" y="144" width="14" height="14" rx="3" fill="{ac}"/>')
    if kit.id == 'board':
        dots = ''.join(f'<circle cx="{x}" cy="{y}" r="3.2" fill="{fg}" opacity=".3"/>'
                       for x in range(52, 220, 24) for y in range(52, 220, 24))
        return (dots + f'<rect x="40" y="48" width="104" height="104" rx="14" {full} transform="rotate(-6 92 100)"/>'
                + _line('M66 88H118M66 112H104', ac, 10, .75)
                + f'<circle cx="176" cy="180" r="34" fill="{fg}" fill-opacity=".2" stroke="{fg}" stroke-width="9"/>'
                + _line('M108 164Q112 196 138 190', fg, 9) + f'<path d="M132 176L146 190L128 200Z" fill="{fg}"/>')
    if kit.id == 'slide':
        return (f'<rect x="64" y="52" width="160" height="104" rx="14" {back}/>'
                + f'<rect x="32" y="88" width="176" height="116" rx="16" {full}/>'
                + _line('M56 120H124', ac, 12) + f'<rect x="56" y="140" width="68" height="40" rx="8" fill="{ac}" opacity=".45"/>'
                + f'<circle cx="164" cy="156" r="24" fill="{ac}" opacity=".7"/>')
    if kit.id == 'design':
        g = f'<rect x="56" y="56" width="128" height="128" rx="10" fill="{fg}" fill-opacity=".18" stroke="{fg}" stroke-width="8"/>'
        for x, y in [(56, 56), (184, 56), (56, 184), (184, 184)]:
            g += f'<rect x="{x - 12}" y="{y - 12}" width="24" height="24" rx="5" {full}/>'
        return g + f'<path d="M150 142L214 168L184 178L174 208Z" fill="{fg}" stroke="{ac}" stroke-width="5" stroke-linejoin="round"/>'
    if kit.id == 'layout':
        return (f'<rect x="56" y="36" width="144" height="184" rx="14" {full}/>'
                + f'<rect x="70" y="50" width="116" height="156" fill="none" stroke="{ac}" stroke-width="2.5" stroke-dasharray="6 6" opacity=".6"/>'
                + f'<rect x="78" y="60" width="100" height="46" rx="8" fill="{ac}" opacity=".55"/>'
                + _line('M80 126H120M80 146H120M80 166H120M80 186H110', ac, 8, .6)
                + _line('M136 126H176M136 146H176M136 166H176M136 186H162', ac, 8, .6))
    if kit.id == 'vector':
        return (_line('M52 196C68 92 180 164 204 60', fg, 16) + _line('M204 60L148 48', fg, 6, .8)
                + f'<circle cx="148" cy="48" r="12" fill="{fg}"/>'
                + f'<rect x="38" y="182" width="28" height="28" rx="6" {full}/>'
                + f'<rect x="190" y="46" width="28" height="28" rx="6" fill="{ac}" stroke="{fg}" stroke-width="6"/>')
    if kit.id == 'photo':
        return (f'<rect x="72" y="36" width="144" height="120" rx="18" {back}/>'
                + f'<rect x="40" y="76" width="160" height="136" rx="20" {full}/>'
                + f'<path d="M56 196L102 136L132 172L152 152L186 196Z" fill="{ac}" opacity=".8"/>'
                + f'<circle cx="160" cy="112" r="14" fill="{ac}" opacity=".8"/>')
    if kit.id == 'effect':
        path = _line('M52 196C92 196 108 92 180 84', fg, 6, .55)
        g = path.replace('stroke-linejoin="round"', 'stroke-linejoin="round" stroke-dasharray="2 14"')
        for x, y, r, opacity in [(76, 191, 13, .28), (108, 160, 16, .42), (138, 116, 19, .6)]:
            g += f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fg}" opacity="{opacity}"/>'
        return (g + f'<circle cx="184" cy="82" r="30" {full}/>'
                + f'<rect x="40" y="184" width="24" height="24" rx="4" fill="{fg}" transform="rotate(45 52 196)"/>'
                + f'<rect x="40" y="184" width="24" height="24" rx="4" fill="none" stroke="{ac}" stroke-width="4" transform="rotate(45 52 196)"/>')
    if kit.id == 'film':
        g = (f'<rect x="44" y="104" width="168" height="108" rx="18" {full}/>'
             f'<path d="M48 72L200 44Q210 42 212 52L216 74L52 104Z" {full}/>')
        for j, colour in enumerate(['#ef3e4a', '#f5b800', '#12b5cb', '#2aa84a']):
            g += (f'<path d="M{70 + j * 38} {100 - j * 7}L{92 + j * 38} {96 - j * 7}'
                  f'L{78 + j * 38} {68 - j * 7}L{56 + j * 38} {72 - j * 7}Z" fill="{colour}"/>')
        return g + f'<path d="M112 136L156 160L112 184Z" fill="{ac}"/>'
    if kit.id == 'pdf':
        letters, end = outline('PDF', 58, 183, 34, fg)
        return (_page(fg) + f'<rect x="44" y="140" width="{end - 58 + 28:.1f}" height="52" rx="12" fill="{ac}" stroke="{fg}" stroke-width="5"/>'
                + letters + _line('M92 100H160M92 120H140', ac, 9, .55))
    if kit.id == 'html':
        return (_page(fg) + _line('M102 108L78 132L102 156M154 108L178 132L154 156M140 100L116 164', ac, 10))
    if kit.id == 'cad':
        return (f'<path d="M56 60V200H196Z" {full}/><path d="M84 132V172H124Z" fill="{ac}" opacity=".5"/>'
                + _line('M76 220H200', fg, 6) + _line('M76 212V228M200 212V228', fg, 6)
                + f'<circle cx="182" cy="90" r="26" fill="none" stroke="{fg}" stroke-width="8"/>'
                + _line('M182 56V124M148 90H216', fg, 4, .8))
    if kit.id == 'cube':
        # A cube in three tones, ringed by an orbit that passes behind it and in front.
        def ring(d):
            return _line(d, fg, 7, .55).replace('stroke-linejoin="round"', 'stroke-linejoin="round" stroke-dasharray="1 15"')
        return (ring('M32 160C32 112 224 112 224 160') + f'<path d="M128 40L200 82L128 124L56 82Z" {back}/>'
                + f'<path d="M56 82L128 124V208L56 166Z" {full}/>'
                + f'<path d="M200 82V166L128 208V124Z" fill="{fg}" fill-opacity=".72"/>'
                + _line('M56 82L128 124L200 82M128 124V208', ac, 5, .7) + ring('M32 160C32 208 224 208 224 160'))
    raise ValueError(f'unknown kit {kit.id}')


def icon_svg(kit):
    """The app icon: a flat tile in a light tint of the hue, with the glyph in the hue."""
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
            f'<rect width="256" height="256" rx="58" fill="{tint(kit.hue, .16)}"/>'
            f'<rect x="1.5" y="1.5" width="253" height="253" rx="56.5" fill="none" stroke="{kit.hue}" stroke-opacity=".18" stroke-width="3"/>'
            f'{glyph(kit)}</svg>\n')


# Small cut: solid silhouettes on a 16x16 pixel grid for file trees and tabs. Each kit is its own
# coloured shape with 1-2 px white cut-outs; every edge sits on a whole pixel so 1x screens stay crisp.
_PAGE = 'M3 1H10L14 5V14Q14 15 13 15H3Q2 15 2 14V2Q2 1 3 1Z'
_FOLD = 'M10 1V4Q10 5 11 5H14Z'


def _p(d, fill, opacity=None):
    return f'<path d="{d}" fill="{fill}"' + (f' fill-opacity="{opacity}"' if opacity else '') + '/>'


def _r(x, y, w, h, fill, opacity=None, rx=0):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}"' + (f' rx="{rx}"' if rx else '')
            + f' fill="{fill}"' + (f' fill-opacity="{opacity}"' if opacity else '') + '/>')


def small_glyph(kit):
    c, d, w = kit.hue, kit.brand_light, _WHITE
    page = _p(_PAGE, c) + _p(_FOLD, w, '.5')
    if kit.id == 'note':
        return page + _r(5, 7, 6, 1, w) + _r(5, 9, 6, 1, w) + _r(5, 11, 4, 1, w)
    if kit.id == 'doc':
        return page + _p('M4 7H5.4L6 10.2L6.9 7H8.1L9 10.2L9.6 7H11L9.7 12H8.4L7.5 9L6.6 12H5.3Z', w)
    if kit.id == 'pdf':
        return page + _r(4, 8, 8, 4, w) + _r(5, 9, 6, 2, d)
    if kit.id == 'layout':
        # A laid-out page: a headline, a picture across the top, and two columns of text.
        return (page + _r(4, 3, 5, 1, w) + _r(4, 6, 8, 3, w)
                + _r(4, 10, 3, 1, w) + _r(9, 10, 3, 1, w) + _r(4, 12, 3, 1, w) + _r(9, 12, 3, 1, w))
    if kit.id == 'table':
        return (_r(1, 2, 14, 12, c, rx=2) + _r(2, 6, 12, 7, w) + _r(2, 8, 12, 1, c) + _r(2, 10, 12, 1, c)
                + _r(5, 6, 1, 7, c))
    if kit.id == 'sheet':
        return (_r(1, 1, 14, 14, c, rx=2) + _r(2, 2, 12, 12, w) + _r(6, 2, 1, 12, c) + _r(10, 2, 1, 12, c)
                + _r(2, 6, 12, 1, c) + _r(2, 10, 12, 1, c) + _r(7, 7, 3, 3, c))
    if kit.id == 'board':
        return (_p('M2 2H14V10L10 14H2Z', c) + _p('M14 10H11Q10 10 10 11V14Z', w, '.6')
                + _r(4, 5, 7, 1, w) + _r(4, 8, 5, 1, w))
    if kit.id == 'slide':
        return (_r(1, 2, 14, 9, c, rx=1.5) + _r(3, 4, 5, 2, w) + _r(10, 6, 3, 3, w)
                + _r(7, 11, 2, 3, c) + _r(4, 14, 8, 1, c))
    if kit.id == 'design':
        return (_r(4, 4, 8, 8, c, '.3') + _r(3, 3, 10, 1, c) + _r(3, 12, 10, 1, c) + _r(3, 3, 1, 10, c)
                + _r(12, 3, 1, 10, c) + _r(1, 1, 4, 4, c) + _r(11, 1, 4, 4, c) + _r(1, 11, 4, 4, c) + _r(11, 11, 4, 4, c))
    if kit.id == 'vector':
        return (_p('M2.8 12.4C4.2 5.6 9.4 10.4 12.2 3.2L14.8 4.3C11 14 5.8 9.4 5.4 13.4Z', c) + _r(1, 11, 4, 4, c)
                + _r(11, 1, 4, 4, w) + _p('M11 1H15V5H11ZM12 2V4H14V2Z', c))
    if kit.id == 'photo':
        return _r(1, 2, 14, 12, c, rx=2) + _p('M3 12L6.5 7.5L9 10.5L10.5 9L13 12Z', w) + _r(10, 4, 2, 2, w)
    if kit.id == 'effect':
        return (_p('M10.5 1A4.5 4.5 0 1 1 10.49 1Z', c) + _p('M5.5 7A3 3 0 1 1 5.49 7Z', c, '.7')
                + _p('M2.5 11.5A2 2 0 1 1 2.49 11.5Z', c, '.45'))
    if kit.id == 'film':
        return (_r(1, 6, 14, 9, c, rx=1.5) + _p('M1 2H15V5H1Z', c) + _p('M4 2H6L5 5H3ZM9 2H11L10 5H8Z', w)
                + _p('M6 8L11 10.5L6 13Z', w))
    if kit.id == 'html':
        return _p('M4 1H11L14 4V15H2V1Z', c) + _line('M6 6L4 8L6 10M10 6L12 8L10 10M9 5L7 11', w, 1.2)
    if kit.id == 'cad':
        return _p('M2 1V15H16Z', c) + _p('M4 7V13H10Z', w)
    if kit.id == 'cube':
        return (_p('M8 1L14 4.5V11.5L8 15L2 11.5V4.5Z', c) + _p('M8 1L14 4.5L8 8L2 4.5Z', w, '.5')
                + _p('M8 8L14 4.5V11.5L8 15Z', w, '.25'))
    raise ValueError(f'unknown kit {kit.id}')


def small_icon_svg(kit):
    """The kit icon for 16 px trees and tabs: the kit's own solid silhouette, no tile."""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">{small_glyph(kit)}</svg>\n'


def colors_json():
    """kits/kit-colors.json: the `ui.brand` each kit must declare (scripts/check-kit-brands.mjs)."""
    palette = {'$comment': 'Generated by scripts/brand/build.py --kits from scripts/brand/kit_icons.py; do not edit.'}
    for kit in KITS:
        palette[kit.id] = {'kitId': KIT_IDS[kit.id], 'light': kit.brand_light, 'dark': kit.brand_dark}
    return json.dumps(palette, indent=2) + '\n'
