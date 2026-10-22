"""Regenerate every Kition brand asset from source.

    python3 -m venv scripts/brand/.venv
    scripts/brand/.venv/bin/pip install -r scripts/brand/requirements.txt
    scripts/brand/.venv/bin/python scripts/brand/build.py
    scripts/brand/.venv/bin/python scripts/brand/build.py --kits   kit icons and kit colors only

Writes public/brand, public/kit-icons, the logo PNGs, and src-tauri/icons
(through `pnpm tauri icon`). Requires node_modules for the Inter font.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import kit_icons  # noqa: E402
import mark  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
TAURI_ICONS = ['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns', 'icon.ico']


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print('wrote', path.relative_to(ROOT))


def save(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)
    print('wrote', path.relative_to(ROOT))


def write_kits():
    for kit in kit_icons.KITS:
        write(ROOT / 'public/kit-icons' / f'{kit.id}.svg', kit_icons.icon_svg(kit))
        write(ROOT / 'public/kit-icons' / f'{kit.id}-small.svg', kit_icons.small_icon_svg(kit))
    write(ROOT / 'src/app/kit-colors.css', kit_icons.colors_css())
    write(ROOT / 'kits/kit-colors.json', kit_icons.colors_json())


def main():
    brand = ROOT / 'public/brand'
    write(brand / 'kition-symbol.svg', mark.symbol_svg())
    write(brand / 'kition-icon-flat.svg', mark.flat_icon_svg())
    write(brand / 'kition-icon-small.svg', mark.small_icon_svg())
    write(brand / 'kition-lockup.svg', mark.lockup_svg())
    write_kits()

    tile = mark.icon_3d_tile(512).resize((256, 256), mark.Image.LANCZOS)
    for target in ('public/logo-mark.png', 'public/onboarding/logo.png', 'docs/readme/kition-logo-mark.png'):
        save(tile, ROOT / target)
    save(mark.small_icon_png(32), ROOT / 'public/favicon.png')

    with tempfile.TemporaryDirectory() as tmp:
        source = Path(tmp) / 'app-icon.png'
        mark.app_icon(1024).save(source)
        subprocess.run(['pnpm', '-s', 'tauri', 'icon', str(source), '--output', tmp], cwd=ROOT, check=True)
        for name in TAURI_ICONS:
            shutil.copyfile(Path(tmp) / name, ROOT / 'src-tauri/icons' / name)
            print('wrote', f'src-tauri/icons/{name}')


if __name__ == '__main__':
    if sys.argv[1:] == ['--kits']:
        write_kits()
    else:
        main()
