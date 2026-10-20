import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { kitEngine, openInKitFrame, openTreeFile, replicaVersion as embeddedReplicaVersion } from './helpers/embeddedKit'
import { filmAddEdit, filmClips, filmPlay } from './helpers/film'
import { dismissFirstRunActivation } from './helpers/onboarding'

const CLIP = path.join(process.cwd(), 'e2e', 'fixtures', 'film', 'bars.mp4')

type NodeFilmDocument = { save(): Uint8Array; execute(command: string, params: string): string; free(): void }
const engine = kitEngine<{ FilmDocument: { create(name: string, width: number, height: number): NodeFilmDocument } }>('film', 'kition_film_sdk')

/**
 * A project with `clipPath` (relative to the project's own file) on V1, made by the engine the
 * page runs; Node lends the clip as Kition's worker does. Defaults to `films/Trailer.kitionfilm`'s
 * own layout (the clip one folder up, at `clips/bars.mp4`); a project at the workspace root names
 * it directly.
 */
async function trailerFixture(clip: Buffer, clipPath = '../clips/bars.mp4') {
  Object.assign(globalThis, {
    kitionHost: {
      size: (file: string) => (file === clipPath ? clip.byteLength : 0),
      readRange: (file: string, offset: number, length: number) => new Uint8Array(file === clipPath ? clip.subarray(offset, offset + length) : []),
    },
  })
  const sdk = await engine.load()
  const doc = sdk.FilmDocument.create('Trailer.kitionfilm', 320, 180)
  const imported = JSON.parse(doc.execute('file.import', JSON.stringify({ paths: [clipPath] }))) as { items: number[] }
  doc.execute('timeline.place', JSON.stringify({ item: imported.items[0], track: 'V1', seconds: 0 }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

test('opens a video project in the Film kit’s own editor, edits it there, and exports through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Film kit editor is not built into public/kits/film-ui')
  test.setTimeout(180_000)
  const clip = await fs.readFile(CLIP)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'films/Trailer.kitionfilm', await trailerFixture(clip), { 'clips/bars.mp4': clip })
  try {
    await expect(kit.getByTestId('film-track-Video 1')).toContainText('bars.mp4', { timeout: 60_000 })
    await expect(kit.getByTestId('film-menu-Sequence')).toHaveText('Sequence')
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // Play a moment, Add Edit at the playhead: the clip is lent from the workspace in ranges.
    await filmPlay(kit).click()
    await expect(kit.getByTestId('film-timecode')).not.toHaveText('00:00:00:00')
    await filmPlay(kit).click()
    await filmAddEdit(page, kit)
    await expect(filmClips(kit)).toHaveCount(2)
    await expect(kit.getByTestId('film-unsaved')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('film-embedded.png') })

    // The export arrives through host/write (export) beside the project.
    await kit.getByTestId('film-export').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 150_000 }).toContain('films/Trailer.mp4')
    await kit.getByTestId('film-save').click()
    await expect(kit.getByTestId('film-unsaved')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toContain('films/Trailer.kitionfilm')
  } finally {
    await host.dispose()
  }
})

/** The replica version of the kit editor showing `path`, as author counters (Kition's development test hook). */
function replicaVersion(page: Page, path: string) {
  return embeddedReplicaVersion(page, path)
}

test('keeps an .kitionfilm’s replica across a save and a reopen, and opens a file changed elsewhere plainly', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Film kit editor is not built into public/kits/film-ui')
  test.setTimeout(180_000)
  const clip = await fs.readFile(CLIP)
  const name = 'Replica.kitionfilm'
  // A flat name: the document tree's own folder-expand toggle (clicked again on each reopen)
  // would otherwise collapse a folder a previous open already expanded.
  const { host, kit } = await openInKitFrame(page, baseURL!, name, await trailerFixture(clip, 'bars.mp4'), { 'bars.mp4': clip }, { persist: true })
  const reopen = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    return openTreeFile(page, name)
  }
  try {
    await expect(kit.getByTestId('film-track-Video 1')).toContainText('bars.mp4', { timeout: 60_000 })
    // Move the playhead off the clip's start before the edit: an edit at 0 does nothing.
    await filmPlay(kit).click()
    await expect(kit.getByTestId('film-timecode')).not.toHaveText('00:00:00:00')
    await filmPlay(kit).click()
    await filmAddEdit(page, kit)
    await expect(filmClips(kit)).toHaveCount(2)
    await kit.getByTestId('film-save').click()
    await expect(kit.getByTestId('film-unsaved')).toHaveCount(0, { timeout: 30_000 })

    // The replica sits in the document store under the file's identity, with the saved file's stamp.
    const store = path.join(host.root, '.kition', 'docs')
    const readJson = async (file: string) => JSON.parse(await fs.readFile(path.join(store, file), 'utf8').catch(() => '{}'))
    await expect.poll(async () => (await readJson('index.json')).entries?.[name] ?? null, { timeout: 15_000 }).not.toBeNull()
    const docId = (await readJson('index.json')).entries[name] as string
    await expect.poll(async () => (await readJson(`${docId}/meta.json`)).meta?.kit ?? null).toBe('kit.film')
    const saved = await replicaVersion(page, name)
    expect(saved).not.toBe('')

    // Reopened, the project is the replica it was saved with: the edit survives.
    const reopened = await reopen()
    await expect(filmClips(reopened)).toHaveCount(2, { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).toBe(saved)
    await expect(reopened.getByTestId('film-unsaved')).toHaveCount(0)

    // A file changed elsewhere (a new stamp) opens plainly: what the file holds, a new replica.
    await fs.writeFile(path.join(host.root, name), await trailerFixture(clip, 'bars.mp4'))
    const changed = await reopen()
    await expect(filmClips(changed)).toHaveCount(1, { timeout: 60_000 })
    await expect.poll(() => replicaVersion(page, name).catch(() => ''), { timeout: 15_000 }).not.toBe('')
    expect(await replicaVersion(page, name)).not.toBe(saved)
  } finally {
    await host.dispose()
  }
})
