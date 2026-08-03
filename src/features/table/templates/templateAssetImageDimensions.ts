export type TemplateAssetImageDimensions = {
  width: number
  height: number
}

function readUint24LE(bytes: Buffer, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function readWebPDimensions(bytes: Buffer): TemplateAssetImageDimensions | null {
  if (
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
    || bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
  ) {
    return null
  }

  let offset = 12
  while (offset + 8 <= bytes.length) {
    const chunkType = bytes.subarray(offset, offset + 4).toString('ascii')
    const chunkSize = bytes.readUInt32LE(offset + 4)
    const payloadOffset = offset + 8

    if (chunkType === 'VP8 ' && payloadOffset + 10 <= bytes.length) {
      return {
        width: bytes.readUInt16LE(payloadOffset + 6) & 0x3fff,
        height: bytes.readUInt16LE(payloadOffset + 8) & 0x3fff,
      }
    }
    if (chunkType === 'VP8L' && payloadOffset + 5 <= bytes.length) {
      const bits = bytes.readUInt32LE(payloadOffset + 1)
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      }
    }
    if (chunkType === 'VP8X' && payloadOffset + 10 <= bytes.length) {
      return {
        width: readUint24LE(bytes, payloadOffset + 4) + 1,
        height: readUint24LE(bytes, payloadOffset + 7) + 1,
      }
    }

    offset = payloadOffset + chunkSize + (chunkSize % 2)
  }
  return null
}

export function readTemplateAssetImageDimensions(
  bytes: Buffer,
): TemplateAssetImageDimensions | null {
  if (bytes.subarray(1, 4).toString('ascii') === 'PNG') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }

  const webPDimensions = readWebPDimensions(bytes)
  if (webPDimensions) return webPDimensions

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
