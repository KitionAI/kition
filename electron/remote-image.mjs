const MAX_IMAGE_BYTES = 50 * 1024 * 1024

function imageMimeFromBytes(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

/** Download pasted image bytes in the desktop process without renderer CORS. */
export async function readRemoteImagePayload(source, fetchImage) {
  const url = new URL(String(source || ''))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('remote image requires an HTTP(S) URL without credentials')
  }
  const response = await fetchImage(url.href, {
    signal: AbortSignal.timeout(15_000),
    referrerPolicy: 'no-referrer',
    credentials: 'omit',
  })
  if (!response.ok) throw new Error(`image download failed: ${response.status}`)
  let mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  const genericBinary = ['', 'application/octet-stream', 'binary/octet-stream'].includes(mimeType)
  if (!mimeType.startsWith('image/') && !genericBinary) {
    await response.body?.cancel()
    throw new Error('remote image response is not an image')
  }
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel()
    throw new Error('remote image exceeds 50 MB import limit')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('remote image response is empty')
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel()
        throw new Error('remote image exceeds 50 MB import limit')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  if (!size) throw new Error('remote image response is empty')
  const bytes = Buffer.concat(chunks)
  if (genericBinary) mimeType = imageMimeFromBytes(bytes)
  if (!mimeType) throw new Error('remote image response is not an image')
  return { mime_type: mimeType, base64_content: bytes.toString('base64') }
}
