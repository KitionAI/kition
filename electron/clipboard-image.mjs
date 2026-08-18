const MAX_CLIPBOARD_IMAGE_BYTES = 50 * 1024 * 1024

export function readClipboardImagePayload(systemClipboard) {
  const image = systemClipboard?.readImage?.()
  if (!image || image.isEmpty()) {
    return null
  }

  const png = image.toPNG()
  if (!png?.byteLength) {
    return null
  }
  if (png.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error('clipboard image exceeds 50 MB import limit')
  }

  return {
    mime_type: 'image/png',
    base64_content: Buffer.from(png).toString('base64'),
  }
}
