import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const templateRoot = path.join(repoRoot, 'public', 'templates', 'receipt-ocr-database')
const sourceNames = [
  'strong flour.png',
  'Receipt_California.png',
  'openai.png',
  'food business center.png',
  'Mcdonalds receipt.png',
  'gas_prices.png',
  'homedepot_receipt3.png',
  'starbucks_receipt.png',
  'shell_gas.png',
  'Arco gasoline.png',
]

function readPngDimensions(bytes) {
  if (bytes.subarray(1, 4).toString('ascii') !== 'PNG') {
    throw new Error('Receipt template assets must be PNG files')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const assets = sourceNames.map((sourceName, index) => {
  const recordNumber = index + 1
  const recordFolder = `record-${String(recordNumber).padStart(2, '0')}`
  const relativePath = `records/${recordFolder}/receipt.png`
  const bytes = readFileSync(path.join(templateRoot, relativePath))
  const dimensions = readPngDimensions(bytes)
  return {
    id: `${recordFolder}-receipt-image`,
    record: recordNumber,
    field: 'Receipt Image',
    sourceName,
    mimeType: 'image/png',
    sizeBytes: bytes.byteLength,
    ...dimensions,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    path: `/templates/receipt-ocr-database/${relativePath}`,
  }
})

const manifest = {
  templateId: 'receipt-ocr-database',
  source: 'Original Kition Cloud gpt-image-2 generation',
  assetCount: assets.length,
  totalSizeBytes: assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
  assets,
}

writeFileSync(path.join(templateRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`[receipt-ocr-manifest] refreshed ${assets.length} assets`)
