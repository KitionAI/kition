import { expect, test, type Page } from '@playwright/test'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import {
  createDesign,
  DESIGN_STORAGE_KEY,
  designLayers,
  expectDesignSaved,
  readDesign,
} from './helpers/design'

const brandKit = {
  version: 1,
  name: 'Kition Test',
  colors: { primary: '#0a7d5c', surface: '#fff4e5' },
  fontFamily: 'Lora',
}

/** Seeds the workspace brand kit file without disturbing other documents. */
async function seedBrandKit(page: Page) {
  await page.addInitScript(
    ({ key, content }) => {
      const records = JSON.parse(window.localStorage.getItem(key) || '{}')
      if (!records['.kition/brand.json']) {
        records['.kition/brand.json'] = { content, updated_at: '2026-09-29T00:00:00.000Z' }
        window.localStorage.setItem(key, JSON.stringify(records))
      }
    },
    { key: DESIGN_STORAGE_KEY, content: JSON.stringify(brandKit) },
  )
}

async function readBrandKit(page: Page) {
  return page.evaluate((key) => {
    const records = JSON.parse(localStorage.getItem(key) || '{}')
    return JSON.parse(records['.kition/brand.json'].content)
  }, DESIGN_STORAGE_KEY)
}

test('applies brand colors to the selection or artboard and binds templates', async ({
  page,
}) => {
  await seedBrandKit(page)
  await createDesign(page)
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click()
  const menu = page.locator('summary[aria-label="Brand"]')
  await expect(menu).toContainText('Kition Test')
  await menu.click()
  await page.getByRole('button', { name: 'Primary', exact: true }).click()
  await expectDesignSaved(page)
  expect(designLayers(await readDesign(page))[0].fill).toBe('#0a7d5c')

  await page.getByTestId('design-canvas').press('Escape')
  await menu.click()
  await page.getByRole('button', { name: 'Surface', exact: true }).click()
  await expectDesignSaved(page)
  expect((await readDesign(page)).pages[0].background).toBe('#fff4e5')

  await page.getByRole('button', { name: 'Layouts', exact: true }).click()
  await page.getByRole('button', { name: 'Event', exact: true }).click()
  await page.getByRole('button', { name: 'Apply layout', exact: true }).click()
  await expectDesignSaved(page)
  const doc = await readDesign(page)
  const [orb, label] = designLayers(doc)
  expect(orb).toMatchObject({ type: 'ellipse', fill: '#0a7d5c' })
  expect(label).toMatchObject({ type: 'text', fontFamily: 'Lora' })
  expect(doc.pages[0].background).toBe('#fff4e5')
})

test('edits the brand kit from settings', async ({ page }) => {
  await seedBrandKit(page)
  await mockLocalWorkspaceApi(page)
  await page.goto('/settings?section=brand')
  await expect(page.getByRole('button', { name: 'Brand', exact: true })).toBeVisible()
  await expect(page.getByLabel('Brand name', { exact: true })).toHaveValue('Kition Test')
  await page.getByLabel('Accent', { exact: true }).fill('#123456')
  await page.getByLabel('Brand name', { exact: true }).fill('Kition Updated')
  await page.getByRole('button', { name: 'Save brand kit', exact: true }).click()
  await expect(page.getByTestId('settings-action-bar-saved')).toBeVisible()
  expect(await readBrandKit(page)).toMatchObject({
    name: 'Kition Updated',
    colors: { primary: '#0a7d5c', accent: '#123456', surface: '#fff4e5' },
    fontFamily: 'Lora',
  })
})
