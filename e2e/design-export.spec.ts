import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { createDesign, expectDesignSaved } from './helpers/design'

test('exports at the remembered scale and background and downloads standalone SVG', async ({
  page,
}) => {
  await createDesign(page)
  await page.getByRole('button', { name: 'Artboard size', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Width', exact: true }).fill('200')
  await page.getByRole('spinbutton', { name: 'Width', exact: true }).press('Enter')
  await page.getByRole('spinbutton', { name: 'Height', exact: true }).fill('100')
  await page.getByRole('spinbutton', { name: 'Height', exact: true }).press('Enter')
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).press('Control+Enter')
  await page.getByRole('combobox', { name: 'Font', exact: true }).selectOption('Inter')
  await expectDesignSaved(page)

  await page.getByLabel('Export', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Scale', exact: true }).selectOption('2')
  await page.getByRole('combobox', { name: 'Background', exact: true }).selectOption('transparent')
  const png = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PNG', exact: true }).click()
  const pngBytes = await fs.readFile((await (await png).path())!)
  const pixels = await page.evaluate(async (base64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${base64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    return { width: img.width, height: img.height, corner: Array.from(ctx.getImageData(2, 2, 1, 1).data) }
  }, pngBytes.toString('base64'))
  expect(pixels).toEqual({ width: 400, height: 200, corner: [0, 0, 0, 0] })

  await page.getByLabel('Export', { exact: true }).click()
  const svg = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download SVG', exact: true }).click()
  const download = await svg
  expect(download.suggestedFilename()).toBe('Untitled design.svg')
  const markup = await fs.readFile((await download.path())!, 'utf8')
  expect(markup.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  expect(markup).toContain('viewBox="0 0 200 100"')
  expect(markup).toContain('font-family:"Inter"')
  expect(markup).toContain('data:font/woff2;base64,')

  // The presets survive a reload.
  await page.reload()
  await page.locator('.document-tab[data-tab-title="Untitled design"]').click()
  await page.getByLabel('Export', { exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Scale', exact: true })).toHaveValue('2')
  await expect(page.getByRole('combobox', { name: 'Background', exact: true })).toHaveValue('transparent')
})
