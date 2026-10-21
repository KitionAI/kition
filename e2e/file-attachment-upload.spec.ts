import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import type { KitableTemplateAssetManifest } from '../src/features/table/lib/templateAssets'
import { mockLocalWorkspaceApi } from './helpers/mockApi'

test('uploads file attachments with parseable multipart data', async ({ page }) => {
  const manifestPath = 'templates/youtube-tiktok-thumbnail-generator/manifest.json'
  const manifest = JSON.parse(readFileSync(`public/${manifestPath}`, 'utf8')) as KitableTemplateAssetManifest
  const uploaded: Array<{ name: string; type: string; size: number; sha256: string }> = []
  await mockLocalWorkspaceApi(page)
  // The upload goes on to a real local server, which reads the multipart body as sent: WebKit's
  // intercepted requests do not carry a FormData's file contents (postDataBuffer drops them).
  const server = http.createServer((request, response) => {
    response.setHeader('access-control-allow-origin', request.headers.origin ?? '*')
    response.setHeader('access-control-allow-headers', request.headers['access-control-request-headers'] ?? '*')
    response.setHeader('access-control-allow-methods', 'POST, OPTIONS')
    if (request.method === 'OPTIONS') return void response.end()
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', async () => {
      response.setHeader('content-type', 'application/json')
      try {
        const form = await new Request('http://upload.test/', {
          method: 'POST',
          headers: { 'content-type': request.headers['content-type'] ?? '' },
          body: Buffer.concat(chunks),
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
        response.end(JSON.stringify({ code: 200, data: {
          name: file.name, mime_type: file.type, size: file.size,
          url: `/uploads/${encodeURIComponent(file.name)}`,
        } }))
      } catch {
        response.statusCode = 400
        response.end(JSON.stringify({ message: 'Please choose an attachment to upload' }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await page.route('**/api/v1/data-documents/7/tables/9/attachments', (route) =>
    route.continue({ url: `http://127.0.0.1:${port}/attachments` }))
  try {
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
  } finally {
    server.close()
  }
})
