"""The kit icons: a hue tile plus one white glyph (docs/design.md, Kit icons)."""
from dataclasses import dataclass

from wordmark import outline


@dataclass(frozen=True)
class Kit:
    id: str
    name: str
    light: str
    mid: str
    deep: str


KITS = [
    Kit('document', 'Document', '#6cc6ff', '#1e9bf0', '#0b66c2'),
    Kit('word', 'Word', '#7d9bff', '#2f55d4', '#1b3499'),
    Kit('table', 'Table', '#5fe3c0', '#0fa98a', '#067560'),
    Kit('sheet', 'Sheet', '#6ee08a', '#2aa84a', '#167a31'),
    Kit('board', 'Whiteboard', '#ffe27a', '#f5b800', '#cc8a00'),
    Kit('slide', 'Slide', '#ffaa6e', '#f26b1d', '#c2470a'),
    Kit('design', 'Design', '#ff8fbf', '#f0468f', '#b81e62'),
    Kit('layout', 'Layout', '#f0c08a', '#b8742e', '#7a4614'),
    Kit('vector', 'Vector', '#d49bff', '#a64bf4', '#7424c0'),
    Kit('photo', 'Photo', '#6fe3f0', '#12b5cb', '#0a7f94'),
    Kit('effect', 'Effect', '#e2f56a', '#9cc80f', '#668a05'),
    Kit('film', 'Film', '#5d6070', '#33343f', '#1b1c24'),
    Kit('pdf', 'PDF', '#ff7d6e', '#e2312d', '#a8160f'),
    Kit('cad', 'CAD', '#9fb3c6', '#5b7186', '#38495b'),
]

DEFS = ('<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".34"/>'
        '<stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>'
        '<linearGradient id="wh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#eceef6"/></linearGradient>'
        '<linearGradient id="wh2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".75"/>'
        '<stop offset="1" stop-color="#fff" stop-opacity=".45"/></linearGradient>'
        '<filter id="sh" filterUnits="userSpaceOnUse" x="-64" y="-64" width="384" height="384">'
        '<feDropShadow dx="0" dy="6" stdDeviation="7" flood-color="#000" flood-opacity=".26"/></filter>'
        '<clipPath id="tile-clip"><rect width="256" height="256" rx="58"/></clipPath>')
W = 'fill="url(#wh)"'
W2 = 'fill="url(#wh2)"'


def _line(d, colour, width, opacity=1):
    return (f'<path d="{d}" fill="none" stroke="{colour}" stroke-width="{width}" '
            f'stroke-linecap="round" stroke-linejoin="round" opacity="{opacity}"/>')


def _page():
    return (f'<path d="M84 40H148L184 76V200Q184 216 168 216H84Q68 216 68 200V56Q68 40 84 40Z" {W}/>'
            '<path d="M148 40V64Q148 76 160 76H184Z" fill="#000" opacity=".1"/>')


def glyph(kit):
    h = kit.mid
    if kit.id == 'document':
        return _page() + _line('M92 104H134', h, 16) + _line('M92 140H160M92 168H160M92 196H132', h, 10, .5)
    if kit.id == 'word':
        letters, _ = outline('Aa', 90, 140, 46, h, tracking=-0.02)
        return _page() + letters + _line('M92 168H164M92 192H148', h, 10, .5)
    if kit.id == 'table':
        g = f'<rect x="44" y="56" width="168" height="144" rx="20" {W}/>'
        g += f'<path d="M44 76Q44 56 64 56H192Q212 56 212 76V92H44Z" fill="{h}" opacity=".55"/>'
        for j, y in enumerate([118, 146, 174]):
            g += (f'<circle cx="68" cy="{y}" r="8" fill="{h}" opacity=".75"/>' + _line(f'M88 {y}H140', h, 10, .4)
                  + f'<rect x="156" y="{y - 9}" width="36" height="18" rx="9" fill="{h}" opacity="{.25 + .2 * j:.2f}"/>')
        return g
    if kit.id == 'sheet':
        return (f'<rect x="48" y="52" width="160" height="152" rx="18" {W}/>'
                + _line('M48 102H208M48 152H208M101 52V204M155 52V204', h, 5, .45)
                + f'<rect x="101" y="102" width="54" height="50" fill="none" stroke="{h}" stroke-width="9"/>'
                + f'<rect x="147" y="144" width="14" height="14" rx="3" fill="{h}"/>')
    if kit.id == 'board':
        dots = ''.join(f'<circle cx="{x}" cy="{y}" r="3.2" fill="#fff" opacity=".35"/>'
                       for x in range(52, 220, 24) for y in range(52, 220, 24))
        return (dots + f'<rect x="40" y="48" width="104" height="104" rx="14" {W} transform="rotate(-6 92 100)"/>'
                + _line('M66 88H118M66 112H104', h, 10, .6)
                + '<circle cx="176" cy="180" r="34" fill="#fff" fill-opacity=".25" stroke="#fff" stroke-width="9"/>'
                + _line('M108 164Q112 196 138 190', '#fff', 9) + '<path d="M132 176L146 190L128 200Z" fill="#fff"/>')
    if kit.id == 'slide':
        return (f'<rect x="64" y="52" width="160" height="104" rx="14" {W2}/>'
                + f'<rect x="32" y="88" width="176" height="116" rx="16" {W}/>'
                + _line('M56 120H124', h, 12) + f'<rect x="56" y="140" width="68" height="40" rx="8" fill="{h}" opacity=".35"/>'
                + f'<circle cx="164" cy="156" r="24" fill="{h}" opacity=".6"/>')
    if kit.id == 'design':
        g = '<rect x="56" y="56" width="128" height="128" rx="10" fill="#fff" fill-opacity=".22" stroke="#fff" stroke-width="8"/>'
        for x, y in [(56, 56), (184, 56), (56, 184), (184, 184)]:
            g += f'<rect x="{x - 12}" y="{y - 12}" width="24" height="24" rx="5" {W}/>'
        return g + f'<path d="M150 142L214 168L184 178L174 208Z" fill="#fff" stroke="{h}" stroke-width="5" stroke-linejoin="round"/>'
    if kit.id == 'layout':
        return (f'<rect x="56" y="36" width="144" height="184" rx="14" {W}/>'
                + f'<rect x="70" y="50" width="116" height="156" fill="none" stroke="{h}" stroke-width="2.5" stroke-dasharray="6 6" opacity=".55"/>'
                + f'<rect x="78" y="60" width="100" height="46" rx="8" fill="{h}" opacity=".45"/>'
                + _line('M80 126H120M80 146H120M80 166H120M80 186H110', h, 8, .5)
                + _line('M136 126H176M136 146H176M136 166H176M136 186H162', h, 8, .5))
    if kit.id == 'vector':
        return (_line('M52 196C68 92 180 164 204 60', '#fff', 16) + _line('M204 60L148 48', '#fff', 6, .8)
                + '<circle cx="148" cy="48" r="12" fill="#fff"/>'
                + f'<rect x="38" y="182" width="28" height="28" rx="6" {W}/>'
                + f'<rect x="190" y="46" width="28" height="28" rx="6" fill="#fff" stroke="{h}" stroke-width="6"/>')
    if kit.id == 'photo':
        return (f'<rect x="72" y="36" width="144" height="120" rx="18" {W2}/>'
                + f'<rect x="40" y="76" width="160" height="136" rx="20" {W}/>'
                + f'<path d="M56 196L102 136L132 172L152 152L186 196Z" fill="{h}" opacity=".7"/>'
                + f'<circle cx="160" cy="112" r="14" fill="{h}" opacity=".7"/>')
    if kit.id == 'effect':
        path = _line('M52 196C92 196 108 92 180 84', '#fff', 6, .55)
        g = path.replace('stroke-linejoin="round"', 'stroke-linejoin="round" stroke-dasharray="2 14"')
        for x, y, r, opacity in [(76, 191, 13, .28), (108, 160, 16, .42), (138, 116, 19, .6)]:
            g += f'<circle cx="{x}" cy="{y}" r="{r}" fill="#fff" opacity="{opacity}"/>'
        return (g + f'<circle cx="184" cy="82" r="30" {W}/>'
                + '<rect x="40" y="184" width="24" height="24" rx="4" fill="#fff" transform="rotate(45 52 196)"/>'
                + f'<rect x="40" y="184" width="24" height="24" rx="4" fill="none" stroke="{h}" stroke-width="4" transform="rotate(45 52 196)"/>')
    if kit.id == 'film':
        g = (f'<rect x="44" y="104" width="168" height="108" rx="18" {W}/>'
             f'<path d="M48 72L200 44Q210 42 212 52L216 74L52 104Z" {W}/>')
        for j, colour in enumerate(['#ef3e4a', '#f5b800', '#12b5cb', '#2aa84a']):
            g += (f'<path d="M{70 + j * 38} {100 - j * 7}L{92 + j * 38} {96 - j * 7}'
                  f'L{78 + j * 38} {68 - j * 7}L{56 + j * 38} {72 - j * 7}Z" fill="{colour}"/>')
        return g + f'<path d="M112 136L156 160L112 184Z" fill="{h}"/>'
    if kit.id == 'pdf':
        letters, end = outline('PDF', 58, 183, 34, '#fff')
        return (_page() + f'<rect x="44" y="140" width="{end - 58 + 28:.1f}" height="52" rx="12" fill="{h}" stroke="#fff" stroke-width="5"/>'
                + letters + _line('M92 100H160M92 120H140', h, 9, .45))
    if kit.id == 'cad':
        return (f'<path d="M56 60V200H196Z" {W}/><path d="M84 132V172H124Z" fill="{h}" opacity=".45"/>'
                + _line('M76 220H200', '#fff', 6) + _line('M76 212V228M200 212V228', '#fff', 6)
                + '<circle cx="182" cy="90" r="26" fill="none" stroke="#fff" stroke-width="8"/>'
                + _line('M182 56V124M148 90H216', '#fff', 4, .8))
    raise ValueError(f'unknown kit {kit.id}')


def icon_svg(kit):
    gradient = (f'<linearGradient id="hue" x1="0" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="{kit.light}"/>'
                f'<stop offset=".55" stop-color="{kit.mid}"/><stop offset="1" stop-color="{kit.deep}"/></linearGradient>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
            f'<defs>{DEFS}{gradient}</defs>'
            '<g clip-path="url(#tile-clip)"><rect width="256" height="256" fill="url(#hue)"/>'
            '<path d="M0 0H256V100Q128 130 0 100Z" fill="url(#gloss)"/>'
            '<rect x="1.5" y="1.5" width="253" height="253" rx="56.5" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="3"/></g>'
            f'<g filter="url(#sh)">{glyph(kit)}</g></svg>\n')


# Small cut: solid silhouettes on a 16x16 pixel grid for file trees and tabs. Each kit is its own
# coloured shape with 1-2 px white cut-outs; every edge sits on a whole pixel so 1x screens stay crisp.
_PAGE = 'M3 1H10L14 5V14Q14 15 13 15H3Q2 15 2 14V2Q2 1 3 1Z'
_FOLD = 'M10 1V4Q10 5 11 5H14Z'
_WHITE = '#fff'


def _p(d, fill, opacity=None):
    return f'<path d="{d}" fill="{fill}"' + (f' fill-opacity="{opacity}"' if opacity else '') + '/>'


def _r(x, y, w, h, fill, opacity=None, rx=0):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}"' + (f' rx="{rx}"' if rx else '')
            + f' fill="{fill}"' + (f' fill-opacity="{opacity}"' if opacity else '') + '/>')


def small_glyph(kit):
    c, d, w = kit.mid, kit.deep, _WHITE
    page = _p(_PAGE, c) + _p(_FOLD, w, '.5')
    if kit.id == 'document':
        return page + _r(5, 7, 6, 1, w) + _r(5, 9, 6, 1, w) + _r(5, 11, 4, 1, w)
    if kit.id == 'word':
        return page + _p('M4 7H5.4L6 10.2L6.9 7H8.1L9 10.2L9.6 7H11L9.7 12H8.4L7.5 9L6.6 12H5.3Z', w)
    if kit.id == 'pdf':
        return page + _r(4, 8, 8, 4, w) + _r(5, 9, 6, 2, d)
    if kit.id == 'layout':
        return (_p('M3 1H13Q14 1 14 2V14Q14 15 13 15H3Q2 15 2 14V2Q2 1 3 1Z', c) + _r(4, 3, 8, 4, w)
                + _r(4, 9, 3, 1, w) + _r(9, 9, 3, 1, w) + _r(4, 12, 3, 1, w) + _r(9, 12, 3, 1, w))
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
    if kit.id == 'cad':
        return _p('M2 1V15H16Z', c) + _p('M4 7V13H10Z', w)
    raise ValueError(f'unknown kit {kit.id}')


def small_icon_svg(kit):
    """The kit icon for 16 px trees and tabs: the kit's own solid silhouette, no tile."""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">{small_glyph(kit)}</svg>\n'
