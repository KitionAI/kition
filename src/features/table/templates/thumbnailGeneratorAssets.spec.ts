import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { KitableTemplateAssetManifest } from '@/features/table/lib/templateAssets'
import { readTemplateAssetImageDimensions } from './templateAssetImageDimensions'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const manifestPath = resolve(
  repositoryRoot,
  'public/templates/youtube-tiktok-thumbnail-generator/manifest.json',
)

describe('thumbnail generator assets', () => {
  it('ships every optimized attachment with verified metadata and checksums', () => {
    const rawManifest = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(rawManifest) as KitableTemplateAssetManifest

    expect(rawManifest).not.toContain('X-Amz-')
    expect(manifest.templateId).toBe('thumbnail-generator')
    expect(manifest.source).toBe('Original Kition Cloud AI generation')
    expect(manifest.assetCount).toBe(25)
    expect(manifest.totalSizeBytes).toBe(
      manifest.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
    )
    expect(manifest.totalSizeBytes).toBeLessThan(10_000_000)
    expect(new Set(manifest.assets.map((asset) => asset.id)).size).toBe(25)
    expect(manifest.assets.filter((asset) => asset.field === 'Face Photo')).toHaveLength(5)
    expect(manifest.assets.filter((asset) => asset.field === 'Thumbnail (16:9)')).toHaveLength(10)
    expect(manifest.assets.filter((asset) => asset.field === 'Thumbnail (9:16)')).toHaveLength(10)
    expect(manifest.assets.every((asset) => asset.mimeType === 'image/webp')).toBe(true)
    expect(manifest.assets.every((asset) => asset.path.endsWith('.webp'))).toBe(true)
    expect(manifest.assets.every((asset) => asset.sourceName.endsWith('.webp'))).toBe(true)

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
