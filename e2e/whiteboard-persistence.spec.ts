import { expect, test, type Page } from '@playwright/test'

import workspaceCopy from '../src/i18n/locales/en-US/workspace.json' with { type: 'json' }
import {
  createBoardElementRecord,
  type BoardElementRecord,
} from '../src/features/whiteboard/lib/boardRecords'
import {
  addRecordsToWhiteboardFileExternally,
  countWhiteboardFileWrites,
  failWhiteboardFileWrites,
  openWhiteboardFixture,
  readWhiteboardFile,
  readWhiteboardFileText,
  readWhiteboardSnapshot,
  waitForWhiteboard,
  WHITEBOARD_E2E_PATH,
} from './helpers/whiteboard'

// The Board's `.kiboard` file as a KDM document: saved as a v2 envelope, merged with changes made
// on disk, flushed when the editor closes, and never written when it is a version-1 file.

/** A version-1 (record JSON) file: recognized, opened read-only, never migrated. */
const VERSION_1_FILE = `${JSON.stringify({
  format: 'kition-board',
  version: 1,
  title: 'Whiteboard E2E',
  viewport: { x: 0, y: 0, zoom: 1 },
  records: [
    { record_type: 'page', id: 'page:main', name: 'Page 1', index: 0 },
    { record_type: 'element', id: 'old-node', kind: 'rectangle', x: 0, y: 0, width: 100, height: 60, page_id: 'page:main', index: 0 },
  ],
  updated_at: '2026-01-01T00:00:00.000Z',
}, null, 2)}\n`

test('saves a drawn rectangle as a v2 KDM file that opens again after a reload', async ({ page }) => {
  await openWhiteboardFixture(page)
  const before = await readWhiteboardSnapshot(page)
  const existing = new Set(elementRecords(before.records).map((record) => record.id))

  await page.getByTestId('whiteboard-tool-rectangle').click()
  await dragOnScene(page, { x: 300, y: 480 }, { x: 470, y: 580 })
  const newElements = async () => elementRecords((await readWhiteboardSnapshot(page)).records)
    .filter((record) => !existing.has(record.id))
  await expect.poll(async () => (await newElements()).length).toBe(1)
  const [drawn] = await newElements()
  if (drawn?.kind !== 'rectangle') throw new Error('The drawn element is not a rectangle')

  await expectSavedFileToContain(page, (records) => records.some((record) => record.id === drawn.id))
  const saved = await readWhiteboardFile(page)
  expect(saved).toMatchObject({ envelopeVersion: 2, state: 'board', docId: before.docId })
  expect(JSON.parse((await readWhiteboardFileText(page))!)).toEqual({
    format: 'kition-board',
    version: 2,
    kdm: expect.any(String),
  })
  const savedSnapshot = await readWhiteboardSnapshot(page)

  await page.reload()
  await openBoardFromList(page)
  const reloaded = await readWhiteboardSnapshot(page)
  expect(reloaded.docId).toBe(before.docId)
  expect(reloaded.kdmVersion).toBe(savedSnapshot.kdmVersion)
  expect(elementRecords(reloaded.records).find((record) => record.id === drawn.id))
    .toMatchObject({ kind: 'rectangle', x: drawn.x, y: drawn.y, width: drawn.width, height: drawn.height })
  await expect(page.locator(`[data-element-id="${drawn.id}"]`)).toBeVisible()
})

test('merges an element written to the file on disk with an unsaved local edit', async ({ page }) => {
  await openWhiteboardFixture(page)
  // Loads the in-page KDM helpers now, so the external write below lands within the save delay.
  await readWhiteboardFile(page)
  const writesBefore = await countWhiteboardFileWrites(page)
  const versionBefore = (await readWhiteboardSnapshot(page)).kdmVersion
  const external = createBoardElementRecord({
    element: { id: 'external-note', kind: 'rectangle', x: 720, y: 520, width: 140, height: 80, text: 'From disk' },
    index: 3,
    pageId: '',
  })

  await dragElementBy(page, 'node-a', { x: 90, y: 60 })
  await expect.poll(async () => (await readWhiteboardSnapshot(page)).kdmVersion).not.toBe(versionBefore)
  await addRecordsToWhiteboardFileExternally(page, [external])
  // The local move had not been saved when the file changed on disk.
  expect(await countWhiteboardFileWrites(page)).toBe(writesBefore)

  await expectSavedFileToContain(page, (records) => {
    return records.some((record) => record.id === 'external-note') && isAt(records, 'node-a', { x: 210, y: 200 })
  })
  const snapshot = await readWhiteboardSnapshot(page)
  expect(elementRecords(snapshot.records).find((record) => record.id === 'node-a')).toMatchObject({ x: 210, y: 200 })
  expect(elementRecords(snapshot.records).find((record) => record.id === 'external-note'))
    .toMatchObject({ kind: 'rectangle', text: 'From disk' })
  await expect(page.locator('[data-element-id="external-note"]')).toBeVisible()
  await expect(page.getByTestId('board-save-status')).toHaveText(workspaceCopy.board.status.ready)
  // The change event merged the file before saving: one write, not a refused one and a retry.
  expect(await countWhiteboardFileWrites(page)).toBe(writesBefore + 1)
})

test('saves a move when the Board closes before the save delay ends', async ({ page }) => {
  await openWhiteboardFixture(page)
  await readWhiteboardFile(page)
  const writesBefore = await countWhiteboardFileWrites(page)

  await dragElementBy(page, 'node-b', { x: 90, y: 60 })
  const movedAt = Date.now()
  // Close the tab from inside the page, so nothing waits between the move and the close.
  const closing = await page.evaluate(() => {
    const writes = window.__KITION_WHITEBOARD_E2E_FILE__?.writes ?? -1
    const close = document.querySelector<HTMLButtonElement>('.document-tab-list .document-tab-close')
    if (!close) throw new Error('The Board tab has no close button')
    const at = performance.now()
    close.click()
    return { at, writes }
  })
  expect(Date.now() - movedAt).toBeLessThan(100)
  expect(closing.writes).toBe(writesBefore)

  await expect(page.getByTestId('whiteboard-editor-pane')).toHaveCount(0)
  await expectSavedFileToContain(page, (records) => {
    return isAt(records, 'node-b', { x: 510, y: 200 })
  })
  // Written by the close itself, well before the 600 ms save delay would have run out.
  const lastWriteAt = await page.evaluate(() => window.__KITION_WHITEBOARD_E2E_FILE__?.lastWriteAt ?? null)
  expect(lastWriteAt).not.toBeNull()
  expect(lastWriteAt! - closing.at).toBeLessThan(300)
})

test('opens a version-1 file read-only and leaves it unchanged', async ({ page }) => {
  await openWhiteboardFixture(page, { fileContent: VERSION_1_FILE, expectView: 'notice' })

  const notice = page.getByTestId('whiteboard-file-notice')
  await expect(notice).toHaveAttribute('data-problem', 'version-1')
  await expect(notice).toContainText(workspaceCopy.whiteboard.file.unsupported)
  await expect(page.getByTestId('whiteboard-svg-scene')).toHaveCount(0)
  // Longer than the save delay and the first retry: nothing is written on its own.
  await page.waitForTimeout(1_500)
  expect(await readWhiteboardFileText(page)).toBe(VERSION_1_FILE)
  expect(await countWhiteboardFileWrites(page)).toBe(0)
})

test('replaces a version-1 file with a new Board only after Start a new Board is confirmed', async ({ page }) => {
  await openWhiteboardFixture(page, { fileContent: VERSION_1_FILE, expectView: 'notice' })
  await page.waitForTimeout(800)
  expect(await readWhiteboardFileText(page)).toBe(VERSION_1_FILE)
  expect(await countWhiteboardFileWrites(page)).toBe(0)

  // Cancelling the confirmation keeps the file.
  const confirmation = page.getByTestId('whiteboard-start-new-confirm')
  await page.getByTestId('whiteboard-file-start-new').click()
  await expect(confirmation).toContainText(workspaceCopy.whiteboard.file.startNewConfirmTitle)
  await confirmation.getByTestId('cancel-btn').click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.getByTestId('whiteboard-file-notice')).toBeVisible()
  expect(await readWhiteboardFileText(page)).toBe(VERSION_1_FILE)
  expect(await countWhiteboardFileWrites(page)).toBe(0)

  await page.getByTestId('whiteboard-file-start-new').click()
  await confirmation.getByTestId('confirm-btn').click()
  await waitForWhiteboard(page)
  expect(await countWhiteboardFileWrites(page)).toBe(1)
  const file = await readWhiteboardFile(page)
  expect(file).toMatchObject({ envelopeVersion: 2, state: 'board' })
  expect(elementRecords(file.records)).toEqual([])
  const snapshot = await readWhiteboardSnapshot(page)
  expect(snapshot.docId).toBe(file.docId)
  expect(elementRecords(snapshot.records)).toEqual([])
})

test('explains a save that kept conflicting and saves once the file settles', async ({ page }) => {
  await openWhiteboardFixture(page)
  await failWhiteboardFileWrites(page, 'DESIGN_SAVE_CONFLICT')

  await dragElementBy(page, 'node-c', { x: 90, y: 60 })
  const status = page.getByTestId('board-save-status')
  await expect(status).toHaveText(workspaceCopy.board.status.error)
  await expect(status).toHaveAttribute('title', workspaceCopy.whiteboard.file.saveConflict)

  await failWhiteboardFileWrites(page, null)
  // The first retry runs a second after the failure.
  await expect(status).toHaveText(workspaceCopy.board.status.ready, { timeout: 10_000 })
  await expect(status).not.toHaveAttribute('title', /.+/)
  await expectSavedFileToContain(page, (records) => {
    return isAt(records, 'node-c', { x: 810, y: 380 })
  })
})

test('closes a Board whose save keeps failing only after its changes are discarded, leaving the file as it was', async ({ page }) => {
  await openWhiteboardFixture(page)
  const opened = await readWhiteboardFileText(page)
  expect(opened).not.toBeNull()
  await failWhiteboardFileWrites(page, 'The folder is gone')

  await dragElementBy(page, 'node-a', { x: 90, y: 60 })
  await expect(page.getByTestId('board-save-status')).toHaveText(workspaceCopy.board.status.error)

  // Keeping the tab open keeps the Board and its unsaved move.
  const close = page.locator('.document-tab-list .document-tab-close')
  const confirmation = page.getByTestId('board-close-unsaved-confirm')
  await close.click()
  await expect(confirmation).toContainText(workspaceCopy.whiteboard.file.closeUnsavedMessage)
  await expect(confirmation.getByTestId('confirm-btn')).toHaveText(workspaceCopy.whiteboard.file.closeUnsavedDiscard)
  await expect(confirmation.getByTestId('cancel-btn')).toHaveText(workspaceCopy.whiteboard.file.closeUnsavedKeep)
  await confirmation.getByTestId('cancel-btn').click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.getByTestId('whiteboard-editor-pane')).toBeVisible()
  expect(elementRecords((await readWhiteboardSnapshot(page)).records).find((record) => record.id === 'node-a'))
    .toMatchObject({ x: 210, y: 200 })

  await close.click()
  await confirmation.getByTestId('confirm-btn').click()
  await expect(page.getByTestId('whiteboard-editor-pane')).toHaveCount(0)
  const writes = await countWhiteboardFileWrites(page)
  // Writes would succeed now, so any save or retry left after discarding would change the file.
  await failWhiteboardFileWrites(page, null)
  await page.waitForTimeout(2_500)
  expect(await countWhiteboardFileWrites(page)).toBe(writes)
  expect(await readWhiteboardFileText(page)).toBe(opened)
})

function elementRecords(records: readonly { record_type: string }[]) {
  return records.filter((record): record is BoardElementRecord => record.record_type === 'element')
}

/** Whether the rectangle `id` among `records` sits at `position`. */
function isAt(records: BoardElementRecord[], id: string, position: { x: number; y: number }) {
  const record = records.find((candidate) => candidate.id === id)
  return record?.kind === 'rectangle' && record.x === position.x && record.y === position.y
}

async function expectSavedFileToContain(
  page: Page,
  predicate: (records: BoardElementRecord[]) => boolean,
) {
  await expect.poll(async () => {
    const file = await readWhiteboardFile(page)
    return file.state === 'board' && predicate(elementRecords(file.records))
  }, { timeout: 10_000 }).toBe(true)
}

async function openBoardFromList(page: Page) {
  const scene = page.getByTestId('whiteboard-svg-scene')
  if (!await scene.isVisible()) {
    await page.goto('/documents')
    await page.getByText(WHITEBOARD_E2E_PATH, { exact: true }).click()
  }
  await waitForWhiteboard(page)
}

async function dragOnScene(page: Page, start: { x: number; y: number }, end: { x: number; y: number }) {
  const bounds = await page.getByTestId('whiteboard-svg-scene').boundingBox()
  if (!bounds) throw new Error('Whiteboard scene is not measurable')
  await page.mouse.move(bounds.x + start.x, bounds.y + start.y)
  await page.mouse.down()
  await page.mouse.move(bounds.x + end.x, bounds.y + end.y, { steps: 8 })
  await page.mouse.up()
}

/** Drags an element by `offset` at zoom 1 (the fixture's viewport), committing one move. */
async function dragElementBy(page: Page, id: string, offset: { x: number; y: number }) {
  const bounds = await page.locator(`[data-element-id="${id}"]`).boundingBox()
  if (!bounds) throw new Error(`Whiteboard element ${id} is not measurable`)
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + offset.x, y + offset.y, { steps: 8 })
  await page.mouse.up()
}
