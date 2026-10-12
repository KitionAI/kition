import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame } from './helpers/embeddedKit'

const CLIP = path.join(process.cwd(), 'e2e', 'fixtures', 'film', 'bars.mp4')

type NodeFilmDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ FilmDocument: { create(name: string, width: number, height: number): NodeFilmDocument } }>('film', 'kition_film_sdk')

/** films/Trailer.fcproj with clips/bars.mp4 on V1, made by the engine the page runs; Node lends the clip as Kition's worker does. */
async function trailerFixture(clip: Buffer) {
  Object.assign(globalThis, {
    kitionHost: {
      size: (file: string) => (file === '../clips/bars.mp4' ? clip.byteLength : 0),
      readRange: (file: string, offset: number, length: number) => new Uint8Array(file === '../clips/bars.mp4' ? clip.subarray(offset, offset + length) : []),
    },
  })
  const sdk = await engine.load()
  const doc = sdk.FilmDocument.create('Trailer.fcproj', 320, 180)
  const imported = JSON.parse(doc.execute('file.import', JSON.stringify({ paths: ['../clips/bars.mp4'] }))) as { items: number[] }
  doc.execute('timeline.place', JSON.stringify({ item: imported.items[0], track: 'V1', seconds: 0 }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

test('opens a video project in the Film kit’s own editor, edits it there, and exports through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Film kit editor is not built into public/kits/film-ui')
  test.setTimeout(180_000)
  const clip = await fs.readFile(CLIP)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'films/Trailer.fcproj', await trailerFixture(clip), { 'clips/bars.mp4': clip })
  try {
    await expect(kit.getByTestId('film-track-Video 1')).toContainText('bars.mp4', { timeout: 60_000 })
    await expect(kit.getByTestId('film-menu-Sequence')).toHaveText('Sequence')
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // Play a moment, split at the playhead: the clip is lent from the workspace in ranges.
    await kit.getByTestId('film-play').click()
    await expect(kit.getByTestId('film-timecode')).not.toHaveText('00:00:00:00')
    await kit.getByTestId('film-play').click()
    await kit.getByTestId('film-split').click()
    await expect(kit.getByTestId('film-track-Video 1').locator('[data-testid^="film-clip-"]')).toHaveCount(2)
    await expect(kit.getByTestId('film-unsaved')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('film-embedded.png') })

    // The export arrives through host/write (export) beside the project.
    await kit.getByTestId('film-export').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 150_000 }).toContain('films/Trailer.mp4')
    await kit.getByTestId('film-save').click()
    await expect(kit.getByTestId('film-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toContain('films/Trailer.fcproj')
  } finally {
    await host.dispose()
  }
})
