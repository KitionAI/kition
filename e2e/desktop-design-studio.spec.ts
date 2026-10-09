import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate(async (value) => {
    const { loadDesktopSettings, saveDesktopSettings } = await import(
      /* @vite-ignore */ ['/src/services', 'desktopSettings.ts'].join('/')
    )
    const settings = await loadDesktopSettings()
    await saveDesktopSettings({ ...settings, general: { ...settings.general, theme: value } })
  }, theme)
}

test('exports a desktop design to PDF at the artboard size and renders both themes', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000)
  const host = await installDesktopHost(page)
  const outputs = { pdf: path.join(host.dataDir, 'poster.pdf'), svg: path.join(host.dataDir, 'poster.svg') }
  try {
    await page.setViewportSize({ width: 1280, height: 800 })
    await mockLocalWorkspaceApi(page)
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await setTheme(page, 'light')
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByTestId('workspace-create-design').click()
    await expect(page.getByTestId('design-editor')).toBeVisible()
    await page.getByRole('button', { name: 'Event', exact: true }).click()
    await expect(page.getByTestId('design-save-status')).toHaveText('Saved')
    await page.locator('.design-artwork text').nth(1).click()
    await page.getByRole('button', { name: 'Adjustments', exact: true }).click()
    await page.getByRole('combobox', { name: 'Font', exact: true }).selectOption('Bricolage Grotesque')
    await expect(page.getByTestId('design-save-status')).toHaveText('Saved')
    await page.screenshot({ path: testInfo.outputPath('studio-light.png') })

    await page.getByLabel('Export', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Download PDF', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('studio-export-menu.png') })
    const longest = (await page
      .getByRole('button', { name: 'Download all sizes (PNG)', exact: true })
      .boundingBox())!
    expect(longest.x + longest.width).toBeLessThanOrEqual(1280)
    host.saveDialogPath = outputs.pdf
    await page.getByRole('button', { name: 'Download PDF', exact: true }).click()
    await expect.poll(async () => fs.stat(outputs.pdf).then((s) => s.size).catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(0)
    // The native shell prints at the artboard size: 1080 × 1440 CSS pixels.
    const pdfRequest = host.calls.find((call) => call.command === 'save_pdf_file')?.args.request
    expect(pdfRequest).toMatchObject({ page_width_px: 1080, page_height_px: 1440 })

    host.saveDialogPath = outputs.svg
    await page.getByLabel('Export', { exact: true }).click()
    await page.getByRole('button', { name: 'Download SVG', exact: true }).click()
    await expect.poll(async () => fs.stat(outputs.svg).then((s) => s.size).catch(() => 0)).toBeGreaterThan(1000)
    const svg = await fs.readFile(outputs.svg, 'utf8')
    expect(svg).toContain('font-family:"Bricolage Grotesque"')
    expect(svg).toContain('>SOMETHING<')

    await setTheme(page, 'dark')
    await page.getByRole('button', { name: 'Artboard size', exact: true }).click()
    await page.getByRole('combobox', { name: 'Add size variant', exact: true }).selectOption('square')
    await expect(page.locator('.design-size-button')).toContainText('1080 × 1080')
    await expect(page.getByRole('combobox', { name: 'Size', exact: true })).toHaveValue('1080x1080')
    await page.screenshot({ path: testInfo.outputPath('studio-dark-variant.png') })
    await page.getByRole('button', { name: 'Layers', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath('studio-dark-layers.png') })
    // Close only after the last edit is on disk so the unsaved-changes guard stays quiet.
    await expect(page.getByTestId('design-save-status')).toHaveText('Saved')
  } finally {
    await host.dispose()
  }
})
