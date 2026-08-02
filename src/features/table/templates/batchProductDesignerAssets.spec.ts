import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { KitableTemplateAssetManifest } from '@/features/table/lib/templateAssets'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const manifestPath = resolve(
  repositoryRoot,
  'public/templates/batch-product-designer/manifest.json',
)

function readImageDimensions(bytes: Buffer) {
  if (bytes.subarray(1, 4).toString('ascii') === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    const segmentLength = bytes.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      }
    }
    offset += 2 + segmentLength
  }
  return null
}

describe('batch product designer assets', () => {
  it('ships every original attachment with verified metadata and checksums', () => {
    const rawManifest = readFileSync(manifestPath, 'utf8')
    const manifest = JSON.parse(rawManifest) as KitableTemplateAssetManifest

    expect(rawManifest).not.toContain('X-Amz-')
    expect(manifest.templateId).toBe('batch-product-designer')
    expect(manifest.source).toBe('Original Kition Cloud AI generation')
    expect(manifest.assetCount).toBe(30)
    expect(manifest.totalSizeBytes).toBe(56_391_364)
    expect(new Set(manifest.assets.map((asset) => asset.id)).size).toBe(30)
    expect(manifest.assets.filter((asset) => asset.field === 'Designs')).toHaveLength(10)
    expect(manifest.assets.filter((asset) => asset.field === 'Orthographic views')).toHaveLength(5)
    expect(manifest.assets.filter((asset) => asset.field === 'Feature image')).toHaveLength(5)
    expect(manifest.assets.filter((asset) => asset.field === 'Lifestyle shot')).toHaveLength(5)
    expect(manifest.assets.filter((asset) => asset.field === 'Style board')).toHaveLength(5)

    for (const asset of manifest.assets) {
      const filePath = resolve(repositoryRoot, 'public', asset.path.replace(/^kition-bundled:\//, ''))
      const bytes = readFileSync(filePath)
      expect(statSync(filePath).size, asset.id).toBe(asset.sizeBytes)
      expect(createHash('sha256').update(bytes).digest('hex'), asset.id).toBe(asset.sha256)
      expect(readImageDimensions(bytes), asset.id).toEqual({
        width: asset.width,
        height: asset.height,
      })
    }
  })
})
