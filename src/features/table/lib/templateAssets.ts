import { uploadDataAttachment } from '@/api/dataDocuments'
import type {
  KitableTemplateAssetReference,
  KitableTemplateRecordValue,
} from '@/features/table/templates/kitableTemplates'
import type { DataAttachment, DataRecordValue } from '@/types/dataDocument'

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
  const response = await fetch(manifestPath)
  if (!response.ok) {
    throw new Error(`Template asset manifest could not be loaded: ${manifestPath}`)
  }
  const manifest = await response.json() as KitableTemplateAssetManifest
  if (!Array.isArray(manifest.assets) || manifest.assetCount !== manifest.assets.length) {
    throw new Error(`Template asset manifest is invalid: ${manifestPath}`)
  }
  return manifest
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
) {
  const queue = [...values]
  const output: Output[] = []
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, values.length || 1)) },
    async () => {
      while (queue.length) {
        const value = queue.shift() as Input
        output.push(await mapper(value))
      }
    },
  )
  await Promise.all(workers)
  return output
}

export async function uploadKitableTemplateAssets({
  documentId,
  tableId,
  manifest,
  assetIds,
}: {
  documentId: number
  tableId: number
  manifest: KitableTemplateAssetManifest
  assetIds: string[]
}) {
  const manifestAssetById = new Map(manifest.assets.map((asset) => [asset.id, asset]))
  const missingAssetId = assetIds.find((assetId) => !manifestAssetById.has(assetId))
  if (missingAssetId) {
    throw new Error(`Template asset is missing from the manifest: ${missingAssetId}`)
  }

  const uploaded = await mapWithConcurrency(assetIds, 4, async (assetId) => {
    const asset = manifestAssetById.get(assetId) as KitableTemplateAssetManifestItem
    const response = await fetch(asset.path)
    if (!response.ok) {
      throw new Error(`Template asset could not be loaded: ${asset.path}`)
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength !== asset.sizeBytes) {
      throw new Error(`Template asset size mismatch: ${asset.path}`)
    }
    const file = new File([bytes], asset.sourceName, { type: asset.mimeType })
    const attachment = await uploadDataAttachment(documentId, tableId, file)
    return [assetId, attachment] as const
  })

  return new Map<string, DataAttachment>(uploaded)
}

export function resolveKitableTemplateRecordValue(
  value: KitableTemplateRecordValue,
  attachmentByAssetId: Map<string, DataAttachment>,
): DataRecordValue {
  if (!isKitableTemplateAssetReference(value)) return value
  return value.assetIds.map((assetId) => {
    const attachment = attachmentByAssetId.get(assetId)
    if (!attachment) throw new Error(`Template asset was not uploaded: ${assetId}`)
    return attachment
  })
}
