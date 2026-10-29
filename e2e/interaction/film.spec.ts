/**
 * Interaction suite: the Film kit (`kit.film`) in Kition, on the mocked desktop shell.
 * Runs only on demand: `pnpm test:interaction:e2e --grep @film`.
 *
 * Host matrix rows not covered here:
 * - H9 (worker crash): the kit's engine Worker lives inside the kit's frame, out of the test's reach.
 * - H10, H11 (history, print) are covered by the note-history and kit-print specs.
 * - H12 (agent): no e2e case for this kit yet; headless-draft.spec.ts drives only kit.sheet.
 * - H13 (co-editing): covered by e2e/collab-film.spec.ts.
 * - H14 (theme and language): kit-editor follows Kition's theme through kitionTheme; not kit-specific.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import { openInKitFrame } from '../helpers/embeddedKit'
import { filmAddEdit, filmClips, filmPlay } from '../helpers/film'
import { hostMatrix, nodeEngine, type NodeDocument } from './helpers-b'
import { tags } from './support'

const CLIP_FILE = path.join(process.cwd(), 'e2e', 'fixtures', 'film', 'bars.mp4')
const engine = nodeEngine('film', 'FilmDocument')

/** Lends the clip `bars.mp4` (beside the project) to the engine in Node, as Kition's worker does. */
async function lendClip() {
  const clip = await fs.readFile(CLIP_FILE)
  Object.assign(globalThis, {
    kitionHost: {
      size: (file: string) => (file === 'bars.mp4' ? clip.byteLength : 0),
      readRange: (file: string, offset: number, length: number) => new Uint8Array(file === 'bars.mp4' ? clip.subarray(offset, offset + length) : []),
    },
  })
  return clip
}

/** The clips on the first video track of a saved project. */
async function clipsOf(bytes: Buffer) {
  await lendClip()
  const state = await engine.inspect('Saved.kfilm', bytes)
  return (state.sequence.video as Array<{ items: unknown[] }>)[0]!.items.length
}

/** A project with the clip placed `count` times on V1, one after another. */
async function trailer(count: number) {
  await lendClip()
  return engine.make('Trailer.kfilm', 320, 180, (doc: NodeDocument) => {
    const imported = JSON.parse(doc.execute('file.import', JSON.stringify({ paths: ['bars.mp4'] }))) as { items: number[] }
    for (let index = 0; index < count; index += 1) doc.execute('timeline.place', JSON.stringify({ item: imported.items[0], track: 'V1', seconds: index * 5 }))
  })
}

/** Plays a moment (an edit at 0 does nothing), stops, and adds an edit at the playhead. */
async function splitAtPlayhead(page: Page, kit: FrameLocator) {
  await filmPlay(kit).click()
  await expect(kit.getByTestId('film-timecode')).not.toHaveText('00:00:00:00')
  await filmPlay(kit).click()
  await filmAddEdit(page, kit)
}

const shows = (kit: FrameLocator, count: number) => expect(filmClips(kit)).toHaveCount(count, { timeout: 60_000 })

hostMatrix({
  kit: 'film',
  createGroup: 'Media',
  createdName: 'Untitled film.kfilm',
  file: 'Trailer.kfilm',
  others: async () => ({ 'bars.mp4': await lendClip() }),
  fixture: () => trailer(1),
  variant: () => trailer(3),
  measure: clipsOf,
  counts: { fixture: 1, edited: 2, variant: 3 },
  shows: (_page, kit, count) => shows(kit, count),
  edit: splitAtPlayhead,
  timeout: 240_000,
})

test.describe('film details', () => {
  test.beforeEach(() => {
    test.skip(!engine.built, 'the Film kit is not built into public/kits/film-ui')
    test.setTimeout(240_000)
  })

  test('a split clip, with its second half deleted, saves as one shorter clip', tags('film', ['H3'], true), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Trailer.kfilm', await trailer(1), { 'bars.mp4': await lendClip() })
    try {
      await shows(kit, 1)
      await splitAtPlayhead(page, kit)
      await shows(kit, 2)
      await filmClips(kit).nth(1).click()
      await page.keyboard.press('Delete')
      await shows(kit, 1)
      await kit.getByTestId('film-save').click()
      await expect.poll(() => saves.some((save) => save.path === 'Trailer.kfilm'), { timeout: 30_000 }).toBe(true)
      expect(await clipsOf(saves.filter((save) => save.path === 'Trailer.kfilm').at(-1)!.bytes)).toBe(1)
    } finally {
      await host.dispose()
    }
  })

  test('playing and stopping move the playhead and leave nothing to save', tags('film', ['H7']), async ({ page, baseURL }) => {
    const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Trailer.kfilm', await trailer(1), { 'bars.mp4': await lendClip() })
    try {
      await shows(kit, 1)
      await filmPlay(kit).click()
      await expect(kit.getByTestId('film-timecode')).not.toHaveText('00:00:00:00')
      await filmPlay(kit).click()
      await expect(kit.getByTestId('film-unsaved')).toHaveCount(0)
      expect(saves).toEqual([])
    } finally {
      await host.dispose()
    }
  })
})
