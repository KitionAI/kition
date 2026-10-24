import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'

/**
 * Kition's boards are `.kboard` files the Board kit (`kit.board`, KitionAI/kition-board) edits in
 * its own editor (KitFrame). This covers what Kition adds around the kit: opening a board from the
 * tree, saving through Kition's file API, and the create menu making a new board with the kit's
 * engine in the page. The editor's own behavior is tested in the kit's repository.
 */

type NodeBoardDocument = { execute(command: string, params: string): string; inspect(): string; save(): Uint8Array; free(): void }
const engine = kitEngine<{ BoardDocument: { create(name: string, width: number, height: number): NodeBoardDocument; open(name: string, bytes: Uint8Array): NodeBoardDocument } }>('board', 'kition_board_sdk')

/** A board made by the engine the page runs: one shape. */
async function planFixture() {
  const sdk = await engine.load()
  const doc = sdk.BoardDocument.create('Plan.kboard', 1920, 1080)
  doc.execute('element.create', JSON.stringify({ elements: [{ kind: 'shape', position: { x: 40, y: 40 }, size: { w: 160, h: 100 } }] }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** The element count of a saved board, as the engine reads it. */
async function elementsOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.BoardDocument.open('Saved.kboard', bytes)
  const elements = (JSON.parse(doc.inspect()) as { elements: number }).elements
  doc.free()
  return elements
}

test('opens a board in the Board kit’s own editor, draws on it, and saves it through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, 'the Board kit is not built into public/kits/board-ui (scripts/fetch-kits.mjs or scripts/build-kit-ui.sh board)')
  test.setTimeout(120_000)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Plan.kboard', await planFixture())
  try {
    await expect(kit.getByTestId('board-status')).toContainText('1 elements', { timeout: 60_000 })
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // Draw a rectangle with the shape tool, in an empty part of the view.
    const canvas = (await kit.getByTestId('board-canvas').boundingBox())!
    await page.mouse.click(canvas.x + canvas.width * 0.7, canvas.y + canvas.height * 0.2)
    await page.keyboard.press('r')
    await page.mouse.move(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.6)
    await page.mouse.down()
    await page.mouse.move(canvas.x + canvas.width * 0.6 + 160, canvas.y + canvas.height * 0.6 + 100, { steps: 8 })
    await page.mouse.up()
    await expect(kit.getByTestId('board-status')).toContainText('2 elements')
    await page.screenshot({ path: testInfo.outputPath('board-embedded.png') })

    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => saves.map((save) => save.path), { timeout: 30_000 }).toEqual(['Plan.kboard'])
    expect(await elementsOf(saves[0]!.bytes)).toBe(2)
  } finally {
    await host.dispose()
  }
})

test('makes a new board with the Board kit’s engine from the create menu and opens it in the kit', async ({ page, baseURL }) => {
  test.skip(!engine.built, 'the Board kit is not built into public/kits/board-ui (scripts/fetch-kits.mjs or scripts/build-kit-ui.sh board)')
  test.setTimeout(120_000)
  const { host, saves } = await openKitWorkspace(page, baseURL!, {}, { persist: true })
  try {
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByRole('group', { name: 'Visual' }).getByTestId('workspace-create-board').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toEqual(['Untitled board.kboard'])
    expect(await elementsOf(saves[0]!.bytes)).toBe(0)
    await expect(page.locator('[data-testid="kit-frame"][data-active="true"]')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('board-status')).toContainText('0 elements', { timeout: 60_000 })
  } finally {
    await host.dispose()
  }
})
