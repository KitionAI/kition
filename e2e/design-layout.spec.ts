import { expect, test, type Page } from '@playwright/test'
import {
  createDesign as create,
  designLayers as layers,
  expectDesignSaved as saved,
  fillDesignNumber as number,
  readDesign as read,
} from './helpers/design'
async function rectangle(page: Page, x: number, y: number, size: number) {
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await number(page, 'X', x)
  await number(page, 'Y', y)
  await number(page, 'Width', size)
  await number(page, 'Height', size)
}

test('aligns and distributes a multi-selection from the inspector', async ({
  page,
}) => {
  await create(page)
  await rectangle(page, 100, 100, 100)
  await rectangle(page, 400, 300, 100)
  await rectangle(page, 700, 900, 100)
  await page.getByTestId('design-canvas').press('Control+a')
  await page.getByRole('button', { name: 'Align left', exact: true }).click()
  await page
    .getByRole('button', { name: 'Distribute vertically', exact: true })
    .click()
  await saved(page)
  const doc = await read(page)
  const [a, b, c] = layers(doc)
  expect([a.transform[4], b.transform[4], c.transform[4]]).toEqual([
    100, 100, 100,
  ])
  expect(b.transform[5] - a.transform[5]).toBeCloseTo(
    c.transform[5] - b.transform[5],
  )
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await saved(page)
  expect(layers(await read(page)).map((node) => node.transform[5])).toEqual([
    100, 300, 900,
  ])
})

test('a centered headline stays centered when the artboard becomes a story', async ({
  page,
}) => {
  await create(page)
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page
    .getByRole('textbox', { name: 'Edit text', exact: true })
    .press('Control+Enter')
  await number(page, 'Width', 600)
  await page
    .getByRole('button', { name: 'Center horizontally', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Center vertically', exact: true })
    .click()
  await page
    .getByRole('combobox', { name: 'Pin horizontally', exact: true })
    .selectOption('center')
  await page
    .getByRole('combobox', { name: 'Pin vertically', exact: true })
    .selectOption('center')
  await page.getByRole('button', { name: 'Artboard size', exact: true }).click()
  await page
    .getByRole('combobox', { name: 'Size', exact: true })
    .selectOption('1080x1920')
  await saved(page)
  const doc = await read(page)
  const [heading] = layers(doc)
  expect(doc.pages[0]).toMatchObject({ width: 1080, height: 1920 })
  expect(heading.transform[4] + heading.width / 2).toBe(540)
  expect(heading.transform[5] + heading.height / 2).toBe(960)
})
