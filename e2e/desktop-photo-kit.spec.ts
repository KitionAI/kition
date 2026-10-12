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

// These cover the kit-process editors; the in-page engine and the kit's own editor have their own specs.
test.beforeEach(async ({ page }) => {
  await page.route('**/kits/photo-sdk/**', (route) => route.fulfill({ status: 404, body: '' }))
  await page.route('**/kits/photo-ui/kit-ui.json', (route) => route.fulfill({ status: 404, body: '' }))
})

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

test('imports a PSD dropped from the OS onto the tree area', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    await page.route('**/api/v1/kits/documents', (route) => fulfillJson(route, { code: 200, message: 'success', data: photoView({ path: 'Dropped.psd', title: 'Dropped.psd' }) }))
    await page.route('**/api/v1/kits/kit.photo/documents/7', (route) => fulfillJson(route, { code: 200, message: 'success', data: photoView({ path: 'Dropped.psd' }) }))
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    const zone = page.getByTestId('document-tree-drop-zone')
    await expect(zone).toBeVisible()
    const transfer = await page.evaluateHandle(() => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array([0x38, 0x42, 0x50, 0x53])], 'Dropped.psd', { type: 'image/vnd.adobe.photoshop' }))
      return data
    })
    await zone.dispatchEvent('dragover', { dataTransfer: transfer })
    await zone.dispatchEvent('drop', { dataTransfer: transfer })
    await expect(page.locator('.document-tree-row', { hasText: 'Dropped' })).toBeVisible()
    const imported = await fs.readFile(path.join(host.root, 'Dropped.psd'))
    expect(imported.subarray(0, 4).toString()).toBe('8BPS')
    await page.locator('.document-tree-row', { hasText: 'Dropped' }).first().click()
    await expect(page.getByTestId('photo-kit-pane')).toBeVisible()
  } finally {
    await host.dispose()
  }
})

test('creates a new image from the create menu when the Photo kit is installed', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    await page.route('**/api/v1/kits', (route) => fulfillJson(route, { code: 200, message: 'success', data: {
      kits: [{ id: 'kit.photo', name: 'Kition Photo', extensions: ['psd', 'psb', 'pcraft'], creates: ['psd', 'psb', 'pcraft'], installed: true, binaryEnv: 'KITION_KIT_PHOTO_BINARY' }],
    } }))
    const created: unknown[] = []
    await page.route('**/api/v1/kits/documents/new', async (route) => {
      created.push(JSON.parse(route.request().postData() || '{}'))
      // The runtime writes the file through the kit; the mocked host lists it from disk.
      await fs.writeFile(path.join(host.root, 'Untitled image.psd'), Buffer.from('8BPS new'))
      await fulfillJson(route, { code: 200, message: 'success', data: photoView({ path: 'Untitled image.psd', title: 'Untitled image.psd', summary: '1920 x 1080 px, Rgb, 8-bit, 1 layers' }) })
    })
    await page.route('**/api/v1/kits/documents', (route) => fulfillJson(route, { code: 200, message: 'success', data: photoView({ path: 'Untitled image.psd', summary: '1920 x 1080 px, Rgb, 8-bit, 1 layers' }) }))
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await page.getByTestId('workspace-create-image').click()
    await expect(page.getByTestId('photo-kit-pane')).toBeVisible()
    await expect(page.getByTestId('photo-kit-summary')).toHaveText('1920 x 1080 px, Rgb, 8-bit, 1 layers')
    expect(created).toEqual([{ folder: '', extension: 'psd' }])
    await expect(page.locator('.document-tree-row', { hasText: 'Untitled image' })).toBeVisible()
  } finally {
    await host.dispose()
  }
})

test('hides New image when no kit can create images', async ({ page, baseURL }) => {
  const host = await installDesktopHost(page)
  try {
    await mockLocalWorkspaceApi(page)
    await page.route('**/api/v1/kits', (route) => fulfillJson(route, { code: 200, message: 'success', data: { kits: [] } }))
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-private-heading .document-create-menu-anchor > button').click()
    await expect(page.getByTestId('workspace-create-design')).toBeVisible()
    await expect(page.getByTestId('workspace-create-image')).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})

test('draws the Photo editor chrome around the embedded canvas and drives the kit', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(60_000)
  const png = await fs.readFile(path.join(process.cwd(), 'public', 'logo-mark.png'))
  const host = await installDesktopHost(page)
  try {
    await fs.writeFile(path.join(host.root, 'Poster.psd'), Buffer.from('8BPS fixture'))
    await fs.writeFile(path.join(host.root, 'Notes.md'), '# Notes\n')
    await mockLocalWorkspaceApi(page)
    await page.route('**/api/v1/kits', (route) => fulfillJson(route, { code: 200, message: 'success', data: {
      kits: [{ id: 'kit.photo', name: 'Kition Photo', extensions: ['psd'], creates: ['psd'], installed: true, embeddable: true, binaryEnv: 'KITION_KIT_PHOTO_BINARY' }],
    } }))
    const details = {
      width: 96, height: 64, mode: 'Rgb', depth: 8, activeLayer: 3, tool: 'Brush', brushSize: 24, zoom: 2,
      foreground: [0.1, 0.2, 0.8, 1], background: [1, 1, 1, 1],
      layers: [
        { id: 3, name: 'Ink', kind: 'Pixel', visible: true, opacity: 1, blend: 'Normal', selected: true, depth: 0 },
        { id: 2, name: 'Background', kind: 'Pixel', visible: true, opacity: 1, blend: 'Normal', selected: false, depth: 0 },
      ],
    }
    let current = photoView({ documentId: 's1::Poster.psd', details })
    const opened: Array<{ path: string; rect: { x: number; y: number; width: number; height: number } }> = []
    const updates: Array<{ visible?: boolean }> = []
    const executed: Array<{ command: string; params?: Record<string, unknown> }> = []
    await page.route('**/api/v1/kits/surfaces', async (route) => {
      opened.push(JSON.parse(route.request().postData() || '{}'))
      await fulfillJson(route, { code: 200, message: 'success', data: { surfaceId: 1, document: current } })
    })
    await page.route('**/api/v1/kits/surfaces/1', async (route) => {
      if (route.request().method() === 'PUT') updates.push(JSON.parse(route.request().postData() || '{}'))
      await fulfillJson(route, { code: 200, message: 'success', data: {} })
    })
    const base = '**/api/v1/kits/kit.photo/documents/s1%3A%3APoster.psd'
    await page.route(base, (route) => fulfillJson(route, { code: 200, message: 'success', data: current }))
    await page.route(`${base}/preview**`, (route) => route.fulfill({ contentType: 'image/png', body: png }))
    await page.route(`${base}/commands`, async (route) => {
      if (route.request().method() === 'GET') {
        await fulfillJson(route, { code: 200, message: 'success', data: { commands: [
          { id: 'file.new', title: 'New…', description: null, group: 'file', mutates: true, enabled: true, menu: ['File'], shortcut: 'Cmd+N' },
          { id: 'layer.new.layer', title: 'Layer…', description: null, group: 'layer', mutates: true, enabled: true, menu: ['Layer', 'New'], shortcut: 'Cmd+Shift+N' },
          { id: 'filter.blur.gaussianBlur', title: 'Gaussian Blur…', description: null, group: 'filter', mutates: true, enabled: true, menu: ['Filter', 'Blur'], shortcut: null },
        ] } })
        return
      }
      const body = JSON.parse(route.request().postData() || '{}')
      executed.push(body)
      if (body.command === 'ui.set' && body.params?.tool) current = { ...current, details: { ...details, tool: body.params.tool }, version: current.version + 1 }
      await fulfillJson(route, { code: 200, message: 'success', data: { changed: true, result: null, document: current } })
    })
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.locator('.document-tree-row', { hasText: 'Poster' }).first().click()

    const region = page.getByTestId('photo-kit-editor-region')
    await expect(region).toBeVisible()
    await expect.poll(() => opened.length).toBe(1)
    const box = await region.boundingBox()
    expect(Math.abs(opened[0].rect.x - Math.round(box!.x))).toBeLessThanOrEqual(1)
    await expect(page.getByTestId('photo-menu-bar')).toContainText('File')
    await expect(page.getByTestId('photo-menu-bar')).toContainText('Filter')
    await expect(page.getByTestId('photo-tool-Brush')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('photo-options-bar')).toContainText('Brush')
    await expect(page.getByTestId('photo-brush-size')).toHaveValue('24')
    await expect(page.getByTestId('photo-zoom')).toHaveText('200%')
    await expect(page.getByTestId('photo-kit-layers')).toContainText('Ink')
    await expect(page.getByTestId('agent-floating-launcher')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('photo-editor-chrome.png') })

    // A Kition menu cannot draw over the native canvas: the canvas steps aside for it.
    await page.getByTestId('photo-menu-Filter').click()
    await expect.poll(() => updates.some((update) => update.visible === false)).toBe(true)
    await expect(page.getByTestId('photo-canvas-snapshot')).toBeVisible()
    await page.getByRole('menuitem', { name: 'Blur' }).hover()
    await page.getByTestId('photo-menu-command-filter.blur.gaussianBlur').click()
    await expect.poll(() => executed.map((entry) => entry.command)).toContain('filter.blur.gaussianBlur')

    await page.getByTestId('photo-tool-Eraser').click()
    await expect.poll(() => executed.some((entry) => entry.command === 'ui.set' && entry.params?.tool === 'Eraser')).toBe(true)
    await expect(page.getByTestId('photo-tool-Eraser')).toHaveAttribute('aria-pressed', 'true')

    await page.getByTestId('photo-layer-visibility-2').click()
    await expect.poll(() => executed.some((entry) => entry.command === 'layer.setProps' && entry.params?.layer === 2 && entry.params?.visible === false)).toBe(true)

    await page.locator('.document-tree-row', { hasText: 'Notes' }).first().click()
    await expect(page.getByTestId('agent-floating-launcher')).toBeVisible()
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
