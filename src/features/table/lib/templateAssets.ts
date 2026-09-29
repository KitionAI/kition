import type {
  KitableTemplateAssetReference,
  KitableTemplateRecordValue,
} from '@/features/table/templates/kitableTemplates'
import type { DataAttachment, DataRecordValue } from '@/types/dataDocument'
import { readBundledAssetText } from '@/lib/bundledAssets'

export type KitableTemplateAssetManifestItem = {
  id: string
  record: number
  field: string
  sourceName: string
  mimeType: string
  sizeBytes: number
  width: number
  height: number
  sha256: string
  path: string
}

export type KitableTemplateAssetManifest = {
  templateId: string
  source: string
  assetCount: number
  totalSizeBytes: number
  assets: KitableTemplateAssetManifestItem[]
}

export function isKitableTemplateAssetReference(
  value: unknown,
): value is KitableTemplateAssetReference {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Array.isArray((value as KitableTemplateAssetReference).assetIds),
  )
}

export function collectKitableTemplateAssetIds(
  records: Array<Record<string, KitableTemplateRecordValue>>,
) {
  const ids = new Set<string>()
  for (const record of records) {
    for (const value of Object.values(record)) {
      if (!isKitableTemplateAssetReference(value)) continue
      for (const assetId of value.assetIds) ids.add(assetId)
    }
  }
  return Array.from(ids)
}

export async function loadKitableTemplateAssetManifest(
  manifestPath: string,
): Promise<KitableTemplateAssetManifest> {
  const manifest = JSON.parse(
    await readBundledAssetText(manifestPath),
  ) as KitableTemplateAssetManifest
  if (!Array.isArray(manifest.assets) || manifest.assetCount !== manifest.assets.length) {
    throw new Error(`Template asset manifest is invalid: ${manifestPath}`)
  }
  return manifest
}

export function buildKitableTemplateAttachments({
  manifest,
  assetIds,
}: {
  manifest: KitableTemplateAssetManifest
  assetIds: string[]
}) {
  const manifestAssetById = new Map(manifest.assets.map((asset) => [asset.id, asset]))
  return new Map<string, DataAttachment>(assetIds.map((assetId) => {
    const asset = manifestAssetById.get(assetId)
    if (!asset) throw new Error(`Template asset is missing from the manifest: ${assetId}`)
    // Template images are bundled content, just like the onboarding examples.
    const url = asset.path.startsWith('kition-bundled:')
      ? asset.path
      : `kition-bundled:/${asset.path.replace(/^\/+/, '')}`
    return [assetId, {
      name: asset.sourceName,
      url,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
    }]
  }))
}

export function resolveKitableTemplateRecordValue(
  value: KitableTemplateRecordValue,
  attachmentByAssetId: Map<string, DataAttachment>,
): DataRecordValue {
  if (!isKitableTemplateAssetReference(value)) return value
  return value.assetIds.map((assetId) => {
    const attachment = attachmentByAssetId.get(assetId)
    if (!attachment) throw new Error(`Template asset was not resolved: ${assetId}`)
    return attachment
  })
}
