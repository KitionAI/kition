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


def _small_page(fold=True):
    """A page that fills the small tile, with an optional folded corner."""
    if not fold:
        return '<rect x="52" y="28" width="152" height="200" rx="20" fill="#fff"/>'
    return ('<path d="M72 28H160L204 72V208Q204 228 184 228H72Q52 228 52 208V48Q52 28 72 28Z" fill="#fff"/>'
            '<path d="M160 28V60Q160 72 172 72H204Z" fill="#000" opacity=".14"/>')


def small_glyph(kit):
    """Bold glyphs for 32 px and below: one shape, strokes at least 2 px at 16 px (32 units)."""
    h = kit.deep
    if kit.id == 'document':
        return _small_page() + _line('M84 112H172M84 152H172M84 192H140', h, 22)
    if kit.id == 'word':
        letter, end = outline('W', 0, 0, 104, h, weight=800)
        return _small_page() + f'<g transform="translate({128 - end / 2:.1f} 196)">{letter}</g>'
    if kit.id == 'table':
        return ('<rect x="32" y="44" width="192" height="168" rx="26" fill="#fff"/>'
                f'<path d="M32 70Q32 44 58 44H198Q224 44 224 70V100H32Z" fill="{h}"/>'
                + _line('M64 140H192M64 180H192', h, 20))
    if kit.id == 'sheet':
        return ('<rect x="32" y="40" width="192" height="176" rx="24" fill="#fff"/>'
                + _line('M32 98H224M32 158H224M96 40V216M160 40V216', h, 14)
                + f'<rect x="96" y="98" width="64" height="60" fill="{h}"/>')
    if kit.id == 'board':
        return ('<path d="M48 36H208V172L160 220H48Z" fill="#fff"/>'
                f'<path d="M208 172H172Q160 172 160 184V220Z" fill="{h}" opacity=".5"/>'
                + _line('M80 92H176M80 136H144', h, 22))
    if kit.id == 'slide':
        return ('<rect x="24" y="52" width="208" height="136" rx="22" fill="#fff"/>'
                + _line('M128 188V222M96 222H160', '#fff', 20)
                + f'<rect x="56" y="84" width="88" height="22" rx="11" fill="{h}"/>'
                + f'<circle cx="176" cy="140" r="26" fill="{h}"/>')
    if kit.id == 'design':
        g = '<rect x="58" y="58" width="140" height="140" fill="none" stroke="#fff" stroke-width="20"/>'
        for x, y in [(58, 58), (198, 58), (58, 198), (198, 198)]:
            g += f'<rect x="{x - 26}" y="{y - 26}" width="52" height="52" rx="10" fill="#fff"/>'
        return g
    if kit.id == 'layout':
        return (_small_page(fold=False) + f'<rect x="76" y="52" width="104" height="56" rx="10" fill="{h}"/>'
                + _line('M84 144H116M84 184H116M140 144H172M140 184H172', h, 20))
    if kit.id == 'vector':
        return (_line('M56 200C72 96 184 160 200 56', '#fff', 26)
                + '<rect x="28" y="172" width="56" height="56" rx="12" fill="#fff"/>'
                + f'<rect x="172" y="28" width="56" height="56" rx="12" fill="#fff" stroke="{h}" stroke-width="10"/>')
    if kit.id == 'photo':
        return ('<rect x="28" y="44" width="200" height="168" rx="26" fill="#fff"/>'
                f'<path d="M52 192L104 120L140 164L162 140L204 192Z" fill="{h}"/>'
                f'<circle cx="168" cy="92" r="22" fill="{h}"/>')
    if kit.id == 'effect':
        return ('<circle cx="68" cy="188" r="26" fill="#fff" opacity=".45"/>'
                '<circle cx="112" cy="140" r="34" fill="#fff" opacity=".7"/>'
                '<circle cx="172" cy="80" r="50" fill="#fff"/>')
    if kit.id == 'film':
        return ('<rect x="28" y="100" width="200" height="124" rx="22" fill="#fff"/>'
                '<rect x="28" y="36" width="200" height="48" rx="14" fill="#fff"/>'
                f'<path d="M76 36H112L88 84H52ZM148 36H184L160 84H124Z" fill="{h}"/>'
                f'<path d="M108 128L168 162L108 196Z" fill="{h}"/>')
    if kit.id == 'pdf':
        return _small_page() + f'<rect x="40" y="124" width="140" height="72" rx="16" fill="{h}"/>' + _line('M72 160H148', '#fff', 20)
    if kit.id == 'cad':
        return ('<path d="M44 36V220H220Z" fill="#fff"/>'
                f'<path d="M84 124V180H140Z" fill="{h}"/>')
    raise ValueError(f'unknown kit {kit.id}')


def small_icon_svg(kit):
    """The kit icon for 32 px and below: flat hue tile, one bold white glyph, no gloss or shadow."""
    gradient = (f'<linearGradient id="hue" x1="0" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="{kit.light}"/>'
                f'<stop offset="1" stop-color="{kit.mid}"/></linearGradient>')
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">'
            f'<defs>{gradient}</defs><rect width="256" height="256" rx="58" fill="url(#hue)"/>'
            f'{small_glyph(kit)}</svg>\n')
