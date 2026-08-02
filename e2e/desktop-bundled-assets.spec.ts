import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'

test('packaged renderer can load onboarding and brand assets', async () => {
  test.setTimeout(60_000)
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-bundled-assets-e2e-'))
  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      KITION_DESKTOP_SKIP_API: 'true',
      KITION_ELECTRON_TEST_DATA_DIR: tempHome,
      KITION_ELECTRON_DEV_SERVER_URL: '',
    },
  })

  try {
    const page = await app.firstWindow()
    await page.goto(pathToFileURL(path.join(process.cwd(), 'dist', 'index.html')).toString())
    await page.waitForLoadState('domcontentloaded')

    const result = await page.evaluate(async () => {
      const manifestResponse = await fetch(
        'kition-bundled://assets/onboarding/manifest.json',
      )
      const manifest = await manifestResponse.json() as { version?: number }
      const templateManifestResponse = await fetch(
        'kition-bundled://assets/templates/receipt-ocr-database/manifest.json',
      )
      const templateManifest = await templateManifestResponse.json() as {
        assets?: Array<{ path?: string }>
      }
      const firstTemplateAsset = String(templateManifest.assets?.[0]?.path || '')
        .replace('kition-bundled:/', 'kition-bundled://assets/')
      const loadedImages = await Promise.all([
        'kition-bundled://assets/logo-mark.png',
        'kition-bundled://assets/templates/document-covers/flowchart.webp',
        'kition-bundled://assets/templates/table-covers/receipt-ocr-database.webp',
        firstTemplateAsset,
      ].map((source) => new Promise<boolean>((resolve) => {
        const image = new Image()
        image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0)
        image.onerror = () => resolve(false)
        image.src = source
      })))
      return {
        loadedImages,
        manifestOK: manifestResponse.ok,
        manifestVersion: manifest.version,
        templateManifestOK: templateManifestResponse.ok,
      }
    })

    expect(result.loadedImages).toEqual([true, true, true, true])
    expect(result.manifestOK).toBe(true)
    expect(result.manifestVersion).toBeGreaterThan(0)
    expect(result.templateManifestOK).toBe(true)
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
