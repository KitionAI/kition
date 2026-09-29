import { expect, test } from '@playwright/test'
import {
  createDesign,
  designLayers,
  expectDesignSaved,
  readDesign,
} from './helpers/design'

test('choosing a template produces its layers with the localized copy', async ({
  page,
}) => {
  await createDesign(page)
  await expect(page.locator('.design-starter')).toHaveCount(4)
  await page.getByRole('button', { name: 'Event', exact: true }).click()
  await expectDesignSaved(page)
  const doc = await readDesign(page)
  const layers = designLayers(doc)
  expect(layers.map((layer) => layer.type)).toEqual([
    'ellipse',
    'text',
    'text',
    'text',
  ])
  expect(layers.map((layer) => layer.text)).toEqual([
    '',
    'CREATIVE MEETUP',
    'MAKE SOMETHING MATTER',
    'An evening of ideas, art & conversation.',
  ])
  expect(layers[0]).toMatchObject({
    fill: '#5645d4',
    constraints: { horizontal: 'right', vertical: 'top' },
  })
  expect(doc.pages[0].background).toBe('#e6e0f5')
  expect(doc.provenance).toEqual({
    templateId: 'design-template-event',
    templateVersion: 1,
  })
})
