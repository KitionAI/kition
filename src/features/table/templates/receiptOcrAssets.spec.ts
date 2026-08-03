import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { KitableTemplateAssetManifest } from '@/features/table/lib/templateAssets'
import { readTemplateAssetImageDimensions } from './templateAssetImageDimensions'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const templateRoot = resolve(repositoryRoot, 'public/templates/receipt-ocr-database')
const manifestPath = resolve(templateRoot, 'manifest.json')

describe('receipt OCR assets', () => {
  it('ships a generated cover and ten optimized receipt images with verified metadata', () => {
    const rawManifest = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(rawManifest) as KitableTemplateAssetManifest
    const coverBytes = readFileSync(resolve(templateRoot, 'cover.webp'))

    expect(rawManifest).not.toContain('X-Amz-')
    expect(manifest.templateId).toBe('receipt-ocr-database')
    expect(manifest.source).toBe('Original Kition Cloud gpt-image-2 generation')
    expect(manifest.assetCount).toBe(10)
    expect(manifest.totalSizeBytes).toBe(
      manifest.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    )
    expect(manifest.totalSizeBytes).toBeLessThan(5_000_000)
    expect(new Set(manifest.assets.map((asset) => asset.id)).size).toBe(10)
    expect(manifest.assets.every((asset) => asset.field === 'Receipt Image')).toBe(true)
    expect(manifest.assets.every((asset) => asset.mimeType === 'image/webp')).toBe(true)
    expect(manifest.assets.every((asset) => asset.path.endsWith('.webp'))).toBe(true)
    expect(manifest.assets.every((asset) => asset.sourceName.endsWith('.webp'))).toBe(true)
    expect(readTemplateAssetImageDimensions(coverBytes)).toEqual({ width: 1672, height: 941 })

    for (const asset of manifest.assets) {
      const filePath = resolve(repositoryRoot, 'public', asset.path.replace(/^kition-bundled:\//, ''))
      const bytes = readFileSync(filePath)
      expect(statSync(filePath).size, asset.id).toBe(asset.sizeBytes)
      expect(createHash('sha256').update(bytes).digest('hex'), asset.id).toBe(asset.sha256)
      expect(readTemplateAssetImageDimensions(bytes), asset.id).toEqual({
        width: asset.width,
        height: asset.height,
      })
    }
  })
})
