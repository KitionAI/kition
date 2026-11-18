import { expect, test, type FrameLocator, type Page } from '@playwright/test'

import { openInKitFrame } from './helpers/embeddedKit'
import { canReadBlobBodies } from './helpers/requestBody'
import { configureModel, mockGenerate, onboardingTable, promptText, recordCount, savedTables, serveKitTables } from './helpers/tableAi'

/** A 1×1 PNG: the image a mocked image model answers. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** Another 1×1 PNG, for a rerun that must replace the first pictures. */
const OTHER_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

/** The grid's per-cell Regenerate buttons on its first row, left to right. */
async function firstRowButtons(kit: FrameLocator) {
  const buttons = kit.getByRole('button', { name: 'Regenerate', exact: true })
  await expect(buttons.first()).toBeVisible({ timeout: 30_000 })
  const boxes = await Promise.all((await buttons.all()).map(async (button) => ({ button, box: (await button.boundingBox())! })))
  const top = Math.min(...boxes.map(({ box }) => box.y))
  return boxes.filter(({ box }) => Math.abs(box.y - top) < 4).sort((a, b) => a.box.x - b.box.x).map(({ button }) => button)
}

/** Scrolls the grid to its last (`dx` > 0) or first columns and waits until it stops moving. */
async function scrollGrid(page: Page, kit: FrameLocator, dx: number) {
  const stage = kit.locator('.data-inline-grid-canvas [data-t-grid-stage="true"]')
  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(dx, 0)
  const first = kit.getByRole('button', { name: 'Regenerate', exact: true }).first()
  let last = ''
  await expect.poll(async () => {
    const now = JSON.stringify(await first.boundingBox())
    const settled = now === last
    last = now
    return settled
  }, { intervals: [200, 200, 200, 400] }).toBe(true)
}
const scrollToLastColumns = (page: Page, kit: FrameLocator) => scrollGrid(page, kit, 4000)

/**
 * AI-SCENE-006 (docs/kition-onboarding-core-scenarios.csv): in the onboarding Product Content
 * Studio, the person runs one text cell (LinkedIn copy) and one image cell (Designs) of the first
 * concept. Only those cells run; the text asks for text and names the concept, the image asks for
 * images; the image cell keeps the configured number of pictures, and a rerun replaces them
 * rather than adding more; a refused run leaves what was generated.
 */
test('AI-SCENE-006: Product Content Studio runs only the asked cells, keeps the configured pictures, and survives a refusal', async ({ page, baseURL, browserName }) => {
  test.setTimeout(240_000)
  const bytes = await onboardingTable('product-content/Product Content Studio.ktable')
  const before = (await savedTables(bytes))['Tumbler Design']
  const [concept] = before
  await configureModel(page, ['gpt-image-2'])

  let requests: Array<Record<string, any>> = []
  let refuseText = false
  const routes = async (page: Page) => {
    await serveKitTables(page)
    let images = 0
    requests = await mockGenerate(page, (request) => {
      const index = request.output === 'image' ? images++ : -1
      if (request.output === 'image') return { image: { mime: 'image/png', data: index < 3 ? PIXEL : OTHER_PIXEL } }
      if (refuseText) return { refuse: 'quota', message: 'No credits left.' }
      return { text: 'A calm gradient tumbler for long days. #design #hydration #launch' }
    })
  }
  const { host, saves, kit } = await openInKitFrame(page, baseURL!, 'Product Content Studio.ktable', bytes, {}, { routes })
  try {
    await expect(recordCount(kit)).toContainText(`${before.length} records`, { timeout: 60_000 })
    expect(requests).toHaveLength(0)

    // Designs is the first AI column: its first-row button asks for images of this concept.
    const [designs] = await firstRowButtons(kit)
    await designs.click()
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBeGreaterThan(0)
    await expect.poll(() => requests.filter((request) => request.output === 'image').length, { timeout: 60_000 }).toBe(3)
    expect(requests.every((request) => request.purpose === 'ai-field' && request.output === 'image')).toBe(true)
    expect(promptText(requests[0])).toContain(String(concept.values.concept_description))
    const imageRequests = requests.length

    // LinkedIn copy is the second-to-last AI column: one text request that names the concept.
    await scrollToLastColumns(page, kit)
    const lastButtons = await firstRowButtons(kit)
    await lastButtons.at(-2)!.click()
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBe(imageRequests + 1)
    const copy = requests.at(-1)!
    expect(copy).toMatchObject({ purpose: 'ai-field', output: 'text' })
    expect(promptText(copy)).toContain('LinkedIn product launch post')
    expect(promptText(copy)).toContain(String(concept.values.concept))
    expect(promptText(copy)).toContain(String(concept.values.concept_description))

    await kit.getByTestId('table-save').click()
    await expect(kit.getByTestId('table-unsaved')).toHaveCount(0, { timeout: 30_000 })
    if (canReadBlobBodies(browserName)) {
      const saved = (await savedTables(saves.at(-1)!.bytes))['Tumbler Design']
      const row = saved.find((record) => record.id === concept.id)!
      expect(row.values.linkedin_copy).toBe('A calm gradient tumbler for long days. #design #hydration #launch')
      expect(row.values.designs as unknown[]).toHaveLength(3)
      for (const field of ['orthographic_views', 'feature_image', 'lifestyle_shot', 'style_board', 'twitter_copy']) {
        expect(row.values[field] ?? null).toEqual(concept.values[field] ?? null)
      }
      expect(row.values.concept).toBe(concept.values.concept)
      expect(row.values.concept_description).toBe(concept.values.concept_description)
      for (const other of saved.filter((record) => record.id !== concept.id)) {
        expect(other.values).toEqual(before.find((record) => record.id === other.id)!.values)
      }
    }

    // A refused copy says why and keeps the copy the cell had.
    refuseText = true
    const beforeRefusal = requests.length
    await scrollToLastColumns(page, kit)
    await (await firstRowButtons(kit)).at(-2)!.click()
    await expect(kit.getByText(/No credits left/)).toBeVisible({ timeout: 30_000 })
    expect(requests).toHaveLength(beforeRefusal + 1)

    // A rerun of Designs replaces its pictures rather than adding to them.
    await scrollGrid(page, kit, -4000)
    const [designsAgain] = await firstRowButtons(kit)
    const beforeRerun = requests.length
    await designsAgain.click()
    await expect.poll(() => requests.filter((request) => request.output === 'image').length, { timeout: 60_000 }).toBe(6)
    expect(promptText(requests[beforeRerun])).toContain('Studio lighting on white background')

    await kit.getByTestId('table-save').click()
    await expect(kit.getByTestId('table-unsaved')).toHaveCount(0, { timeout: 30_000 })
    if (canReadBlobBodies(browserName)) {
      const row = (await savedTables(saves.at(-1)!.bytes))['Tumbler Design'].find((record) => record.id === concept.id)!
      expect(row.values.linkedin_copy).toBe('A calm gradient tumbler for long days. #design #hydration #launch')
      expect(row.values.designs as unknown[]).toHaveLength(3)
    }
  } finally {
    await host.dispose()
  }
})
