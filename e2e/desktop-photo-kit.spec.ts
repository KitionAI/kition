import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Route } from '@playwright/test'
import { installDesktopHost } from './helpers/desktopHost'
import { fulfillJson, mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

type View = Record<string, unknown> & { version: number; dirty: boolean; canUndo: boolean }

function photoView(overrides: Partial<View> = {}): View {
  return {
    kitId: 'kit.photo',
    documentId: '7',
    path: 'Poster.psd',
    title: 'Poster.psd',
    format: 'psd',
    readOnly: false,
    dirty: false,
    canUndo: false,
    canRedo: false,
    version: 1,
    summary: '96 x 64 px, Rgb, 8-bit, 2 layers',
    details: {
      width: 96,
      height: 64,
      mode: 'Rgb',
      depth: 8,
      layers: [
        { name: 'Ink', kind: 'Pixel', visible: true },
        { name: 'Background', kind: 'Pixel', visible: true },
      ],
    },
    ...overrides,
  }
}

test('opens a PSD from the workspace tree in the Photo tab and follows agent edits', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(60_000)
  const png = await fs.readFile(path.join(process.cwd(), 'public', 'logo-mark.png'))
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Poster.psd'), Buffer.from('8BPS fixture'))
    await mockLocalWorkspaceApi(page)
    let current = photoView()
    const opened: string[] = []
    const commands: string[] = []
    await page.route('**/api/v1/kits/documents', async (route: Route) => {
      opened.push(JSON.parse(route.request().postData() || '{}').path)
      await fulfillJson(route, { code: 200, message: 'success', data: current })
    })
    await page.route('**/api/v1/kits/kit.photo/documents/7', (route) => fulfillJson(route, { code: 200, message: 'success', data: current }))
    await page.route('**/api/v1/kits/kit.photo/documents/7/preview**', (route) => route.fulfill({ contentType: 'image/png', body: png }))
    await page.route('**/api/v1/kits/kit.photo/documents/7/commands', async (route) => {
      commands.push(JSON.parse(route.request().postData() || '{}').command)
      current = photoView({ version: current.version + 1, dirty: true, canUndo: false, canRedo: true })
      await fulfillJson(route, { code: 200, message: 'success', data: { changed: true, result: null, document: current } })
    })
    await page.route('**/api/v1/kits/kit.photo/documents/7/save', async (route) => {
      current = photoView({ version: current.version, dirty: false, canRedo: true })
      await fulfillJson(route, { code: 200, message: 'success', data: current })
    })

    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Poster' }).first().click()

    const pane = page.getByTestId('photo-kit-pane')
    await expect(pane).toBeVisible()
    // Dev builds run effects twice; opening the same file again returns the same kit document.
    expect(new Set(opened)).toEqual(new Set(['Poster.psd']))
    await expect(page.getByTestId('photo-kit-summary')).toHaveText('96 x 64 px, Rgb, 8-bit, 2 layers')
    await expect(page.getByTestId('photo-kit-layers')).toContainText('Ink')
    const preview = page.getByTestId('photo-kit-preview')
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)

    // The agent edits the file through its own kit connection; the tab follows the new version.
    current = photoView({ version: 4, dirty: true, canUndo: true, summary: '96 x 64 px, Rgb, 8-bit, 3 layers' })
    await expect(page.getByTestId('photo-kit-unsaved')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('photo-kit-summary')).toHaveText('96 x 64 px, Rgb, 8-bit, 3 layers')
    await expect(preview).toHaveAttribute('src', /v=4/)
    await page.screenshot({ path: testInfo.outputPath('photo-kit-tab.png') })

    await page.getByRole('button', { name: 'Undo' }).click()
    expect(commands).toEqual(['edit.undo'])
    await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('Image saved', { exact: true })).toBeVisible()
    await expect(page.getByTestId('photo-kit-unsaved')).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})

test('explains how to install Photo when the kit is missing', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Cover.psd'), Buffer.from('8BPS fixture'))
    await mockLocalWorkspaceApi(page)
    await page.route('**/api/v1/kits/documents', (route) => fulfillJson(route, {
      code: 40901,
      message: 'Kition Photo is not installed. Set KITION_KIT_PHOTO_BINARY to a kit-photo build and restart Kition.',
      data: { reason: 'not_installed' },
    }, 409))
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Cover' }).first().click()
    const unavailable = page.getByTestId('photo-kit-unavailable')
    await expect(unavailable).toContainText('Photo is not installed')
    await expect(unavailable).toContainText('KITION_KIT_PHOTO_BINARY')
  } finally {
    await host.dispose()
  }
})
