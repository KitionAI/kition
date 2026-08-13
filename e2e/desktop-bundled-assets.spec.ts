import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { _electron as electron, expect, test } from '@playwright/test'
import electronPath from 'electron'

const EXPECTED_FIRST_RUN_FILES = [
  'Getting Started/Welcome to Kition.md',
  'Getting Started/logo.png',
  'Getting Started/Projects & Planning/Task Tracker.kitable',
  'Getting Started/AI & Creative/Receipt OCR Table.kitable',
  'Getting Started/Operations & Analytics/Email Inbox Sync.kitable',
  'Getting Started/Sales & Customer/Simple Client CRM.kitable',
]

test('packaged renderer can load onboarding and brand assets', async () => {
  test.setTimeout(60_000)
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-bundled-assets-e2e-'))
  const packagedExecutable = String(process.env.KITION_PACKAGED_APP_EXECUTABLE || '').trim()
  const app = await electron.launch({
    executablePath: packagedExecutable || electronPath,
    cwd: process.cwd(),
    args: packagedExecutable ? [`--user-data-dir=${path.join(tempHome, 'userData')}`] : ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      KITION_DESKTOP_API_PORT: '48124',
      KITION_DESKTOP_SKIP_API: packagedExecutable ? 'false' : 'true',
      KITION_ELECTRON_TEST_DATA_DIR: tempHome,
      KITION_ELECTRON_DEV_SERVER_URL: '',
    },
  })

  try {
    const page = await app.firstWindow()
    const failedBundledRequests: Array<{ error: string; url: string }> = []
    page.on('requestfailed', (request) => {
      if (!request.url().startsWith('kition-bundled:')) return
      failedBundledRequests.push({
        error: request.failure()?.errorText || 'unknown request failure',
        url: request.url(),
      })
    })
    if (!packagedExecutable) {
      await page.goto(pathToFileURL(path.join(process.cwd(), 'dist', 'index.html')).toString())
    }
    await page.waitForLoadState('domcontentloaded')

    if (packagedExecutable) {
      const desktopInfo = await page.evaluate(() => window.kitionDesktop?.DesktopInfo?.())
      expect(desktopInfo?.workspace_dir).toBeTruthy()
      await expect.poll(async () => Promise.all(EXPECTED_FIRST_RUN_FILES.map(async (relativePath) => {
        try {
          await fs.access(path.join(desktopInfo!.workspace_dir!, relativePath))
          return true
        } catch {
          return false
        }
      })), { timeout: 30_000 }).toEqual(EXPECTED_FIRST_RUN_FILES.map(() => true))
      expect(failedBundledRequests).toEqual([])
    }

    const result = await page.evaluate(async () => {
      const bridgedManifest = await window.kitionDesktop?.ReadBundledAsset?.({
        path: 'onboarding/manifest.json',
      })
      const manifestResponse = await fetch(
        'kition-bundled://assets/onboarding/manifest.json',
      )
      const manifest = await manifestResponse.json() as {
        version?: number
        welcome?: { asset?: string }
        images?: Array<{ asset?: string }>
        tables?: Array<{ asset?: string }>
      }
      const guideManifestResponse = await fetch(
        'kition-bundled://assets/onboarding/guides.json',
      )
      const guideManifest = await guideManifestResponse.json() as {
        guides?: Array<{
          slug?: string
          intro?: string
          tableFile?: string | null
          seeds?: string[]
          assets?: string[]
        }>
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
        try {
          const response = await fetch(`kition-bundled://assets/onboarding/${assetPath}`)
          await response.arrayBuffer()
          return { assetPath, ok: response.ok, status: response.status }
        } catch (error) {
          return { assetPath, error: error instanceof Error ? error.message : String(error), ok: false }
        }
      }))
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
        bridgedManifest,
        loadedImages,
        onboardingAssetResults,
        guideManifestOK: guideManifestResponse.ok,
        manifestOK: manifestResponse.ok,
        manifestVersion: manifest.version,
        templateManifestOK: templateManifestResponse.ok,
      }
    })

    expect(result.loadedImages).toEqual([true, true, true, true])
    expect(result.bridgedManifest?.size_bytes).toBeGreaterThan(0)
    expect(JSON.parse(atob(result.bridgedManifest!.base64_content)).version).toBeGreaterThan(0)
    expect(result.onboardingAssetResults).toEqual(
      result.onboardingAssetResults.map((asset) => ({ ...asset, ok: true, status: 200 })),
    )
    expect(result.guideManifestOK).toBe(true)
    expect(result.manifestOK).toBe(true)
    expect(result.manifestVersion).toBeGreaterThan(0)
    expect(result.templateManifestOK).toBe(true)
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})

test('first-run seeding does not depend on renderer fetch for bundled assets', async ({ baseURL }) => {
  test.setTimeout(60_000)
  expect(baseURL).toBeTruthy()
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'kition-bundled-seed-e2e-'))
  const app = await electron.launch({
    executablePath: electronPath,
    cwd: process.cwd(),
    args: ['.'],
    env: {
      ...process.env,
      HOME: tempHome,
      KITION_DESKTOP_SKIP_API: 'true',
      KITION_ELECTRON_TEST_DATA_DIR: tempHome,
      KITION_ELECTRON_DEV_SERVER_URL: baseURL as string,
    },
  })

  try {
    const page = await app.firstWindow()
    await page.addInitScript(() => {
      const browserFetch = globalThis.fetch.bind(globalThis)
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith('kition-bundled:')) {
          return Promise.reject(new TypeError('Failed to fetch'))
        }
        return browserFetch(input, init)
      }) as typeof fetch
    })
    await page.goto(new URL('/documents', baseURL as string).toString(), {
      waitUntil: 'commit',
    })
    await page.waitForLoadState('domcontentloaded')

    const desktopInfo = await page.evaluate(() => window.kitionDesktop?.DesktopInfo?.())
    expect(desktopInfo?.workspace_dir).toBeTruthy()
    await expect.poll(async () => Promise.all(EXPECTED_FIRST_RUN_FILES.map(async (relativePath) => {
      try {
        await fs.access(path.join(desktopInfo!.workspace_dir!, relativePath))
        return true
      } catch {
        return false
      }
    })), { timeout: 30_000 }).toEqual(EXPECTED_FIRST_RUN_FILES.map(() => true))
    await expect(page.getByText(/Couldn't set up your Getting Started files/)).toHaveCount(0)
  } finally {
    await app.close()
    await fs.rm(tempHome, { recursive: true, force: true })
  }
})
