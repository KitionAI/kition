/**
 * Shared conventions of the kit interaction suite (e2e/interaction/). The suite is expensive and
 * runs only through `pnpm test:interaction:e2e`, when a maintainer asks for it; the CI sweep ignores
 * this folder (tooling/playwright.config.ts).
 *
 * Each spec is `<kit>.spec.ts` and tags every test with its kit, its host-matrix row and, for a
 * data-loss or core-editing check, `@p0`, so one kit or one row runs alone:
 * `pnpm test:interaction:e2e --grep @sheet`, `--grep @H5`, `--grep @p0`.
 *
 * Row H16 (the kit follows Kition's dark scheme) is written once here, `darkSchemeRow`, and each
 * helper runs it over the kit's `dark` expectation: what the kit's work area should look like in
 * the dark scheme, decided per kit from what it draws and its design documents.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test'

/** The host-matrix rows every kit goes through (the interaction test plan); H16 is the dark scheme. */
export type HostRow = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8' | 'H9' | 'H10' | 'H11' | 'H12' | 'H13' | 'H14' | 'H15' | 'H16'

/** The tags of a test: its kit, its host-matrix rows, and `@p0` when a failure loses data or blocks editing. */
export function tags(kit: string, rows: HostRow[], p0 = false) {
  return { tag: [`@${kit}`, ...rows.map((row) => `@${row}`), ...(p0 ? ['@p0'] : [])] }
}

/**
 * Collects the page's uncaught errors and console errors, in the page and in kit frames, so a test
 * can end with `await errors.expectNone()`. `ignore` drops known, harmless messages.
 */
export function collectErrors(page: Page, ignore: RegExp[] = []) {
  const messages: string[] = []
  const keep = (text: string) => {
    if (!ignore.some((pattern) => pattern.test(text))) messages.push(text)
  }
  page.on('pageerror', (error) => keep(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') keep(`console: ${message.text()}`)
  })
  return {
    messages,
    expectNone: async () => expect(messages, 'page and kit frame errors').toEqual([]),
  }
}


/**
 * What a kit's work area looks like in the dark scheme (row H16). Kits differ on purpose:
 * - `dark`: the work area itself follows the scheme (a note, a grid, a timeline, a board, a 3D view):
 *   dark in the dark scheme, light in the light one.
 * - `sheet`: the kit draws the document on a surface of its own colour (a page, a slide, an
 *   artboard, a picture, a composition), `sheet`, which keeps that colour; the backdrop around it
 *   follows the scheme.
 * - `document`: the whole work area is the document's own colour (a design file's page colour) and
 *   no scheme repaints it.
 */
export type DarkScheme = {
  surface: 'dark' | 'sheet' | 'document'
  /** The kit's work area in its frame: the element whose pixels are measured. */
  area: (kit: FrameLocator) => Locator
  /** For `sheet`: the colour of the document surface the fixture has, to find it in the work area. */
  sheet?: 'white' | 'black'
}

/** Relative luminance (WCAG) at or below which a colour counts as dark, and at or above which as light. */
const DARK_MAX = 0.1
const LIGHT_MIN = 0.5
/** A pixel brighter than this is a light pixel in a dark area (text, a light slab). */
const LIGHT_PIXEL = 0.4
/** The share of light pixels a dark work area may have (its text, icons), and a dark backdrop (none, but anti-aliasing). */
const DARK_AREA_LIGHT_SHARE = 0.15
const DARK_BACKDROP_LIGHT_SHARE = 0.05
/** How far a `document` area may move between the schemes (the same colour, re-rendered). */
const DOCUMENT_DRIFT = 0.05

/** A rectangle in an element's screenshot, in device pixels. */
type Rect = { x: number; y: number; width: number; height: number }

/** Luminance statistics of a work area's screenshot: the whole, the sheet found in it, and the backdrop around it. */
type AreaStats = {
  width: number
  height: number
  whole: { median: number; lightShare: number }
  sheet: Rect | null
  sheetMedian: number | null
  backdrop: { median: number; lightShare: number; pixels: number } | null
}

/**
 * Measures `png` (a screenshot) in the page: relative luminance of every pixel; with `sheet`, the
 * document surface is the longest run of columns and of rows in which at least a quarter of the
 * pixels have the sheet's colour (a gap of up to four, a grid line, does not end a run), and the
 * backdrop is every pixel outside it (and a 4-pixel margin for its edge and shadow). `known` reuses
 * a sheet found before (the light scheme may give the backdrop the sheet's colour).
 */
async function measureArea(page: Page, png: Buffer, sheet: 'white' | 'black' | undefined, known: Rect | null): Promise<AreaStats> {
  return page.evaluate(
    async ({ base64, sheetColour, knownRect, lightPixel }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const { data, width, height } = context.getImageData(0, 0, bitmap.width, bitmap.height)
      const channel = (value: number) => {
        const c = value / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      const table = Array.from({ length: 256 }, (_, value) => channel(value))
      const luminance = new Float32Array(width * height)
      const isSheet = new Uint8Array(width * height)
      const target = sheetColour === 'black' ? 0 : 255
      for (let index = 0; index < width * height; index += 1) {
        const r = data[index * 4]!
        const g = data[index * 4 + 1]!
        const b = data[index * 4 + 2]!
        luminance[index] = 0.2126 * table[r]! + 0.7152 * table[g]! + 0.0722 * table[b]!
        if (sheetColour && Math.abs(r - target) <= 10 && Math.abs(g - target) <= 10 && Math.abs(b - target) <= 10) isSheet[index] = 1
      }
      const summary = (values: number[]) => {
        if (values.length === 0) return { median: Number.NaN, lightShare: Number.NaN }
        const sorted = [...values].sort((a, b) => a - b)
        return { median: sorted[Math.floor(sorted.length / 2)]!, lightShare: values.filter((value) => value > lightPixel).length / values.length }
      }
      // The longest run of entries with at least a quarter's share, across gaps of a few entries
      // (a grid's lines, a page's text).
      const longestRun = (counts: number[], length: number) => {
        let best: { start: number; end: number } | null = null
        let start = -1
        let lastHit = -1
        counts.forEach((count, index) => {
          if (count < length * 0.25) return
          if (start < 0 || index - lastHit > 4) start = index
          lastHit = index
          if (!best || index - start > best.end - best.start) best = { start, end: index }
        })
        return best as { start: number; end: number } | null
      }
      let rect = knownRect
      if (sheetColour && !rect) {
        const columns = Array.from({ length: width }, () => 0)
        const rows = Array.from({ length: height }, () => 0)
        for (let y = 0; y < height; y += 1)
          for (let x = 0; x < width; x += 1)
            if (isSheet[y * width + x]) {
              columns[x]! += 1
              rows[y]! += 1
            }
        const across = longestRun(columns, height)
        const down = longestRun(rows, width)
        if (across && down) rect = { x: across.start, y: down.start, width: across.end - across.start + 1, height: down.end - down.start + 1 }
      }
      // Every second pixel each way is plenty for statistics.
      const whole: number[] = []
      const inside: number[] = []
      const outside: number[] = []
      const margin = 4
      for (let y = 0; y < height; y += 2)
        for (let x = 0; x < width; x += 2) {
          const value = luminance[y * width + x]!
          whole.push(value)
          if (!rect) continue
          const within = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
          const nearEdge = x >= rect.x - margin && x < rect.x + rect.width + margin && y >= rect.y - margin && y < rect.y + rect.height + margin
          if (within) inside.push(value)
          else if (!nearEdge) outside.push(value)
        }
      return {
        width,
        height,
        whole: summary(whole),
        sheet: rect,
        sheetMedian: rect ? summary(inside).median : null,
        backdrop: rect ? { ...summary(outside), pixels: outside.length } : null,
      }
    },
    { base64: png.toString('base64'), sheetColour: sheet, knownRect: known, lightPixel: LIGHT_PIXEL },
  )
}

/** What is wrong with `stats` for `dark` in `scheme`; '' when nothing is. */
function verdict(dark: DarkScheme, scheme: 'light' | 'dark', stats: AreaStats, before: AreaStats | null) {
  const n = (value: number | null | undefined) => (value === null || value === undefined ? 'none' : value.toFixed(3))
  if (dark.surface === 'document') {
    if (!before) return ''
    const drift = Math.abs(stats.whole.median - before.whole.median)
    return drift <= DOCUMENT_DRIFT ? '' : `the work area (the document's own colour) changed with the scheme: median ${n(before.whole.median)} -> ${n(stats.whole.median)}`
  }
  if (dark.surface === 'dark') {
    if (scheme === 'dark') {
      if (stats.whole.median > DARK_MAX) return `the work area is light in the dark scheme: median luminance ${n(stats.whole.median)} > ${DARK_MAX}`
      if (stats.whole.lightShare > DARK_AREA_LIGHT_SHARE) return `the work area has a light slab in the dark scheme: ${(stats.whole.lightShare * 100).toFixed(1)}% light pixels > ${DARK_AREA_LIGHT_SHARE * 100}%`
      return ''
    }
    return stats.whole.median >= LIGHT_MIN ? '' : `the work area stayed dark after the switch to light: median luminance ${n(stats.whole.median)} < ${LIGHT_MIN}`
  }
  const total = stats.width * stats.height
  if (!stats.sheet || !stats.backdrop) return `no ${dark.sheet} document surface found in the work area`
  if (stats.sheet.width * stats.sheet.height < total * 0.05) return `the ${dark.sheet} document surface found is too small to be the document: ${JSON.stringify(stats.sheet)}`
  if (stats.backdrop.pixels < 200) return `no backdrop around the document surface to measure: ${JSON.stringify(stats.sheet)} in ${stats.width}x${stats.height}`
  if (scheme === 'dark') {
    if (stats.backdrop.median > DARK_MAX) return `the backdrop around the document is light in the dark scheme: median luminance ${n(stats.backdrop.median)} > ${DARK_MAX}`
    if (stats.backdrop.lightShare > DARK_BACKDROP_LIGHT_SHARE) return `the backdrop around the document has a light band in the dark scheme: ${(stats.backdrop.lightShare * 100).toFixed(1)}% light pixels > ${DARK_BACKDROP_LIGHT_SHARE * 100}%`
    return ''
  }
  return stats.backdrop.median >= LIGHT_MIN ? '' : `the backdrop stayed dark after the switch to light: median luminance ${n(stats.backdrop.median)} < ${LIGHT_MIN}`
}

/** The relative luminance of the kit's top bar's background, as its page computes it. */
function chromeLuminance(kit: FrameLocator) {
  return kit
    .locator('.kui-frame-top')
    .first()
    .evaluate((element) => {
      // The first opaque background from the bar up.
      let node: Element | null = element
      let colour = 'rgb(255, 255, 255)'
      while (node) {
        const background = getComputedStyle(node).backgroundColor
        const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(background)
        if (!alpha || Number(alpha[1]) > 0.5) {
          colour = background
          break
        }
        node = node.parentElement
      }
      const [r, g, b] = (colour.match(/[\d.]+/g) ?? ['255', '255', '255']).slice(0, 3).map((value) => {
        const c = Number(value) / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    })
}

/**
 * Kition starts in the dark scheme, as a person who chose Dark in Display settings sees it on the
 * next start: the settings Kition reads at start ask for dark while the system stays light, so a kit
 * that turns dark does so because Kition told it to, not because it read the system's preference.
 */
export async function startHostInDark(page: Page) {
  await page.addInitScript(() => {
    if (window.top !== window) return
    window.localStorage.setItem('kition.desktop.theme.bootstrap.v1', 'dark')
    window.localStorage.setItem('kition.desktop.settings.backup.v1', JSON.stringify({ general: { theme: 'dark' } }))
  })
}

/** Switches Kition's scheme live, as the Display settings' theme control does. */
async function switchHostScheme(page: Page, scheme: 'light' | 'dark') {
  await page.evaluate(async (wanted) => {
    const settingsPath = '/src/services/desktopSettings.ts'
    const { applyDesktopAppearance } = await import(/* @vite-ignore */ settingsPath)
    applyDesktopAppearance(wanted)
  }, scheme)
}

/**
 * Row H16, after the kit opened its file with Kition in the dark scheme (`startHostInDark`) and
 * showed it: the kit's page and its top bar are dark, its work area is what `dark` expects, and a
 * live switch to light (no reload) reaches the work area too. Screenshots of the work area in each
 * scheme go to `<output>/shots/<kit>-dark.png` and `-light.png`.
 */
export async function darkSchemeRow(page: Page, kit: FrameLocator, id: string, dark: DarkScheme) {
  const shots = path.join(test.info().project.outputDir, 'shots')
  await fs.mkdir(shots, { recursive: true })
  const area = dark.area(kit)
  await expect(area).toBeVisible({ timeout: 30_000 })
  // A screenshot shows what is on screen: Kition's own Opening cover (dark too) must be gone first.
  await expect(page.getByTestId('kit-opening')).toHaveCount(0, { timeout: 30_000 })
  const measure = async (scheme: 'light' | 'dark', known: Rect | null, before: AreaStats | null) => {
    let last: { stats: AreaStats; problem: string } | null = null
    // The kit redraws after the scheme reaches it: measure until the verdict holds or time runs out.
    await expect
      .poll(
        async () => {
          const stats = await measureArea(page, await area.screenshot({ animations: 'disabled' }), dark.sheet, known)
          last = { stats, problem: verdict(dark, scheme, stats, before) }
          return last.problem
        },
        { timeout: 10_000, intervals: [500, 1_000] },
      )
      .toBe('')
      .catch(() => undefined)
    await area.screenshot({ path: path.join(shots, `${id}-${scheme}.png`), animations: 'disabled' })
    await page.screenshot({ path: path.join(shots, `${id}-${scheme}-page.png`) })
    const result = last!
    await test.info().attach(`${id}-${scheme}-stats`, { body: JSON.stringify(result.stats, null, 2), contentType: 'application/json' })
    return result
  }

  // Dark: Kition, the kit's page and its top bar.
  await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
  await expect(kit.locator('html')).toHaveAttribute('data-color-scheme', 'dark', { timeout: 15_000 })
  await expect.poll(() => chromeLuminance(kit), { message: `the ${id} kit's top bar is dark`, timeout: 10_000 }).toBeLessThanOrEqual(DARK_MAX)
  const inDark = await measure('dark', null, null)
  const darkProblem = inDark.problem

  // A live switch to light reaches the kit and its work area.
  await switchHostScheme(page, 'light')
  await expect(kit.locator('html')).toHaveAttribute('data-color-scheme', 'light', { timeout: 15_000 })
  await expect.poll(() => chromeLuminance(kit), { message: `the ${id} kit's top bar is light after the switch`, timeout: 10_000 }).toBeGreaterThanOrEqual(LIGHT_MIN)
  const inLight = await measure('light', inDark.stats.sheet, inDark.stats)

  expect.soft(darkProblem, `${id} in the dark scheme (shots/${id}-dark.png)`).toBe('')
  expect(inLight.problem, `${id} after a live switch to light (shots/${id}-light.png)`).toBe('')
}
