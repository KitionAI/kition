import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { kitEngine, openInKitFrame, openKitWorkspace } from './helpers/embeddedKit'

/**
 * Kition's interface designs are `.kdesign` files the Design kit (`kit.design`, KitionAI/kition-design) edits
 * in its own editor (KitFrame). This covers what Kition adds around the kit: opening a design from
 * the tree, editing it, saving through Kition's file API, the create menu making a new design
 * with the kit's engine in the page, and a library file the design links where it is (Kit UI
 * protocol 2.5 `links/pick`). The editor's own behavior is tested in the kit's repository.
 */

type NodeDesignDocument = { execute(command: string, params: string): string; query(name: string, params: string): string; inspect(): string; save(): Uint8Array; free(): void }
const engine = kitEngine<{ DesignDocument: { create(name: string, width: number, height: number): NodeDesignDocument; open(name: string, bytes: Uint8Array): NodeDesignDocument } }>('design', 'kition_design_kit')
const missing = 'the Design kit is not built into public/kits/design-ui (scripts/build-kit-ui.sh design)'

/** A design made by the engine the page runs: the starter frame and a rectangle on it. */
async function screenFixture() {
  const sdk = await engine.load()
  const doc = sdk.DesignDocument.create('Screen.kdesign', 1440, 1024)
  doc.execute('shape.rectangle', JSON.stringify({ x: 120, y: 120, width: 320, height: 200 }))
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** The number of layers in a saved design, as the engine reads it. */
async function layersOf(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.DesignDocument.open('Saved.kdesign', bytes)
  const layers = (JSON.parse(doc.inspect()) as { layers: number }).layers
  doc.free()
  return layers
}

test('opens a design in the Design kit’s own editor, edits it, and saves it through Kition', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, missing)
  test.setTimeout(120_000)
  const fixture = await screenFixture()
  expect(await layersOf(fixture)).toBe(2)
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Screen.kdesign', fixture)
  try {
    await expect(kit.getByTestId('design-toolbar')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)

    // Draw a rectangle with the toolbar's shape tool on the canvas.
    await kit.getByTestId('design-caret-shape').click()
    await kit.getByTestId('design-flyout-tool-rectangle').click()
    const canvas = (await kit.getByTestId('kit-canvas-surface').boundingBox())!
    const from = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 40, from.y + 30, { steps: 6 })
    await page.mouse.move(from.x + 80, from.y + 60, { steps: 6 })
    await page.mouse.up()
    await page.screenshot({ path: testInfo.outputPath('design-embedded.png') })

    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => saves.map((save) => save.path), { timeout: 30_000 }).toEqual(['Screen.kdesign'])
    expect(await layersOf(saves[0]!.bytes)).toBe(3)
  } finally {
    await host.dispose()
  }
})

test('makes a new design with the Design kit’s engine from the create menu and opens it in the kit', async ({ page, baseURL }) => {
  test.skip(!engine.built, missing)
  test.setTimeout(120_000)
  const { host, saves } = await openKitWorkspace(page, baseURL!, {}, { persist: true })
  try {
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByRole('group', { name: 'Visual' }).getByTestId('workspace-create-design').click()
    await expect.poll(() => saves.map((save) => save.path), { timeout: 60_000 }).toEqual(['Untitled design.kdesign'])
    // The starter design: one frame of the create size.
    expect(await layersOf(saves[0]!.bytes)).toBe(1)
    await expect(page.locator('[data-testid="kit-frame"][data-active="true"]')).toBeVisible()
    const kit = page.frameLocator('[data-testid="kit-frame"][data-active="true"] [data-testid="kit-frame-window"]')
    await expect(kit.getByTestId('design-toolbar')).toBeVisible({ timeout: 60_000 })
  } finally {
    await host.dispose()
  }
})

/**
 * A library file made by the engine: one component, "Button/Primary", published as a library
 * (version 1, purple), and the same file published again after the button turned red (version 2).
 */
async function libraryFixtures() {
  const sdk = await engine.load()
  const doc = sdk.DesignDocument.create('Design System.kdesign', 1200, 800)
  const run = (command: string, params: object) => JSON.parse(doc.execute(command, JSON.stringify(params))) as { id?: number }
  const [starter] = (JSON.parse(doc.query('layers', '{}')) as { rows: Array<{ id: number }> }).rows
  run('edit.delete', { ids: [starter!.id] })
  const button = run('frame.create', { x: 0, y: 0, width: 160, height: 44, name: 'Button/Primary' }).id!
  run('node.set', { id: button, props: { fill: '#5645d4', cornerRadius: 8 } })
  run('component.create', { ids: [button] })
  run('library.publish', { description: 'A primary button.' })
  const v1 = Buffer.from(doc.save())
  run('node.set', { id: button, props: { fill: '#e5484d' } })
  run('library.publish', { description: 'Primary buttons are red.' })
  const v2 = Buffer.from(doc.save())
  doc.free()
  return { v1, v2 }
}

/**
 * A library file that publishes a component ("Button/Primary"), a paint style ("Brand/Primary")
 * and a colour variable ("Primary" in the collection "Theme").
 */
async function styledLibraryFixture() {
  const sdk = await engine.load()
  const doc = sdk.DesignDocument.create('Design System.kdesign', 1200, 800)
  const run = (command: string, params: object) => JSON.parse(doc.execute(command, JSON.stringify(params))) as { id?: number | string }
  const [starter] = (JSON.parse(doc.query('layers', '{}')) as { rows: Array<{ id: number }> }).rows
  run('edit.delete', { ids: [starter!.id] })
  const button = run('frame.create', { x: 0, y: 0, width: 160, height: 44, name: 'Button/Primary' }).id!
  run('node.set', { id: button, props: { fill: '#5645d4', cornerRadius: 8 } })
  run('style.create', { type: 'paint', name: 'Brand/Primary', from: button })
  run('component.create', { ids: [button] })
  const theme = run('variable.createCollection', { name: 'Theme', modes: ['Light', 'Dark'] }).id!
  run('variable.create', { collection: theme, name: 'Primary', type: 'color', values: { Light: '#ffffff', Dark: '#000000' } })
  run('library.publish', { description: 'Brand styles.' })
  const bytes = Buffer.from(doc.save())
  doc.free()
  return bytes
}

/** The library files a saved design names, and the fills of its component instances, as the engine reads them. */
async function libraryUse(bytes: Buffer) {
  const sdk = await engine.load()
  const doc = sdk.DesignDocument.open('Saved.kdesign', bytes)
  const files = (JSON.parse(doc.query('library.files', '{}')) as { files: Array<{ path: string }> }).files.map((file) => file.path)
  type Row = { id: number; type: string; children?: Row[] }
  const flat = (rows: Row[]): Row[] => rows.flatMap((row) => [row, ...flat(row.children ?? [])])
  const rows = flat((JSON.parse(doc.query('layers', JSON.stringify({ all: true }))) as { rows: Row[] }).rows)
  const fills = rows.filter((row) => row.type === 'INSTANCE').map((row) => JSON.stringify((JSON.parse(doc.query('node', JSON.stringify({ id: row.id }))) as { fills?: unknown }).fills))
  doc.free()
  return { files, fills }
}

test('links a library file where it is (links/pick), places its component, and takes its update when the file changes on disk', async ({ page, baseURL }, testInfo) => {
  test.skip(!engine.built, missing)
  test.setTimeout(180_000)
  const { v1, v2 } = await libraryFixtures()
  const others = { 'libraries/Design System.kdesign': v1, 'libraries/Notes.md': Buffer.from('# Notes'), '.kition/Copy.kdesign': v1 }
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'designs/Home.kdesign', await screenFixture(), others, { persist: true })
  try {
    await expect(kit.getByTestId('design-toolbar')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)
    await kit.getByTestId('design-rail-assets').click()
    await kit.getByTestId('design-assets-libraries').click()
    await kit.getByTestId('design-libraries-add-file').click()

    // Kition's own picker, in link mode: only the workspace's .kdesign files, not the design itself
    // or Kition's store, and no import (a linked file stays where it is).
    const picker = page.getByTestId('kit-file-picker')
    await expect(picker).toHaveAttribute('data-mode', 'link')
    const entries = picker.getByTestId('kit-file-picker-entry')
    await expect(entries).toHaveCount(1)
    await expect(entries).toContainText('Design System.kdesign')
    await expect(page.getByTestId('kit-file-picker-import')).toHaveCount(0)
    await entries.click()
    await page.getByTestId('kit-file-picker-confirm').click()
    await expect(picker).toHaveCount(0)

    const row = kit.getByTestId('design-library-Design System')
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toContainText('Version 1')
    // Nothing was copied next to the design.
    expect(existsSync(path.join(host.root, 'designs', 'Design System.kdesign'))).toBe(false)

    // Its component, from the Assets panel, as an instance in the design.
    await kit.getByTestId('design-libraries-back').click()
    const tile = kit.locator('[data-testid^="design-assets-library-"] [aria-label="Button/Primary"]')
    await expect(tile).toHaveCount(1, { timeout: 30_000 })
    await tile.click()
    await page.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => saves.map((save) => save.path), { timeout: 30_000 }).toEqual(['designs/Home.kdesign'])
    const placed = await libraryUse(saves[0]!.bytes)
    expect(placed.files).toEqual(['../libraries/Design System.kdesign'])
    expect(placed.fills).toHaveLength(1)
    expect(placed.fills[0]).toContain('#5645D4')

    // The library is published again on disk: the design offers the update, and takes it.
    await fs.writeFile(path.join(host.root, 'libraries', 'Design System.kdesign'), v2)
    await expect(kit.getByTestId('design-assets-updates')).toBeVisible({ timeout: 30_000 })
    await kit.getByTestId('design-assets-updates-review').click()
    await expect(kit.getByTestId('design-assets-updates-list')).toContainText('Button/Primary')
    await kit.getByTestId('design-assets-update').click()
    await expect(kit.getByTestId('design-assets-updates')).toHaveCount(0, { timeout: 30_000 })
    await page.screenshot({ path: testInfo.outputPath('design-library.png') })
    await kit.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => saves.length, { timeout: 30_000 }).toBe(2)
    expect(saves[1]!.path).toBe('designs/Home.kdesign')
    const updated = await libraryUse(saves[1]!.bytes)
    expect(updated.files).toEqual(['../libraries/Design System.kdesign'])
    expect(updated.fills).toHaveLength(1)
    expect(updated.fills[0]).toContain('#E5484D')
    // The library file is the one on disk, untouched by the design.
    expect(Buffer.compare(await fs.readFile(path.join(host.root, 'libraries', 'Design System.kdesign')), v2)).toBe(0)
  } finally {
    await host.dispose()
  }
})

test('lists a linked library file’s styles and colour variables under its name in the style picker', async ({ page, baseURL }) => {
  // Fails rather than skips without the package: this case is a golden gate.
  expect(engine.built, missing).toBe(true)
  test.setTimeout(180_000)
  const library = await styledLibraryFixture()
  const { host, kit } = await openInKitFrame(page, baseURL!, 'designs/Home.kdesign', await screenFixture(), { 'libraries/Design System.kdesign': library })
  try {
    await expect(kit.getByTestId('design-toolbar')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('kit-opening')).toHaveCount(0)
    await kit.getByTestId('design-rail-assets').click()
    await kit.getByTestId('design-assets-libraries').click()
    await kit.getByTestId('design-libraries-add-file').click()
    const picker = page.getByTestId('kit-file-picker')
    await picker.getByTestId('kit-file-picker-entry').filter({ hasText: 'Design System.kdesign' }).click()
    await page.getByTestId('kit-file-picker-confirm').click()
    await expect(kit.getByTestId('design-library-Design System')).toBeVisible({ timeout: 30_000 })

    // A layer with a fill, then the fill's Styles button: the library's paint style follows under
    // its name, and its colour variables as "Design System · Theme".
    await kit.getByTestId('design-libraries-back').click()
    const tile = kit.locator('[data-testid^="design-assets-library-"] [aria-label="Button/Primary"]')
    await expect(tile).toHaveCount(1, { timeout: 30_000 })
    await tile.click()
    await kit.getByTestId('design-fill-styles').click()
    await expect(kit.getByTestId('design-style-picker')).toBeVisible()
    const section = kit.locator('[data-testid^="design-style-library-"]:not([data-testid^="design-style-library-variables-"])')
    await expect(section).toHaveCount(1, { timeout: 30_000 })
    await expect(section).toContainText('Design System')
    await expect(section).toContainText('Brand')
    // "Brand/Primary" shows as "Primary" in the folder "Brand", as upstream lists a style's path.
    await expect(section.locator('[data-testid^="design-library-style-"]')).toHaveText(/Primary/)
    await expect(kit.locator('[data-testid^="design-style-library-variables-"]').first()).toContainText('Design System · Theme')
  } finally {
    await host.dispose()
  }
})
