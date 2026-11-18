import { expect, test, type FrameLocator, type Page } from '@playwright/test'

import { openInKitFrame } from './helpers/embeddedKit'
import { canReadBlobBodies } from './helpers/requestBody'
import { configureModel, mockGenerate, onboardingTable, promptText, recordCount, savedTables, serveKitTables } from './helpers/tableAi'

/** A 1×1 PNG: the image a mocked image model answers. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
/** Another 1×1 PNG, for a rerun that must replace the first pictures. */
const OTHER_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

const stage = (kit: FrameLocator) => kit.locator('.data-inline-grid-canvas [data-ktable-grid-stage="true"]')
/** The grid's first row's buttons sit this far below the stage's top: under the 32 px header, 4 px into the cell, at their middle. */
const FIRST_ROW_BUTTONS = 32 + 4 + 9
/** The AI regenerate button's side (the 0.5.0 grid draws it 18 px wide); the row's own control at its start is wider. */
const AI_BUTTON = 18

/**
 * The grid's per-cell Regenerate buttons on its first row, left to right, as the points a person
 * clicks. The engine draws the grid on a canvas, and a hovered AI cell shows its regenerate button
 * at its top right, where the pointer becomes a hand: moving along the first row finds each one.
 */
async function firstRowButtons(page: Page, kit: FrameLocator) {
  const scan = async () => {
    const box = (await stage(kit).boundingBox())!
    const y = box.y + FIRST_ROW_BUTTONS
    const spans: Array<{ from: number; to: number }> = []
    for (let x = box.x; x < box.x + box.width; x += 3) {
      await page.mouse.move(x, y)
      const hand = await stage(kit).evaluate((element) => [element, ...element.querySelectorAll<HTMLElement>('*')].some((node) => (node as HTMLElement).style.cursor === 'pointer'))
      if (!hand) continue
      const last = spans.at(-1)
      if (last && x - last.to <= 3) last.to = x
      else spans.push({ from: x, to: x })
    }
    return spans.filter(({ from, to }) => to - from <= AI_BUTTON).map(({ from, to }) => ({ x: (from + to) / 2, y }))
  }
  let buttons: Awaited<ReturnType<typeof scan>> = []
  await expect.poll(async () => (buttons = await scan()).length, { timeout: 30_000 }).toBeGreaterThan(0)
  return buttons.map((point) => ({ click: () => page.mouse.click(point.x, point.y), x: point.x }))
}

/** Scrolls the grid to its last (`dx` > 0) or first columns and waits until its buttons stop moving. */
async function scrollGrid(page: Page, kit: FrameLocator, dx: number) {
  const box = (await stage(kit).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(dx, 0)
  let last = ''
  await expect.poll(async () => {
    const now = JSON.stringify((await firstRowButtons(page, kit)).map((button) => button.x))
    const settled = now === last
    last = now
    return settled
  }, { intervals: [200, 200, 200, 400], timeout: 30_000 }).toBe(true)
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
    const [designs] = await firstRowButtons(page, kit)
    await designs.click()
    await expect.poll(() => requests.length, { timeout: 30_000 }).toBeGreaterThan(0)
    await expect.poll(() => requests.filter((request) => request.output === 'image').length, { timeout: 60_000 }).toBe(3)
    expect(requests.every((request) => request.purpose === 'ai-field' && request.output === 'image')).toBe(true)
    expect(promptText(requests[0])).toContain(String(concept.values.concept_description))
    const imageRequests = requests.length

    // LinkedIn copy is the second-to-last AI column: one text request that names the concept.
    await scrollToLastColumns(page, kit)
    const lastButtons = await firstRowButtons(page, kit)
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
    await (await firstRowButtons(page, kit)).at(-2)!.click()
    await expect(kit.getByText(/No credits left/)).toBeVisible({ timeout: 30_000 })
    expect(requests).toHaveLength(beforeRefusal + 1)

    // A rerun of Designs replaces its pictures rather than adding to them.
    await scrollGrid(page, kit, -4000)
    const [designsAgain] = await firstRowButtons(page, kit)
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
