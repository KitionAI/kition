import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import type { DesignDocument } from '../src/features/design/lib/designTypes'
import designChinese from '../src/i18n/locales/zh-CN/design.json' with { type: 'json' }
const key = 'kition.workspace.documents.v1'
async function create(page: Page) {
  await mockLocalWorkspaceApi(page)
  await page.goto('/documents')
  await dismissFirstRunActivation(page)
  await page
    .locator('.document-private-heading .document-create-menu-anchor > button')
    .click()
  await page.getByTestId('workspace-create-design').click()
  await expect(page.getByTestId('design-editor')).toBeVisible()
}
async function read(page: Page): Promise<DesignDocument> {
  return page.evaluate((storageKey) => {
    const records = JSON.parse(localStorage.getItem(storageKey) || '{}')
    return JSON.parse(records['Untitled design.kidesign'].content)
  }, key)
}
async function number(page: Page, label: string, value: number) {
  const field = page.getByRole('spinbutton', { name: label, exact: true })
  await field.fill(String(value))
  await field.press('Enter')
}
async function saved(page: Page) {
  await expect(page.getByTestId('design-save-status')).toHaveText('Saved')
}
async function fixtureImage(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 60
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 50, 60)
    ctx.fillStyle = '#0000ff'
    ctx.fillRect(50, 0, 50, 60)
    return canvas.toDataURL().split(',')[1]
  })
  return Buffer.from(data, 'base64')
}
test('creates, edits, crops, saves, reopens, and exports a native poster', async ({
  page,
}) => {
  test.setTimeout(75_000)
  await create(page)
  await expect(page.locator('.design-starter')).toHaveCount(4)
  await page.getByRole('button', { name: 'Artboard size', exact: true }).click()
  await number(page, 'Width', 400)
  await number(page, 'Height', 300)
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await number(page, 'X', 220)
  await number(page, 'Y', 20)
  await number(page, 'Width', 140)
  await number(page, 'Height', 90)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .fill('Native poster')
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .press('Control+Enter')
  await number(page, 'Font size', 32)
  await number(page, 'X', 30)
  await number(page, 'Y', 170)
  await number(page, 'Width', 340)
  await number(page, 'Height', 90)
  await page.getByLabel('Import image', { exact: true }).setInputFiles({
    name: 'Two colors.png',
    mimeType: 'image/png',
    buffer: await fixtureImage(page),
  })
  await expect(page.locator('.design-artwork image')).toHaveCount(1)
  await number(page, 'Crop Width', 50)
  await number(page, 'Crop X', 50)
  await number(page, 'X', 40)
  await number(page, 'Y', 40)
  await number(page, 'Width', 120)
  await number(page, 'Height', 80)
  await saved(page)
  const doc = await read(page)
  expect(
    Object.values(doc.nodes)
      .map((n) => n.type)
      .sort(),
  ).toEqual(['image', 'rectangle', 'text'])
  expect(Object.values(doc.assets)[0].path).toMatch(/^Attachments\/Design\//)
  expect(JSON.stringify(doc)).not.toMatch(/blob:|data:image|localhost|http:/)
  await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  const photo = page.locator(
    `[data-design-node="${Object.values(doc.nodes).find((n) => n.type === 'image')!.id}"]`,
  )
  await photo.click()
  await page.getByTestId('design-canvas').press('ArrowRight')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  await page.getByLabel('Export', { exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PNG', exact: true }).click()
  const download = await downloadPromise,
    bytes = await fs.readFile((await download.path())!)
  const pixels = await page.evaluate(async (base64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${base64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    return {
      width: img.width,
      height: img.height,
      background: Array.from(ctx.getImageData(5, 5, 1, 1).data),
      image: Array.from(ctx.getImageData(80, 80, 1, 1).data),
      shape: Array.from(ctx.getImageData(250, 60, 1, 1).data),
      text: ctx
        .getImageData(30, 170, 340, 90)
        .data.some((v, i) => i % 4 !== 3 && v < 60),
    }
  }, bytes.toString('base64'))
  expect(pixels).toEqual({
    width: 400,
    height: 300,
    background: [255, 255, 255, 255],
    image: [0, 0, 255, 255],
    shape: [86, 69, 212, 255],
    text: true,
  })
  await page.reload()
  await page.locator('.document-tab[data-tab-title="Untitled design"]').click()
  await expect(page.getByTestId('design-editor')).toBeVisible()
  expect((await read(page)).nodes).toEqual(doc.nodes)
  const textId = Object.values(doc.nodes).find((n) => n.type === 'text')!.id
  await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  await page.locator(`[data-design-node="${textId}"]`).dblclick()
  await expect(
    page.getByRole('textbox', { name: 'Edit text', exact: true }),
  ).toHaveValue('Native poster')
})
test('shows editable starter previews and keeps controls reachable at 1024px in both themes', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await create(page)
  await page.evaluate(async () => {
    const { loadDesktopSettings, saveDesktopSettings } = await import(
      /* @vite-ignore */ ['/src/services', 'desktopSettings.ts'].join('/')
    )
    const settings = await loadDesktopSettings()
    await saveDesktopSettings({
      ...settings,
      general: { ...settings.general, theme: 'light' },
    })
  })
  await expect
    .poll(() =>
      page
        .locator('.design-tool-rail button')
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    )
    .toBe('rgb(26, 26, 26)')
  await page.screenshot({ path: testInfo.outputPath('design-library.png') })
  await page.getByRole('button', { name: 'Editorial', exact: true }).click()
  await saved(page)
  await expect(page.locator('.design-artwork text')).not.toHaveCount(0)
  await page.screenshot({
    path: testInfo.outputPath('design-poster-light.png'),
  })
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.getByRole('button', { name: 'Adjustments', exact: true }).click()
  await expect(
    page.getByRole('spinbutton', { name: 'Width', exact: true }),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1024,
  )
  await page.evaluate(async () => {
    const { loadDesktopSettings, saveDesktopSettings } = await import(
      /* @vite-ignore */ ['/src/services', 'desktopSettings.ts'].join('/')
    )
    const settings = await loadDesktopSettings()
    await saveDesktopSettings({
      ...settings,
      general: { ...settings.general, theme: 'dark' },
    })
  })
  await page.screenshot({
    path: testInfo.outputPath('design-poster-dark-1024.png'),
  })
  await expect(page.getByLabel('Export', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  await page.getByRole('button', { name: 'Open AI Chat', exact: true }).click()
  await expect(
    page.getByPlaceholder('Plan, write, or ask anything…'),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Adjustments', exact: true }).click()
  await expect(
    page.getByRole('spinbutton', { name: 'Width', exact: true }),
  ).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    1024,
  )
  await page.screenshot({
    path: testInfo.outputPath('design-with-chat-1024.png'),
  })
})
test('preserves an externally changed source and keeps the editing version available', async ({
  page,
}) => {
  await create(page)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .fill('Keep these edits')
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .press('Control+Enter')
  await saved(page)
  await page.evaluate((storageKey) => {
    const records = JSON.parse(localStorage.getItem(storageKey)!)
    const doc = JSON.parse(records['Untitled design.kidesign'].content)
    doc.title = 'External edit'
    records['Untitled design.kidesign'].content = JSON.stringify(doc)
    localStorage.setItem(storageKey, JSON.stringify(records))
  }, key)
  await number(page, 'Font size', 36)
  await expect(page.getByTestId('design-save-status')).toHaveText(
    'File changed',
  )
  expect((await read(page)).title).toBe('External edit')
  await expect(page.locator('.design-artwork text')).toContainText([
    'Keep these edits',
  ])
  await page.getByRole('button', { name: 'Save a copy', exact: true }).click()
  await expect(page.locator('.design-title strong').last()).toHaveText(
    'Untitled design copy',
  )
})

test('preserves composed text and exports transparent PNG and opaque JPEG', async ({
  page,
}) => {
  await create(page)
  await page.getByRole('button', { name: 'Artboard size', exact: true }).click()
  await number(page, 'Width', 320)
  await number(page, 'Height', 240)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  const field = page.getByRole('textbox', { name: 'Edit text', exact: true })
  const cdp = await page.context().newCDPSession(page)
  const text = designChinese.newText
  await cdp.send('Input.imeSetComposition', {
    text,
    selectionStart: text.length,
    selectionEnd: text.length,
  })
  await expect(field).toBeVisible()
  await cdp.send('Input.insertText', { text })
  await field.press('Control+Enter')
  await saved(page)
  expect(
    Object.values((await read(page)).nodes).find((n) => n.type === 'text')
      ?.text,
  ).toBe(text)
  await page.getByRole('button', { name: 'Artboard size', exact: true }).click()
  await page
    .getByRole('checkbox', { name: 'Transparent background', exact: true })
    .check()
  await page.getByLabel('Export', { exact: true }).click()
  const pngDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PNG', exact: true }).click()
  const png = await fs.readFile((await (await pngDownload).path())!)
  const pixel = async (bytes: Buffer, mime: string) =>
    page.evaluate(
      async ({ base64, mime }) => {
        const img = new Image()
        img.src = `data:${mime};base64,${base64}`
        await img.decode()
        const canvas = document.createElement('canvas')
        canvas.width = img.width
        canvas.height = img.height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        return {
          width: img.width,
          height: img.height,
          corner: Array.from(ctx.getImageData(0, 0, 1, 1).data),
        }
      },
      { base64: bytes.toString('base64'), mime },
    )
  expect(await pixel(png, 'image/png')).toEqual({
    width: 320,
    height: 240,
    corner: [0, 0, 0, 0],
  })
  await page.getByLabel('Export', { exact: true }).click()
  await page.getByRole('button', { name: 'Download JPEG', exact: true }).click()
  await expect(
    page.getByText('Choose an opaque artboard background for JPEG', {
      exact: true,
    }),
  ).toBeVisible()
  await page
    .getByRole('checkbox', { name: 'Transparent background', exact: true })
    .uncheck()
  await page.getByLabel('Export', { exact: true }).click()
  const jpegDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download JPEG', exact: true }).click()
  const jpeg = await fs.readFile((await (await jpegDownload).path())!)
  expect([...jpeg.subarray(0, 2)]).toEqual([255, 216])
  expect(await pixel(jpeg, 'image/jpeg')).toEqual({
    width: 320,
    height: 240,
    corner: [255, 255, 255, 255],
  })
  await saved(page)
  await page.reload()
  await page.locator('.document-tab[data-tab-title="Untitled design"]').click()
  await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  const doc = await read(page),
    id = Object.values(doc.nodes).find((n) => n.type === 'text')!.id
  await page.locator(`[data-design-node="${id}"] text`).dblclick()
  await expect(field).toHaveValue(text)
  await cdp.detach()
})

test('keeps group, layer, object clipboard, and canceled drag operations undoable', async ({
  page,
}) => {
  await create(page)
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await number(page, 'X', 100)
  await number(page, 'Y', 100)
  await page.getByRole('button', { name: 'Ellipse', exact: true }).click()
  await number(page, 'X', 500)
  await number(page, 'Y', 500)
  await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  const canvas = page.getByTestId('design-canvas')
  await canvas.press('Control+a')
  await canvas.press('Control+g')
  await saved(page)
  const grouped = await read(page),
    groupId = grouped.pages[0].children[0]
  expect(grouped.nodes[groupId].children).toHaveLength(2)
  await page.getByRole('button', { name: 'Layers', exact: true }).click()
  await page.getByRole('button', { name: 'Group', exact: true }).click()
  await page.getByRole('button', { name: 'Lock Group', exact: true }).click()
  await canvas.press('Delete')
  await saved(page)
  expect((await read(page)).nodes[groupId].locked).toBe(true)
  await page.getByRole('button', { name: 'Unlock Group', exact: true }).click()
  await page.getByRole('button', { name: 'Adjustments', exact: true }).click()
  await number(page, 'Rotation', 30)
  await saved(page)
  const rotated = await read(page)
  expect(rotated.nodes[groupId].transform[1]).toBeCloseTo(0.5, 3)
  await page.getByRole('button', { name: 'Close panel', exact: true }).click()
  await canvas.evaluate((el) => {
    const data = new DataTransfer()
    el.dispatchEvent(
      new ClipboardEvent('copy', { bubbles: true, clipboardData: data }),
    )
    el.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, clipboardData: data }),
    )
  })
  await saved(page)
  const pasted = await read(page)
  expect(pasted.pages[0].children).toHaveLength(2)
  expect(Object.keys(pasted.nodes)).toHaveLength(6)
  expect(pasted.pages[0].children[1]).not.toBe(groupId)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect((await read(page)).nodes).toEqual(rotated.nodes)
  const bounds = await page
    .locator(`[data-design-node="${rotated.nodes[groupId].children[0]}"]`)
    .boundingBox()
  await page.mouse.move(
    bounds!.x + bounds!.width / 2,
    bounds!.y + bounds!.height / 2,
  )
  await page.mouse.down()
  await page.mouse.move(
    bounds!.x + bounds!.width / 2 + 35,
    bounds!.y + bounds!.height / 2 + 20,
    { steps: 4 },
  )
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await saved(page)
  expect((await read(page)).nodes).toEqual(rotated.nodes)
})
