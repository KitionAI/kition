import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test, type Page } from '@playwright/test'
import electronPath from 'electron'
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

/** The first page's MediaBox in PDF points. */
function pdfPageSize(bytes: Buffer) {
  const match = bytes.toString('latin1').match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

test('exports a desktop design to PDF at the artboard size and renders both themes', async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000)
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-desktop-studio-'))
  const outputs = { pdf: path.join(profile, 'poster.pdf'), svg: path.join(profile, 'poster.svg') }
  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: {
      ...process.env,
      KITION_ELECTRON_DEV_SERVER_URL: baseURL!,
      KITION_DESKTOP_SKIP_API: 'true',
      KITION_ELECTRON_TEST_DATA_DIR: profile,
    },
  })
  try {
    // Answer save dialogs with a path per extension and keep exports from opening a viewer.
    await app.evaluate(({ dialog, shell }, paths) => {
      const state = globalThis as any
      state.__studioDialog = dialog.showSaveDialog
      state.__studioOpenPath = shell.openPath
      dialog.showSaveDialog = async (_window: unknown, options: { defaultPath?: string }) => {
        const extension = String(options?.defaultPath || '').split('.').pop()
        return { canceled: false, filePath: extension === 'svg' ? paths.svg : paths.pdf }
      }
      shell.openPath = async () => ''
    }, outputs)
    const page = await app.firstWindow()
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
    await page.getByRole('button', { name: 'Download PDF', exact: true }).click()
    await expect.poll(async () => fs.stat(outputs.pdf).then((s) => s.size).catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(1000)
    const pdf = await fs.readFile(outputs.pdf)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const size = pdfPageSize(pdf)
    // 1080 × 1440 CSS pixels print as 810 × 1080 points.
    expect(size).not.toBeNull()
    expect(Math.abs(size!.width - 810)).toBeLessThan(2)
    expect(Math.abs(size!.height - 1080)).toBeLessThan(2)

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
    await app
      .evaluate(({ dialog, shell }) => {
        const state = globalThis as any
        if (state.__studioDialog) dialog.showSaveDialog = state.__studioDialog
        if (state.__studioOpenPath) shell.openPath = state.__studioOpenPath
      })
      .catch(() => {})
    await app.close()
    await fs.rm(profile, { recursive: true, force: true })
  }
})
