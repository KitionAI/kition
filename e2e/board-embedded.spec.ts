import { expect, test, type FrameLocator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { openInKitFrame } from './helpers/embeddedKit'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { canReadBlobBodies } from './helpers/requestBody'

/**
 * The Board kit (`kit.board`, packages/board-kit), which Kition does not use for its own boards: a
 * development build opens `.kiboard` files in it when this flag is set (`boardKitForDevelopment`
 * in kitEditors.ts).
 */
const BOARD_KIT_DEV_FLAG = 'kition.dev.boardKit'
/** Set in the tab's session storage, the next load opens boards natively again. */
const NATIVE_MARK = 'e2e.board-embedded.native'

type BoardDoc = { execute(command: string, params: string): string; inspect(): string; save(): Uint8Array }
type BoardSdk = { BoardDocument: { create(name: string, width: number, height: number): BoardDoc; open(name: string, bytes: Uint8Array): BoardDoc } }

/** The kit's TypeScript engine in its package (`ts-worker`), loaded in Node to make and read fixtures. */
const engineDir = path.join(process.cwd(), 'public', 'kits', 'board-ui', 'engine')
const built = existsSync(path.join(engineDir, 'kition_board_engine.js')) && existsSync(path.join(engineDir, '..', 'kit-ui.json'))
async function loadEngine() {
  const sdk = (await import(pathToFileURL(path.join(engineDir, 'kition_board_engine.js')).href)) as BoardSdk & { default: (init: { base: string; read: (file: string) => Promise<Uint8Array> }) => Promise<void> }
  await sdk.default({ base: pathToFileURL(engineDir + path.sep).href, read: async (file) => new Uint8Array(await fs.readFile(path.join(engineDir, file))) })
  return sdk
}

const note = (id: string, text: string, x: number) => ({ id, kind: 'rectangle', x, y: 120, width: 180, height: 110, text, shapeType: 'rectangle', shapeStyle: 'sticky' })

/** A board made by the engine the kit runs: two notes. */
async function planFixture() {
  const sdk = await loadEngine()
  const doc = sdk.BoardDocument.create('Plan.kiboard', 1920, 1080)
  doc.execute('element.create', JSON.stringify({ elements: [note('note-goals', 'Goals', 120), note('note-risks', 'Risks', 380)] }))
  return Buffer.from(doc.save())
}

/** The element count of a saved board, read by the engine. */
async function elementsOf(bytes: Buffer) {
  const sdk = await loadEngine()
  return (JSON.parse(sdk.BoardDocument.open('Plan.kiboard', bytes).inspect()) as { elements: number }).elements
}

async function openBoardsInKitUntilNative(page: Page) {
  await page.addInitScript(
    ({ flag, mark }) => {
      if (window.sessionStorage.getItem(mark)) window.localStorage.removeItem(flag)
      else window.localStorage.setItem(flag, '1')
    },
    { flag: BOARD_KIT_DEV_FLAG, mark: NATIVE_MARK },
  )
}

/** Draws a rectangle on the kit's board canvas, by page coordinates of its scene. */
async function drawRectangle(page: Page, kit: FrameLocator) {
  await kit.getByTestId('whiteboard-tool-rectangle').click()
  const bounds = await kit.getByTestId('whiteboard-svg-scene').boundingBox()
  if (!bounds) throw new Error('the board scene is not measurable')
  await page.mouse.move(bounds.x + 300, bounds.y + 420)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 460, bounds.y + 520, { steps: 8 })
  await page.mouse.up()
}

test('opens a board in the Board kit, draws on it, saves it, and Kition opens the saved file natively', async ({ page, baseURL, browserName }, testInfo) => {
  test.skip(!built, 'the Board kit is not built into public/kits/board-ui (scripts/build-kit-ui.sh board)')
  test.setTimeout(180_000)
  await openBoardsInKitUntilNative(page)
  const name = 'Plan.kiboard'
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, name, await planFixture(), {}, { persist: true })
  try {
    // Kition's own board editor, inside the kit's frame, over the kit's TypeScript engine.
    await expect(kit.getByTestId('whiteboard-editor-pane')).toBeVisible({ timeout: 60_000 })
    await expect(kit.getByTestId('board-title')).toHaveText(name)
    await expect(kit.locator('[data-element-id="note-goals"]')).toBeVisible()
    await expect(kit.locator('[data-element-id="note-risks"]')).toBeVisible()
    await expect(kit.locator('[data-element-id]')).toHaveCount(2)

    // An edit in the editor reaches the engine: the document is unsaved.
    await drawRectangle(page, kit)
    await expect(kit.locator('[data-element-id]')).toHaveCount(3)
    await expect(kit.getByTestId('board-unsaved')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('board-embedded.png') })

    await kit.getByTestId('board-save').click()
    await expect(kit.getByTestId('board-unsaved')).toHaveCount(0, { timeout: 30_000 })
    // The editor's replica and the engine's exchanged every change without a failure.
    await expect(kit.getByText('The board could not sync with its engine')).toHaveCount(0)
    expect(saves.map((save) => save.path)).toEqual([name])
    if (canReadBlobBodies(browserName)) expect(await elementsOf(saves[0].bytes)).toBe(3)

    // Reopened without the kit: Kition's native board editor shows the saved file.
    await page.evaluate((mark) => window.sessionStorage.setItem(mark, '1'), NATIVE_MARK)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Plan' }).first().click()
    const native = page.locator(`[data-testid="whiteboard-editor-pane"][data-board-path="${name}"]`)
    await expect(native).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('kit-frame')).toHaveCount(0)
    await expect(native.locator('[data-element-id]')).toHaveCount(3)
    await expect(native.locator('[data-element-id="note-goals"]')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('board-native.png') })
  } finally {
    await host.dispose()
  }
})
