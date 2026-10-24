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
    def test_grid_is_centred_and_spans_62_percent(self):
        stem, keys, slots = mark.grid_cells(46, 11)
        self.assertEqual(stem, (48.0, 48.0, 46, 160))
        self.assertEqual(len(keys), 3)
        self.assertEqual(len(slots), 3)
        self.assertAlmostEqual(160 / 256, 0.625)

    def test_svg_masters_have_no_live_text_or_rasters(self):
        for svg in (mark.flat_icon_svg(), mark.small_icon_svg(), mark.symbol_svg(), mark.lockup_svg()):
            self.assertNotIn('<text', svg)
            self.assertNotIn('<image', svg)
            self.assertIn('viewBox=', svg)

    def test_small_cut_has_no_slots(self):
        self.assertNotIn('fill-opacity', mark.small_icon_svg())

    def test_small_png_has_transparent_corners(self):
        image = mark.small_icon_png(32)
        self.assertEqual(image.size, (32, 32))
        self.assertEqual(image.getpixel((0, 0))[3], 0)


class KitIconTests(unittest.TestCase):
    def test_kits_in_spec_order(self):
        self.assertEqual([k.id for k in kit_icons.KITS], [
            'note', 'doc', 'table', 'sheet', 'board', 'slide', 'design', 'layout',
            'vector', 'photo', 'effect', 'film', 'pdf', 'cad'])

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
        self.assertEqual(palette['layout']['kitId'], 'kit.design')
        self.assertIsNone(palette['design']['kitId'])
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
