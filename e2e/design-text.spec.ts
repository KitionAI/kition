import fs from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import {
  createDesign,
  designLayers,
  expectDesignSaved,
  fillDesignNumber,
  readDesign,
} from './helpers/design'

test('shares a bundled font through a text style and exports with it', async ({
  page,
}) => {
  await createDesign(page)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .press('Control+Enter')
  await page
    .getByRole('combobox', { name: 'Font', exact: true })
    .selectOption('Inter')
  await page
    .getByRole('button', { name: 'Save as text style', exact: true })
    .click()
  await expect(
    page.getByRole('combobox', { name: 'Text style', exact: true }),
  ).toHaveValue(/./)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .press('Control+Enter')
  await page
    .getByRole('combobox', { name: 'Text style', exact: true })
    .selectOption({ label: 'Style 1' })
  await expectDesignSaved(page)
  let [first, second] = designLayers(await readDesign(page))
  expect(first.styleId).toBeTruthy()
  expect(second.styleId).toBe(first.styleId)
  expect([first.fontFamily, second.fontFamily]).toEqual(['Inter', 'Inter'])
  // A local edit detaches the layer from the style.
  await fillDesignNumber(page, 'Font size', 48)
  await expectDesignSaved(page)
  ;[first, second] = designLayers(await readDesign(page))
  expect(second.styleId).toBeUndefined()
  expect(second.fontSize).toBe(48)
  expect(first.styleId).toBeTruthy()
  await expect(
    page.getByRole('combobox', { name: 'Text style', exact: true }),
  ).toHaveValue('')
  await page.getByLabel('Export', { exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download PNG', exact: true }).click()
  const bytes = await fs.readFile((await (await downloadPromise).path())!)
  expect(bytes.subarray(1, 4).toString()).toBe('PNG')
})
