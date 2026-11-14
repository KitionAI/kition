"""Unit tests for the brand generator: python -m unittest discover scripts/brand"""
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import kit_icons  # noqa: E402
import mark  # noqa: E402

HEX = re.compile(r'^#[0-9a-f]{6}$')


def _luminance(colour):
    def channel(value):
        c = value / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(colour[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def _contrast(a, b):
    high, low = sorted([_luminance(a), _luminance(b)], reverse=True)
    return (high + 0.05) / (low + 0.05)


class MarkTests(unittest.TestCase):
    def test_mosaic_k_sits_on_a_3x3_grid(self):
        stem, keys, slots = mark.grid_cells()
        self.assertEqual(stem, (58, 52, 44, 152))
        self.assertEqual(keys, [(166, 52, 44, 44), (112, 106, 44, 44), (166, 160, 44, 44)])
        self.assertEqual(slots, [(112, 52, 44, 44), (166, 106, 44, 44), (112, 160, 44, 44)])
        # Stem, keys and slots fill the grid exactly once.
        cells = {(x, y) for x, y, _, _ in keys + slots}
        self.assertEqual(len(cells), 6)

    def test_keys_wear_kit_hues_and_the_stem_is_kition_purple(self):
        kits = {kit.id: kit for kit in kit_icons.KITS}
        self.assertEqual(mark.ICON.stem, '#5645d4')
        self.assertEqual(mark.ICON.keys, ('#d63e95', '#0aa3cf', '#f0701a'))
        self.assertEqual(mark.ICON.keys, tuple(kits[k].hue for _, k in mark.KEYS))
        self.assertEqual(mark.DARK.stem, kits['note'].brand_dark)
        self.assertEqual(mark.DARK.keys, tuple(kits[k].brand_dark for _, k in mark.KEYS))
        for palette in (mark.ICON, mark.LIGHT, mark.DARK):
            for colour in (palette.stem, palette.slot, *palette.keys):
                self.assertRegex(colour, HEX)
            self.assertLess(palette.slot_opacity, .25)

    def test_app_icon_uses_the_kit_icon_tile(self):
        icon = mark.flat_icon_svg()
        self.assertIn(kit_icons.tile_svg('#5645d4'), icon)
        self.assertIn('fill="#e4e1f8"', icon)
        self.assertEqual(icon.count('fill-opacity="0.16"'), 3)

    def test_symbols_have_slots_and_no_tile(self):
        for svg, palette in ((mark.symbol_svg(), mark.LIGHT), (mark.symbol_dark_svg(), mark.DARK)):
            self.assertNotIn('rx="58"', svg)
            self.assertEqual(svg.count(f'fill-opacity="{palette.slot_opacity:g}"'), 3)
            for colour in (palette.stem, *palette.keys):
                self.assertIn(f'fill="{colour}"', svg)

    def test_svg_masters_have_no_live_text_or_rasters(self):
        for svg in (mark.flat_icon_svg(), mark.small_icon_svg(), mark.symbol_svg(), mark.symbol_dark_svg(),
                    mark.lockup_svg(), mark.lockup_dark_svg()):
            self.assertNotIn('<text', svg)
            self.assertNotIn('<image', svg)
            self.assertIn('viewBox=', svg)

    def test_small_cut_has_no_slots(self):
        self.assertNotIn('fill-opacity', mark.small_icon_svg())

    def test_small_cut_sits_on_whole_pixels(self):
        for size in mark.SMALL:
            stem, keys = mark.small_cells(size)
            for rect in [stem, *keys]:
                self.assertTrue(all(float(v).is_integer() for v in rect), (size, rect))
                x, y, w, h = rect
                self.assertTrue(0 < x and x + w < size and 0 < y and y + h < size, (size, rect))

    def test_small_pngs_have_transparent_corners(self):
        for size in (16, 32):
            image = mark.small_icon_png(size)
            self.assertEqual(image.size, (size, size))
            self.assertEqual(image.getpixel((0, 0))[3], 0)

    def test_app_icon_sizes(self):
        self.assertEqual(mark.icon_tile(256).size, (256, 256))
        self.assertEqual(mark.icon_tile(256).getpixel((0, 0))[3], 0)
        touch = mark.icon_tile(180, square=True)
        self.assertEqual(touch.size, (180, 180))
        self.assertEqual(touch.getpixel((0, 0))[3], 255)
        icon = mark.app_icon(256)
        self.assertEqual(icon.size, (256, 256))
        self.assertEqual(icon.getpixel((0, 0))[3], 0)


class KitIconTests(unittest.TestCase):
    def test_kits_in_spec_order(self):
        self.assertEqual([k.id for k in kit_icons.KITS], [
            'note', 'doc', 'table', 'sheet', 'board', 'slide', 'layout',
            'vector', 'photo', 'motion', 'film', 'pdf', 'cad', 'html', 'scene', 'design'])

    def test_each_icon_is_a_flat_soft_tile(self):
        for kit in kit_icons.KITS:
            svg = kit_icons.icon_svg(kit)
            self.assertTrue(svg.startswith('<svg'), kit.id)
            self.assertNotIn('<text', svg, kit.id)
            self.assertIn(f'fill="{kit_icons.tint(kit.hue, .16)}"', svg, kit.id)
            self.assertIn(kit.hue, kit_icons.glyph(kit), kit.id)
            self.assertNotIn('filter', svg, kit.id)
            self.assertNotIn('gloss', svg, kit.id)

    def test_tint_mixes_with_white(self):
        self.assertEqual(kit_icons.tint('#000000', 0), '#ffffff')
        self.assertEqual(kit_icons.tint('#000000', 1), '#000000')
        self.assertEqual(kit_icons.tint('#2b5cd9', .16), '#dde5f9')

    def test_small_icons_use_the_hue(self):
        for kit in kit_icons.KITS:
            self.assertIn(kit.hue, kit_icons.small_icon_svg(kit), kit.id)

    def test_colors_json_names_each_kit(self):
        palette = json.loads(kit_icons.colors_json())
        self.assertEqual(palette['layout']['kitId'], 'kit.layout')
        self.assertEqual(palette['photo'], {'kitId': 'kit.photo', 'light': '#087fa1', 'dark': '#4ccbf0'})

    def test_small_icons_are_flat_and_bold(self):
        for kit in kit_icons.KITS:
            svg = kit_icons.small_icon_svg(kit)
            self.assertTrue(svg.startswith('<svg'), kit.id)
            self.assertNotIn('<text', svg, kit.id)
            self.assertNotIn('filter', svg, kit.id)
            self.assertNotIn('url(#gloss)', svg, kit.id)

    def test_colours_are_lowercase_hex(self):
        for kit in kit_icons.KITS:
            for colour in (kit.hue, kit.brand_light, kit.brand_dark):
                self.assertRegex(colour, HEX, kit.id)

    def test_brand_purple_is_reserved_for_kition_and_note(self):
        for kit in kit_icons.KITS:
            if kit.id == 'note':
                continue
            for colour in (kit.hue, kit.brand_light):
                self.assertNotEqual(colour, '#5645d4', kit.id)

    def test_brands_pass_the_kit_ui_contrast_rules(self):
        # kition-sdk tools/check-manifest.mjs, U5b.
        for kit in kit_icons.KITS:
            self.assertGreaterEqual(_contrast(kit.brand_light, '#ffffff'), 4.5, kit.id)
            self.assertGreaterEqual(_contrast(kit.brand_dark, '#000000'), 4.5, kit.id)
            for surface in ('#1b1e23', '#323232'):
                self.assertGreaterEqual(_contrast(kit.brand_dark, surface), 3, kit.id)

    def test_hues_are_distinct(self):
        hues = [kit.hue for kit in kit_icons.KITS]
        self.assertEqual(len(hues), len(set(hues)))


if __name__ == '__main__':
    unittest.main()
