import { expect, test, type Page } from '@playwright/test'
import type { DesignDocument } from '../src/features/design/lib/designTypes'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'
import { DESIGN_STORAGE_KEY, designLayers } from './helpers/design'

async function readDesignNamed(page: Page, name: string): Promise<DesignDocument> {
  return page.evaluate(
    ({ key, file }) => {
      const records = JSON.parse(localStorage.getItem(key) || '{}')
      return JSON.parse(records[file].content)
    },
    { key: DESIGN_STORAGE_KEY, file: name },
  )
}

test('starts designs from a table record and from a Board frame', async ({
  page,
}) => {
  await mockLocalWorkspaceApi(page)
  await page.goto('/documents')
  await dismissFirstRunActivation(page)

  // The record menu dispatches this request; the workspace fills the default template.
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('kition:design:from-record', {
        detail: {
          title: 'Design 7',
          fields: { Title: 'Autumn drop', Description: 'Warm layers for cold days', Status: { name: 'Live' } },
        },
      }),
    )
  })
  await expect(page.getByTestId('design-editor')).toBeVisible()
  await expect(page.locator('.design-title strong').last()).toHaveText('Design 7')
  await expect
    .poll(async () => designLayers(await readDesignNamed(page, 'Design 7.kidesign')).length)
    .toBe(5)
  const record = await readDesignNamed(page, 'Design 7.kidesign')
  const texts = designLayers(record).filter((layer) => layer.type === 'text')
  expect(texts.map((layer) => layer.text)).toEqual(['Live', 'Autumn drop', 'Warm layers for cold days'])
  expect(record.provenance).toEqual({ templateId: 'design-template-editorial', templateVersion: 1 })

  // The Board selection menu dispatches a frame snapshot.
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent('kition:design:from-board-frame', {
        detail: {
          title: 'Launch frame',
          width: 800,
          height: 600,
          background: '#f4f1ff',
          items: [
            { kind: 'rectangle', x: 40, y: 60, width: 200, height: 100, fill: '#5645d4', text: 'Plan' },
            { kind: 'text', x: 50, y: 200, width: 300, height: 40, text: 'Notes', fontSize: 20 },
          ],
        },
      }),
    )
  })
  await expect(page.locator('.design-title strong').last()).toHaveText('Launch frame')
  await expect
    .poll(async () => designLayers(await readDesignNamed(page, 'Launch frame.kidesign')).length)
    .toBe(3)
  const frame = await readDesignNamed(page, 'Launch frame.kidesign')
  expect(frame.pages[0]).toMatchObject({ width: 800, height: 600, background: '#f4f1ff' })
  expect(designLayers(frame).map((layer) => layer.type)).toEqual(['rectangle', 'text', 'text'])
  expect(designLayers(frame)[0]).toMatchObject({ fill: '#5645d4', transform: [1, 0, 0, 1, 40, 60] })
})
