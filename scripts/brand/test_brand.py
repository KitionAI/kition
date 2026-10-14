"""Unit tests for the brand generator: python -m unittest discover scripts/brand"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import kit_icons  # noqa: E402
import mark  # noqa: E402


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
            'document', 'word', 'table', 'sheet', 'board', 'slide', 'design', 'layout',
            'vector', 'photo', 'effect', 'film', 'pdf', 'cad'])

    def test_each_icon_is_a_self_contained_svg(self):
        for kit in kit_icons.KITS:
            svg = kit_icons.icon_svg(kit)
            self.assertTrue(svg.startswith('<svg'), kit.id)
            self.assertNotIn('<text', svg, kit.id)
            self.assertIn(kit.mid, svg, kit.id)

    def test_small_icons_are_flat_and_bold(self):
        for kit in kit_icons.KITS:
            svg = kit_icons.small_icon_svg(kit)
            self.assertTrue(svg.startswith('<svg'), kit.id)
            self.assertNotIn('<text', svg, kit.id)
            self.assertNotIn('filter', svg, kit.id)
            self.assertNotIn('url(#gloss)', svg, kit.id)

    def test_brand_purple_is_reserved_for_kition(self):
        for kit in kit_icons.KITS:
            self.assertNotIn('#5645d4', kit_icons.icon_svg(kit).lower(), kit.id)


if __name__ == '__main__':
    unittest.main()
