import fs from 'node:fs/promises'
import path from 'node:path'

import { expect, test } from '@playwright/test'

import { installDesktopHost } from './helpers/desktopHost'

const EXPECTED_FIRST_RUN_FILES = [
  'Getting Started/Welcome to Kition.md',
  'Getting Started/logo.png',
  'Getting Started/Projects & Planning/Task Tracker.ktable',
  'Getting Started/AI & Creative/Receipt OCR Table.ktable',
  'Getting Started/Operations & Analytics/Email Inbox Sync.ktable',
  'Getting Started/Sales & Customer/Simple Client CRM.ktable',
]

test('the desktop renderer loads onboarding and brand assets from its own origin', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  const host = await installDesktopHost(page)
  try {
    await page.goto(baseURL!, { waitUntil: 'domcontentloaded' })
    const result = await page.evaluate(async () => {
      const manifestResponse = await fetch('/onboarding/manifest.json')
      const manifest = await manifestResponse.json() as {
        version?: number
        welcome?: { asset?: string }
        images?: Array<{ asset?: string }>
        tables?: Array<{ asset?: string }>
      }
      const guideManifestResponse = await fetch('/onboarding/guides.json')
      const guideManifest = await guideManifestResponse.json() as {
        guides?: Array<{ slug?: string; intro?: string; tableFile?: string | null; seeds?: string[]; assets?: string[] }>
      }
      const onboardingAssetPaths = [
        manifest.welcome?.asset,
        ...(manifest.images || []).map((item) => item.asset),
        ...(manifest.tables || []).map((item) => item.asset),
        ...(guideManifest.guides || []).flatMap((guide) => [
          guide.slug && guide.intro ? `${guide.slug}/${guide.intro}` : '',
          guide.slug && guide.tableFile ? `${guide.slug}/${guide.tableFile}` : '',
          ...(guide.seeds || []).map((filename) => `${guide.slug}/seeds/${filename}`),
          ...(guide.assets || []).map((filename) => `${guide.slug}/assets/${filename}`),
        ]),
      ].filter((assetPath): assetPath is string => Boolean(assetPath))
      const onboardingAssetResults = await Promise.all(onboardingAssetPaths.map(async (assetPath) => {
        const response = await fetch(`/onboarding/${assetPath}`)
        await response.arrayBuffer()
        return { assetPath, ok: response.ok, status: response.status }
      }))
      const templateManifestResponse = await fetch('/templates/receipt-ocr-database/manifest.json')
      const templateManifest = await templateManifestResponse.json() as { assets?: Array<{ path?: string }> }
      const firstTemplateAsset = String(templateManifest.assets?.[0]?.path || '').replace(/^kition-bundled:\/?/, '/')
      const loadedImages = await Promise.all([
        '/logo-mark.png',
        '/templates/document-covers/flowchart.webp',
        '/templates/table-covers/receipt-ocr-database.webp',
        firstTemplateAsset,
      ].map((source) => new Promise<boolean>((resolve) => {
        const image = new Image()
        image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0)
        image.onerror = () => resolve(false)
        image.src = source
      })))
      return {
        loadedImages,
        onboardingAssetResults,
        guideManifestOK: guideManifestResponse.ok,
        manifestOK: manifestResponse.ok,
        manifestVersion: manifest.version,
        templateManifestOK: templateManifestResponse.ok,
      }
    })

    expect(result.loadedImages).toEqual([true, true, true, true])
    expect(result.onboardingAssetResults).toEqual(
      result.onboardingAssetResults.map((asset) => ({ ...asset, ok: true, status: 200 })),
    )
    expect(result.guideManifestOK).toBe(true)
    expect(result.manifestOK).toBe(true)
    expect(result.manifestVersion).toBeGreaterThan(0)
    expect(result.templateManifestOK).toBe(true)
  } finally {
    await host.dispose()
  }
})

test('first-run seeding writes the Getting Started files into the desktop workspace', async ({ page, baseURL }) => {
  test.setTimeout(60_000)
  const host = await installDesktopHost(page)
  try {
    await page.goto(new URL('/documents', baseURL!).toString(), { waitUntil: 'domcontentloaded' })
    await expect.poll(async () => Promise.all(EXPECTED_FIRST_RUN_FILES.map(async (relativePath) => {
      try {
        await fs.access(path.join(host.root, relativePath))
        return true
      } catch {
        return false
      }
    })), { timeout: 30_000 }).toEqual(EXPECTED_FIRST_RUN_FILES.map(() => true))
    await expect(page.getByText(/Couldn't set up your Getting Started files/)).toHaveCount(0)
  } finally {
    await host.dispose()
  }
})
