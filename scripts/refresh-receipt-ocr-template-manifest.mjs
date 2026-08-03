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

function readWebPDimensions(bytes) {
  if (
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
    || bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    throw new Error('Receipt template assets must be WebP files')
  }
  const chunkType = bytes.subarray(12, 16).toString('ascii')
  if (chunkType === 'VP8 ') {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunkType === 'VP8L') {
    const bits = bytes.readUInt32LE(21)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    }
  }
  if (chunkType === 'VP8X') {
    const readUint24LE = (offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
    return {
      width: readUint24LE(24) + 1,
      height: readUint24LE(27) + 1,
    }
  }
  throw new Error(`Unsupported WebP chunk: ${chunkType}`)
}

const assets = sourceNames.map((sourceName, index) => {
  const recordNumber = index + 1
  const recordFolder = `record-${String(recordNumber).padStart(2, '0')}`
  const relativePath = `records/${recordFolder}/receipt.webp`
  const bytes = readFileSync(path.join(templateRoot, relativePath))
  const dimensions = readWebPDimensions(bytes)
  return {
    id: `${recordFolder}-receipt-image`,
    record: recordNumber,
    field: 'Receipt Image',
    sourceName: sourceName.replace(/\.[^.]+$/, '.webp'),
    mimeType: 'image/webp',
    sizeBytes: bytes.byteLength,
    ...dimensions,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    path: `kition-bundled:/templates/receipt-ocr-database/${relativePath}`,
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
