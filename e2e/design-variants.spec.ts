import fs from 'node:fs/promises'
import { expect, test, type Download } from '@playwright/test'
import {
  createDesign,
  designLayers,
  expectDesignSaved,
  fillDesignNumber,
  readDesign,
} from './helpers/design'

test('creates a story variant that keeps the headline centered and exports every size', async ({
  page,
}) => {
  await createDesign(page)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .press('Control+Enter')
  await fillDesignNumber(page, 'Width', 600)
  await fillDesignNumber(page, 'Height', 100)
  await page.getByRole('button', { name: 'Center horizontally', exact: true }).click()
  await page.getByRole('button', { name: 'Center vertically', exact: true }).click()
  await page.getByRole('combobox', { name: 'Pin horizontally', exact: true }).selectOption('center')
  await page.getByRole('combobox', { name: 'Pin vertically', exact: true }).selectOption('center')
  await expectDesignSaved(page)
  const [headline] = designLayers(await readDesign(page))

  await page.getByRole('button', { name: 'Artboard size', exact: true }).click()
  await page.getByRole('combobox', { name: 'Add size variant', exact: true }).selectOption('story')
  await expect(page.locator('.design-size-button')).toContainText('1080 × 1920')
  await expectDesignSaved(page)
  const doc = await readDesign(page)
  expect(doc.pages[0]).toMatchObject({ width: 1080, height: 1440 })
  const variants = Object.values(doc.variants ?? {})
  expect(variants).toHaveLength(1)
  expect(variants[0]).toMatchObject({ name: 'Story', width: 1080, height: 1920 })
  // The centered headline keeps its center in the taller artboard.
  expect(variants[0].overrides[headline.id]?.transform?.[5]).toBe(960 - 50)
  expect(designLayers(doc)[0].transform).toEqual(headline.transform)

  await page.getByLabel('Export', { exact: true }).click()
  const downloads: Download[] = []
  page.on('download', (download) => downloads.push(download))
  await page
    .getByRole('button', { name: 'Download all sizes (PNG)', exact: true })
    .click()
  await expect.poll(() => downloads.length).toBe(2)
  expect(
    downloads.map((download) => download.suggestedFilename()).sort(),
  ).toEqual(['Untitled design - Story.png', 'Untitled design.png'])
  for (const download of downloads) {
    const bytes = await fs.readFile((await download.path())!)
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')
  }

  await page.getByRole('combobox', { name: 'Artboard variant', exact: true }).selectOption('')
  await expect(page.locator('.design-size-button')).toContainText('1080 × 1440')
})
