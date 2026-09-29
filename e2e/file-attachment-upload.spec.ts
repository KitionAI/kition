import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { KitableTemplateAssetManifest } from '../src/features/table/lib/templateAssets'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

test('uploads file attachments with parseable multipart data', async ({ page }) => {
  const manifestPath = 'templates/youtube-tiktok-thumbnail-generator/manifest.json'
  const manifest = JSON.parse(readFileSync(`public/${manifestPath}`, 'utf8')) as KitableTemplateAssetManifest
  const uploaded: Array<{ name: string; type: string; size: number; sha256: string }> = []
  await mockLocalWorkspaceApi(page)
  await page.route('**/api/v1/data-documents/7/tables/9/attachments', async (route) => {
    const request = route.request()
    try {
      const form = await new Request(request.url(), {
        method: 'POST',
        headers: request.headers(),
        body: Uint8Array.from(request.postDataBuffer()!).buffer,
      }).formData()
      const file = form.get('file')
      if (!file || typeof file === 'string') throw new Error('Missing file')
      const bytes = await file.arrayBuffer()
      uploaded.push({
        name: file.name,
        type: file.type,
        size: file.size,
        sha256: createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
      })
      await route.fulfill({ json: { code: 200, data: {
        name: file.name, mime_type: file.type, size: file.size,
        url: `/uploads/${encodeURIComponent(file.name)}`,
      } } })
    } catch {
      await route.fulfill({ status: 400, json: { message: 'Please choose an attachment to upload' } })
    }
  })
  await page.goto('/')

  const count = await page.evaluate(async (assetPath) => {
    const { uploadDataAttachment } = await import(
      /* @vite-ignore */ ['/src/api', 'dataDocuments.ts'].join('/')
    )
    const { readBundledAssetBytes, bundledAssetArrayBuffer } = await import(
      /* @vite-ignore */ ['/src/lib', 'bundledAssets.ts'].join('/')
    )
    const assets = await (await fetch(`/${assetPath}`)).json()
    for (const asset of assets.assets) {
      const bytes = await readBundledAssetBytes(asset.path)
      await uploadDataAttachment(7, 9, new File([bundledAssetArrayBuffer(bytes)], asset.sourceName, {
        type: asset.mimeType,
      }))
    }
    return assets.assets.length
  }, manifestPath)

  expect(count).toBe(manifest.assetCount)
  expect(uploaded).toHaveLength(manifest.assetCount)
  expect(uploaded).toEqual(expect.arrayContaining(manifest.assets.map((asset) => ({
    name: asset.sourceName, type: asset.mimeType, size: asset.sizeBytes, sha256: asset.sha256,
  }))))
})
