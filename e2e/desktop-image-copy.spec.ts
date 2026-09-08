import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'
import { mockLocalWorkspaceApi } from './helpers/mockApi'
import { dismissFirstRunActivation } from './helpers/onboarding'

test('copies an opened workspace image from its context menu to the native clipboard', async ({ baseURL }, testInfo) => {
  test.setTimeout(60_000)
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-electron-image-copy-'))
  const imagePath = path.join(process.cwd(), 'public', 'logo-mark.png')
  const imageBytes = await fs.readFile(imagePath)
  const app = await electron.launch({
    executablePath: electronPath, cwd: process.cwd(), args: ['.'],
    env: {
      ...process.env,
      KITION_ELECTRON_DEV_SERVER_URL: baseURL!,
      KITION_DESKTOP_SKIP_API: 'true',
      KITION_ELECTRON_TEST_DATA_DIR: profile,
    },
  })
  try {
    await app.evaluate(async ({ app: desktopApp, clipboard }) => {
      // Native clipboard services are only available after Electron is ready.
      await desktopApp.whenReady()
      const state = globalThis as any
      state.__kitionImageCopyClipboard = {
        text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage(),
      }
      clipboard.writeText('Image copy test marker')
    })
    const page = await app.firstWindow()
    await mockLocalWorkspaceApi(page)
    await page.route('**/workspace-files/Generated%20preview.png', (route) => route.fulfill({
      contentType: 'image/png', body: imageBytes,
    }))
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await dismissFirstRunActivation(page)
    await page.evaluate(async (base64) => {
      await window.kitionDesktop!.ImportWorkspaceFile!({ folder: '', filename: 'Generated preview.png', base64_content: base64 })
    }, imageBytes.toString('base64'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.document-tree-row', { hasText: 'Generated preview' }).first().click()
    const preview = page.locator('.workspace-file-viewer.is-active img')
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    await preview.click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy image', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('image-copy-menu.png') })
    await page.getByRole('menuitem', { name: 'Copy image', exact: true }).click()
    await expect(page.getByText('Image copied', { exact: true })).toBeVisible()
    const copied = await app.evaluate(({ clipboard, nativeImage }, fixturePath) => {
      const image = clipboard.readImage()
      const expected = nativeImage.createFromPath(fixturePath)
      return { empty: image.isEmpty(), samePixels: image.toBitmap().equals(expected.toBitmap()), text: clipboard.readText() }
    }, imagePath)
    expect(copied).toEqual({ empty: false, samePixels: true, text: '' })

    await page.evaluate(() => {
      const target = document.createElement('textarea')
      target.setAttribute('aria-label', 'Clipboard paste target')
      target.style.cssText = 'position:fixed;top:8px;left:8px;z-index:100'
      target.addEventListener('paste', (event) => {
        event.preventDefault()
        target.value = Array.from(event.clipboardData?.files || []).map((file) => file.type).join(',')
      })
      document.body.appendChild(target)
    })
    await page.getByLabel('Clipboard paste target').focus()
    await page.getByLabel('Clipboard paste target').press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+V`)
    await expect(page.getByLabel('Clipboard paste target')).toHaveValue('image/png')
  } finally {
    await app.evaluate(({ clipboard }) => {
      const state = globalThis as any
      if (state.__kitionImageCopyClipboard) clipboard.write(state.__kitionImageCopyClipboard)
      delete state.__kitionImageCopyClipboard
    }).catch(() => {})
    await app.close()
    await fs.rm(profile, { recursive: true, force: true })
  }
})
