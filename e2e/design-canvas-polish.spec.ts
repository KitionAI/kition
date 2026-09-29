import { expect, test, type Page } from '@playwright/test'
import {
  createDesign,
  designLayers,
  expectDesignSaved,
  fillDesignNumber,
  readDesign,
} from './helpers/design'

async function fixtureImage(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 100
    canvas.height = 60
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ff0000'
    ctx.fillRect(0, 0, 100, 60)
    return canvas.toDataURL().split(',')[1]
  })
  return Buffer.from(data, 'base64')
}

test('rulers, Shift nudge, Alt-drag duplicate, text fit, and image fit and fill', async ({
  page,
}) => {
  await createDesign(page)
  await expect(page.getByTestId('design-ruler-x')).toContainText('0')
  await expect(page.getByTestId('design-ruler-x')).toContainText('400')
  await expect(page.getByTestId('design-ruler-y')).toContainText('1200')

  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  await expectDesignSaved(page)
  const [rect] = designLayers(await readDesign(page))
  await page.getByTestId('design-canvas').press('Shift+ArrowRight')
  await expectDesignSaved(page)
  expect(designLayers(await readDesign(page))[0].transform[4]).toBe(rect.transform[4] + 10)

  const box = (await page.locator(`[data-design-node="${rect.id}"]`).boundingBox())!
  await page.keyboard.down('Alt')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 6 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await expectDesignSaved(page)
  const afterDuplicate = designLayers(await readDesign(page))
  expect(afterDuplicate).toHaveLength(2)
  expect(afterDuplicate[0].transform[4]).toBe(rect.transform[4] + 10)
  expect(afterDuplicate[1].transform[4]).toBeGreaterThan(afterDuplicate[0].transform[4] + 30)

  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByRole('textbox', { name: 'Edit text', exact: true }).press('Control+Enter')
  await fillDesignNumber(page, 'Height', 40)
  await page.getByRole('button', { name: 'Fit text to box', exact: true }).click()
  await expectDesignSaved(page)
  const text = designLayers(await readDesign(page)).find((layer) => layer.type === 'text')!
  expect(text.fontSize).toBeLessThan(40)
  expect(text.fontSize).toBeGreaterThanOrEqual(4)

  await page.getByLabel('Import image', { exact: true }).setInputFiles({
    name: 'Red.png',
    mimeType: 'image/png',
    buffer: await fixtureImage(page),
  })
  await expect(page.locator('.design-artwork image')).toHaveCount(1)
  await fillDesignNumber(page, 'Width', 200)
  await fillDesignNumber(page, 'Height', 200)
  await page.getByRole('button', { name: 'Fill box', exact: true }).click()
  await expectDesignSaved(page)
  let image = designLayers(await readDesign(page)).find((layer) => layer.type === 'image')!
  expect(image.crop).toEqual({ x: 20, y: 0, width: 60, height: 60 })
  expect([image.width, image.height]).toEqual([200, 200])
  await page.getByRole('button', { name: 'Fit image', exact: true }).click()
  await expectDesignSaved(page)
  image = designLayers(await readDesign(page)).find((layer) => layer.type === 'image')!
  expect(image.crop).toEqual({ x: 0, y: 0, width: 100, height: 60 })
  expect([image.width, image.height]).toEqual([200, 120])
})
